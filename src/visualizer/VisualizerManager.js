import { createVisualizer } from './index.js';
import { layoutFor, resolveGeometry, visualizerSettings } from './settings.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
// Lines of an instance's output kept for the log when it exits; GLava reports little else
const OUTPUT_LINES = 20;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function formatGeometry({ x, y, width, height }) {
  return `${width}x${height}+${x}+${y}`;
}

// One visualizer instance per monitor the visualizer section names, above that monitor's wallpaper.
// Stacking relies on order: GLava stacks itself low when its window maps, which lands it directly above
// a wallpaper window that already exists, so an instance always starts after its monitor's wallpaper.
// The daemon calls configure() and sync() once the wallpapers run, sync() after monitor changes,
// restart() after it restarts a crashed wallpaper (whose new window would cover the visualizer),
// reload() on SIGHUP, setEnabled() for `backdrop start/stop --visualizer`, and stop() on shutdown.
// monitors is the daemon's map of monitor name to monitor, kept whether or not wallpapers run. An instance that keeps exiting is given up on until the next
// reload; a bad visualizer section leaves the visualizer off and the wallpaper running.
export class VisualizerManager {
  constructor({
    config, logger, monitors, spawn, kill,
    restartDelay = 1000, stopGrace = 2000, now = Date.now, create = createVisualizer
  }) {
    this.config = config;
    this.logger = logger;
    this.monitors = monitors;
    this.spawn = spawn;
    this.kill = kill;
    this.restartDelay = restartDelay;
    this.stopGrace = stopGrace;
    this.now = now;
    this.create = create;
    this.entries = new Map();
    this.settings = null;
    this.adapter = null;
    this.error = null;
    // Counts configure() calls, so `backdrop visualizer reload` can tell when its reload has happened
    this.generation = 0;
    // true or false from `backdrop start/stop --visualizer`, over visualizer.enabled until the daemon exits
    this.override = null;
    this.prepared = false;
    this.stopping = false;
  }

  async configure() {
    this.generation++;
    try {
      const settings = visualizerSettings(this.config.get().visualizer);
      const adapter = this.create(settings, { runtimeDir: this.config.get().paths.runtime });
      const prepared = this.override ?? settings.enabled;
      if (prepared) await adapter.prepare();
      Object.assign(this, { settings, adapter, prepared, error: null });
    } catch (error) {
      Object.assign(this, { settings: null, adapter: null, prepared: false, error: error.message });
      this.logger.error('Visualizer disabled', { error: error.message });
    }
  }

  // Whether instances should run: switched on, or enabled in the config
  get enabled() {
    return this.override ?? Boolean(this.settings?.enabled);
  }

  // Whether instances can run: enabled, with a section that checked out
  get active() {
    return this.enabled && this.prepared;
  }

  // Root-window geometry for a monitor, or null when no instance belongs there
  wanted(monitor) {
    const layout = this.active && layoutFor({ ...this.settings, enabled: true }, monitor.name);
    return layout ? resolveGeometry(monitor, layout) : null;
  }

  // Turns the visualizer on or off until the daemon exits, whatever visualizer.enabled says
  async setEnabled(on) {
    this.override = on;
    if (!on) {
      await this.stopAll();
      return;
    }
    if (!this.prepared) await this.configure();
    await this.sync();
  }

  // Stops instances whose monitor is gone or moved, then starts the missing ones
  async sync() {
    for (const [name, entry] of [...this.entries]) {
      const monitor = this.monitors.get(name);
      const geometry = monitor && this.wanted(monitor);
      if (geometry && formatGeometry(geometry) === formatGeometry(entry.geometry)) continue;
      this.entries.delete(name);
      await this.stopEntry(entry);
    }
    for (const monitor of [...this.monitors.values()]) {
      if (this.stopping || this.entries.has(monitor.name)) continue;
      const geometry = this.wanted(monitor);
      if (!geometry) continue;
      try {
        this.start(monitor, geometry);
      } catch (error) {
        this.logger.error('Failed to start visualizer', { monitor: monitor.name, error: error.message });
      }
    }
  }

  start(monitor, geometry, restarts = []) {
    const { file, args, env } = this.adapter.command(monitor, geometry);
    const child = this.spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const entry = { monitor, geometry, child, restarts, output: [], failed: false };
    this.entries.set(monitor.name, entry);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', chunk => {
        entry.output.push(...String(chunk).split('\n').filter(Boolean));
        entry.output.splice(0, Math.max(0, entry.output.length - OUTPUT_LINES));
      });
    }
    child.on('error', error => this.logger.error('Failed to launch visualizer', { monitor: monitor.name, file, error: error.message }));
    child.on('exit', (code, signal) => { entry.exited = this.handleExit(entry, code, signal); });
    this.logger.info('Visualizer started', { monitor: monitor.name, module: this.settings.module, geometry: formatGeometry(geometry) });
    return entry;
  }

  // Starts a monitor's instance again so it maps above a wallpaper that was just restarted. Not counted
  // against its restart budget; one given up on stays off until reload.
  async restart(name) {
    const entry = this.entries.get(name);
    if (!entry || entry.failed || this.stopping) return;
    this.entries.delete(name);
    await this.stopEntry(entry);
    if (this.stopping || this.entries.has(name)) return;
    try {
      this.start(entry.monitor, entry.geometry, entry.restarts);
    } catch (error) {
      this.logger.error('Failed to restart visualizer', { monitor: name, error: error.message });
    }
  }

  // After wallpapers were started under running instances, so each maps above its wallpaper again
  async restartAll() {
    for (const name of [...this.entries.keys()]) await this.restart(name);
  }

  async handleExit(entry, code, signal) {
    const { name } = entry.monitor;
    if (this.stopping || this.entries.get(name) !== entry) return;
    const now = this.now();
    entry.restarts = entry.restarts.filter(time => now - time < RESTART_WINDOW_MS);
    const output = entry.output.join('\n') || undefined;
    if (entry.restarts.length >= MAX_RESTARTS) {
      entry.failed = true;
      this.logger.error('Visualizer keeps exiting, giving up on monitor until reload', { monitor: name, code, signal, output });
      return;
    }
    entry.restarts.push(now);
    this.logger.warn('Visualizer exited, restarting', { monitor: name, code, signal, output });
    await sleep(this.restartDelay);
    if (this.stopping || this.entries.get(name) !== entry) return;
    try {
      this.start(entry.monitor, entry.geometry, entry.restarts);
    } catch (error) {
      entry.failed = true;
      this.logger.error('Failed to restart visualizer', { monitor: name, error: error.message });
    }
  }

  // Callers remove the entry from the map first, so its exit is not taken for a crash
  async stopEntry({ child }) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    this.killGroup(child, 'SIGTERM');
    const timedOut = await Promise.race([exited.then(() => false), sleep(this.stopGrace).then(() => true)]);
    if (timedOut) this.killGroup(child, 'SIGKILL');
  }

  killGroup(child, signal) {
    try {
      this.kill(-child.pid, signal);
    } catch {
      // already exited
    }
  }

  async stopAll() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => this.stopEntry(entry)));
  }

  // Re-reads the section (the daemon has already reloaded the config) and starts over
  async reload() {
    await this.stopAll();
    await this.configure();
    await this.sync();
  }

  async stop() {
    this.stopping = true;
    await this.stopAll();
  }

  // For state.json: the instance on a monitor, or null
  describe(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    return {
      engine: this.settings.engine, module: this.settings.module, pid: entry.child.pid,
      running: !entry.failed, geometry: formatGeometry(entry.geometry)
    };
  }

  // For state.json: whether the section enables it, its error, and the reload generation
  summary() {
    return { enabled: this.enabled, error: this.error, generation: this.generation };
  }
}
