import { withX11 } from '../display/x11.js';
import { AudioWatcher } from './audio.js';
import { createVisualizer } from './index.js';
import { layoutFor, resolveGeometry, visualizerSettings } from './settings.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
// Lines of an instance's output kept for the log when it exits; GLava reports little else
const OUTPUT_LINES = 20;
// Polls for an instance's window and the wallpaper's after a start
const WINDOW_ATTEMPTS = 50;
const WINDOW_DELAY_MS = 100;
// GLava lowers itself once its window maps, which can come after the window is found, so placement is
// checked again after this long
const SETTLE_MS = 500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function formatGeometry({ x, y, width, height }) {
  return `${width}x${height}+${x}+${y}`;
}

const entryKey = (monitorName, instanceName) => `${monitorName}\t${instanceName}`;

// The visualizer section's instances on each monitor they name, above that monitor's wallpaper. GLava stacks
// itself at the bottom when its window maps, below the wallpaper, so a monitor's instances are placed once
// their windows exist: each given its opacity and stacked above the wallpaper in the section's order, the
// first lowest, below every other window (place()). The daemon calls configure() and sync() once the
// wallpapers run, sync() after monitor changes, restack() after it starts a wallpaper, reload() on SIGHUP and
// config changes, setEnabled() for `backdrop start/stop --visualizer`, setPreset() for `backdrop visualizer
// preset`, and stop() on shutdown. monitors is the daemon's map of monitor name to monitor, kept whether or not
// wallpapers run; screens maps names to running wallpapers ({ client }, mpv's IPC client). With
// visualizer.only_while_playing an AudioWatcher stops the instances while the audio source is silent. An
// instance that keeps exiting is given up on until the next reload; a bad visualizer section leaves the
// visualizer off and the wallpaper running.
export class VisualizerManager {
  constructor({
    config, logger, monitors, screens = new Map(), spawn, kill, exec, x11 = withX11,
    audioWatcher = options => new AudioWatcher(options),
    restartDelay = 1000, stopGrace = 2000, windowAttempts = WINDOW_ATTEMPTS, windowDelay = WINDOW_DELAY_MS,
    settleDelay = SETTLE_MS, now = Date.now, create = createVisualizer
  }) {
    Object.assign(this, {
      config, logger, monitors, screens, spawn, kill, exec, x11, audioWatcher,
      restartDelay, stopGrace, windowAttempts, windowDelay, settleDelay, now, create
    });
    this.entries = new Map();
    this.adapters = new Map();
    this.settings = null;
    this.error = null;
    // Counts configure() calls, so `backdrop visualizer reload` can tell when its reload has happened
    this.generation = 0;
    // From `backdrop start/stop --visualizer` and `backdrop visualizer preset`, over the config until the
    // daemon exits; undefined preset means visualizer.preset
    this.override = null;
    this.presetOverride = undefined;
    this.prepared = false;
    this.audio = { watcher: null, playing: null };
    // One placement at a time per monitor, so instances starting together stack in order
    this.placing = new Map();
    this.stopping = false;
  }

  async configure() {
    this.generation++;
    try {
      const options = this.presetOverride === undefined ? {} : { preset: this.presetOverride };
      const settings = visualizerSettings(this.config.get().visualizer, options);
      const runtimeDir = this.config.get().paths.runtime;
      const adapters = new Map(settings.instances.map(instance => [instance.name, this.create(settings, instance, { runtimeDir })]));
      const prepared = this.override ?? settings.enabled;
      if (prepared) for (const adapter of adapters.values()) await adapter.prepare();
      Object.assign(this, { settings, adapters, prepared, error: null });
    } catch (error) {
      Object.assign(this, { settings: null, adapters: new Map(), prepared: false, error: error.message });
      this.logger.error('Visualizer disabled', { error: error.message });
    }
    await this.watchAudio();
  }

  // Whether instances should run: switched on, or enabled in the config
  get enabled() {
    return this.override ?? Boolean(this.settings?.enabled);
  }

  // Whether the visualizer is on: enabled, with a section that checked out (silence does not count as off)
  get active() {
    return this.enabled && this.prepared;
  }

  // Stopped because the audio source has been silent past visualizer.silence_grace
  get silenced() {
    return Boolean(this.settings?.onlyWhilePlaying) && this.audio.playing === false;
  }

  // Root-window geometry for an instance on a monitor, or null when it does not run there now
  wanted(instance, monitor) {
    if (!this.active || this.silenced) return null;
    const layout = layoutFor(instance, monitor.name);
    return layout ? resolveGeometry(monitor, layout) : null;
  }

  // Turns the visualizer on or off until the daemon exits, whatever visualizer.enabled says
  async setEnabled(on) {
    this.override = on;
    if (!on) {
      await this.stopAll();
      await this.watchAudio();
      return;
    }
    if (!this.prepared) await this.configure();
    else await this.watchAudio();
    await this.sync();
  }

  // Lays a preset over the section until the daemon exits (null: none, whatever visualizer.preset says)
  async setPreset(name) {
    this.presetOverride = name;
    await this.reload();
  }

  // Watches the audio source while only_while_playing applies, and stops watching otherwise
  async watchAudio() {
    const wanted = Boolean(this.settings?.onlyWhilePlaying) && this.active && !this.stopping;
    const { source, silenceGrace } = this.settings ?? {};
    const current = this.audio.watcher;
    if (current && wanted && current.source === source && current.grace === silenceGrace * 1000) return;
    current?.stop();
    this.audio = { watcher: null, playing: null };
    if (!wanted) return;
    const watcher = this.audioWatcher({
      source, grace: silenceGrace * 1000, spawn: this.spawn, exec: this.exec, logger: this.logger,
      onChange: playing => this.onAudio(watcher, playing)
    });
    this.audio.watcher = watcher;
    this.audio.playing = await watcher.start();
    if (this.audio.playing === false) this.logger.info('Audio is silent, visualizer waits for it');
  }

  async onAudio(watcher, playing) {
    if (this.audio.watcher !== watcher || this.stopping) return;
    this.audio.playing = playing;
    this.logger.info(playing ? 'Audio playing, visualizer starts' : 'Audio silent, visualizer stops');
    try {
      await this.sync();
    } catch (error) {
      this.logger.error('Visualizer failed to follow the audio', { error: error.message });
    }
  }

  // Stops instances whose monitor is gone or moved, or that the settings or silence no longer want, then
  // starts the missing ones in the section's order
  async sync() {
    const instances = this.settings?.instances ?? [];
    for (const [key, entry] of [...this.entries]) {
      const monitor = this.monitors.get(entry.monitor.name);
      const instance = instances.find(item => item.name === entry.instance.name);
      const geometry = monitor && instance && this.wanted(instance, monitor);
      if (geometry && formatGeometry(geometry) === formatGeometry(entry.geometry)) continue;
      this.entries.delete(key);
      await this.stopEntry(entry);
    }
    for (const monitor of [...this.monitors.values()]) {
      for (const instance of instances) {
        if (this.stopping || this.entries.has(entryKey(monitor.name, instance.name))) continue;
        const geometry = this.wanted(instance, monitor);
        if (!geometry) continue;
        try {
          this.start(monitor, instance, geometry);
        } catch (error) {
          this.logger.error('Failed to start visualizer', { monitor: monitor.name, instance: instance.name, error: error.message });
        }
      }
    }
  }

  start(monitor, instance, geometry, restarts = []) {
    const adapter = this.adapters.get(instance.name);
    const { file, args, env } = adapter.command(monitor, geometry);
    const child = this.spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const entry = { key: entryKey(monitor.name, instance.name), monitor, instance, adapter, geometry, child, restarts, output: [], failed: false, window: null };
    this.entries.set(entry.key, entry);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', chunk => {
        entry.output.push(...String(chunk).split('\n').filter(Boolean));
        entry.output.splice(0, Math.max(0, entry.output.length - OUTPUT_LINES));
      });
    }
    child.on('error', error => this.logger.error('Failed to launch visualizer', { monitor: monitor.name, instance: instance.name, file, error: error.message }));
    child.on('exit', (code, signal) => { entry.exited = this.handleExit(entry, code, signal); });
    this.logger.info('Visualizer started', { monitor: monitor.name, instance: instance.name, module: instance.module, geometry: formatGeometry(geometry) });
    // In the background: the window takes a moment to appear
    entry.placed = this.placeMonitor(monitor.name);
    return entry;
  }

  // Running instances of a monitor, in the section's order
  monitorEntries(name) {
    return (this.settings?.instances ?? [])
      .map(instance => this.entries.get(entryKey(name, instance.name)))
      .filter(entry => entry && this.current(entry));
  }

  placeMonitor(name) {
    const previous = this.placing.get(name) ?? Promise.resolve();
    const next = previous.then(() => this.place(name));
    this.placing.set(name, next.catch(() => {}));
    return next;
  }

  // Sets each instance's opacity and stacks the monitor's instances above its wallpaper, first lowest, then
  // checks again once GLava has had time to lower itself. Without a running wallpaper they stay at the bottom,
  // over the bare root window. Resolves to whether they ended up in order (or no wallpaper runs).
  async place(name) {
    const entries = this.monitorEntries(name);
    if (!entries.length) return false;
    try {
      for (const entry of entries) entry.window ??= await this.findWindow(entry.adapter.title(entry.monitor), entry);
      const missing = entries.filter(entry => !entry.window && this.current(entry));
      for (const entry of missing) this.logger.warn('Visualizer window not found, cannot place it', { monitor: name, instance: entry.instance.name });
      const placed = entries.filter(entry => entry.window && this.current(entry));
      if (!placed.length) return false;
      return await this.x11(async x => {
        for (const entry of placed) await x.setOpacity(entry.window, entry.instance.opacity);
        const wallpaper = await this.wallpaperWindow(name, x);
        if (!wallpaper) return !missing.length;
        const stack = async () => {
          let sibling = wallpaper;
          for (const entry of placed) {
            await x.stackAbove(entry.window, sibling);
            sibling = entry.window;
          }
        };
        await stack();
        await sleep(this.settleDelay);
        let sibling = wallpaper;
        for (const entry of placed) {
          if (!this.current(entry)) return false;
          if (!await x.isAbove(entry.window, sibling)) {
            await stack();
            break;
          }
          sibling = entry.window;
        }
        return !missing.length;
      });
    } catch (error) {
      this.logger.warn('Failed to place the visualizer above the wallpaper', { monitor: name, error: error.message });
      return false;
    }
  }

  // After the daemon starts a wallpaper. xwinwrap lowers itself, which already leaves the instances above it;
  // placing again keeps that true whatever order the windows mapped in.
  restack(name) {
    if (!this.monitorEntries(name).length) return Promise.resolve(false);
    return this.placeMonitor(name);
  }

  restackAll() {
    const names = new Set([...this.entries.values()].map(entry => entry.monitor.name));
    return Promise.all([...names].map(name => this.restack(name)));
  }

  // Whether entry is still a running instance
  current(entry) {
    return !this.stopping && this.entries.get(entry.key) === entry && !entry.failed
      && entry.child.exitCode === null && entry.child.signalCode === null;
  }

  async findWindow(title, entry) {
    const pattern = `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    for (let attempt = 0; attempt < this.windowAttempts && this.current(entry); attempt++) {
      try {
        const id = (await this.exec('xdotool', ['search', '--name', pattern])).trim().split('\n')[0];
        if (id) return Number(id);
      } catch {
        // xdotool exits 1 until the window exists
      }
      await sleep(this.windowDelay);
    }
    return null;
  }

  // The wallpaper's top-level window on a monitor (xwinwrap's, holding mpv's), or null without a wallpaper
  async wallpaperWindow(name, x) {
    for (let attempt = 0; attempt < this.windowAttempts; attempt++) {
      const client = this.screens.get(name)?.client;
      if (!client) return null;
      const id = await client.getProperty('window-id').catch(() => null);
      if (id) return x.topLevel(id);
      await sleep(this.windowDelay);
    }
    return null;
  }

  async handleExit(entry, code, signal) {
    const { name } = entry.monitor;
    const instance = entry.instance.name;
    if (this.stopping || this.entries.get(entry.key) !== entry) return;
    const now = this.now();
    entry.restarts = entry.restarts.filter(time => now - time < RESTART_WINDOW_MS);
    const output = entry.output.join('\n') || undefined;
    if (entry.restarts.length >= MAX_RESTARTS) {
      entry.failed = true;
      this.logger.error('Visualizer keeps exiting, giving up on it until reload', { monitor: name, instance, code, signal, output });
      return;
    }
    entry.restarts.push(now);
    this.logger.warn('Visualizer exited, restarting', { monitor: name, instance, code, signal, output });
    await sleep(this.restartDelay);
    if (this.stopping || this.entries.get(entry.key) !== entry) return;
    try {
      this.start(entry.monitor, entry.instance, entry.geometry, entry.restarts);
    } catch (error) {
      entry.failed = true;
      this.logger.error('Failed to restart visualizer', { monitor: name, instance, error: error.message });
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

  // Re-reads the section (the daemon has already reloaded the config) and starts over; a preset or on/off
  // switched from the command line stays
  async reload() {
    await this.stopAll();
    await this.configure();
    await this.sync();
  }

  async stop() {
    this.stopping = true;
    this.audio.watcher?.stop();
    await this.stopAll();
  }

  // For state.json: the instances on a monitor, in the section's order
  describe(name) {
    return (this.settings?.instances ?? []).flatMap(instance => {
      const entry = this.entries.get(entryKey(name, instance.name));
      if (!entry) return [];
      return [{
        instance: instance.name, engine: this.settings.engine, module: instance.module, pid: entry.child.pid,
        running: !entry.failed, geometry: formatGeometry(entry.geometry)
      }];
    });
  }

  // For state.json: whether the section enables it, its error, preset and instances, whether it waits for
  // sound, and the reload generation
  summary() {
    return {
      enabled: this.enabled, error: this.error, generation: this.generation,
      preset: this.settings?.preset ?? null, presets: this.settings?.presets ?? [],
      instances: (this.settings?.instances ?? []).map(instance => instance.name),
      silenced: this.silenced
    };
  }
}
