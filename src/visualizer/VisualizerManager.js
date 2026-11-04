import { withX11 } from '../display/x11.js';
import { AudioWatcher } from './audio.js';
import { createVisualizer } from './index.js';
import { SleevedWatcher } from './sleeved.js';
import { deepMerge, layoutFor, resolveGeometry, visualizerSettings } from './settings.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
// Lines of an instance's output kept for the log when it exits; GLava reports little else
const OUTPUT_LINES = 20;
// Polls for an instance's window and the wallpaper's after a start
const WINDOW_ATTEMPTS = 50;
const WINDOW_DELAY_MS = 100;
const SLEEVE_WINDOW_FACTOR = 3;
// sleeve exits with this for a bad option, a shell not installed or a blocked sandbox: no use retrying
const SLEEVE_NO_RETRY = 2;
// GLava lowers itself once its window maps, which can come after the window is found, so placement is
// checked again after this long
const SETTLE_MS = 500;
// GLava takes one line from stdin per read and drops the rest of what arrived together, so piped colors are
// written one line at a time this far apart (several frames)
const PIPE_GAP_MS = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function formatGeometry({ x, y, width, height }) {
  return `${width}x${height}+${x}+${y}`;
}

// Whether a window's center lies on the monitor, so a window spanning two monitors belongs to one
export function onMonitor(geometry, monitor) {
  const cx = geometry.x + geometry.width / 2;
  const cy = geometry.y + geometry.height / 2;
  return cx >= monitor.x && cx < monitor.x + monitor.width && cy >= monitor.y && cy < monitor.y + monitor.height;
}

// What sleeve can change on a running page; an option set at its start and now unset cannot be, since a
// reset goes back to the start options
const SLEEVE_LOOK = ['now', 'nowPosition', 'lyricsAlign', 'lyricsArea', 'nowArea', 'background'];
const changedLook = (from, to) => SLEEVE_LOOK.some(key => from?.[key] !== to?.[key]);
const lostStartOption = (started, next) => SLEEVE_LOOK.some(key => started?.[key] && !next?.[key]);

const entryKey = (monitorName, instanceName) => `${monitorName}\t${instanceName}`;

// What GLava reads when it starts, so a change to it needs a restart. Left out: each instance's opacity (a
// window property), how colors are picked from the wallpaper (palette.pick and min_contrast, sent over the
// pipe) and wallpaper_dim, which running instances take as they are, and the preset names.
function startSettings(settings) {
  const { preset, presets, instances, wallpaperDim, ...shared } = settings;
  return JSON.stringify({
    ...shared,
    // sleeve takes its look over `sleeve ctl display` (changedLook)
    instances: instances.map(({ opacity, palette, sleeve, ...rest }) => ({
      ...rest, palette: { source: palette.source },
      ...(sleeve ? { sleeve: { command: sleeve.command, noSandbox: sleeve.noSandbox, mapBelow: sleeve.mapBelow } } : {})
    }))
  });
}

// The visualizer section's instances on each monitor they name, above that monitor's wallpaper. GLava stacks
// itself at the bottom when its window maps, below the wallpaper, so a monitor's instances are placed once
// their windows exist: each given its opacity and stacked above the wallpaper in the section's order, the
// first lowest, below every other window (place()). The daemon calls configure() and sync() once the
// wallpapers run, sync() after monitor changes, restack() after it starts a wallpaper, reload() on SIGHUP and
// config changes, setEnabled() for `backdrop start/stop --visualizer`, setPreset() for `backdrop visualizer
// preset`, and stop() on shutdown. monitors is the daemon's map of monitor name to monitor, kept whether or not
// wallpapers run; screens maps names to running wallpapers ({ client }, mpv's IPC client). With
// visualizer.only_while_playing an AudioWatcher stops the instances while the audio source is silent; with
// visualizer.wallpaper_dim it tells the daemon (onMusicDim) how far to dim the wallpaper while it plays. An
// instance that keeps exiting is given up on until the next reload; a bad visualizer section leaves the
// visualizer off and the wallpaper running.
export class VisualizerManager {
  constructor({
    config, logger, monitors, screens = new Map(), spawn, kill, exec, x11 = withX11,
    audioWatcher = options => new AudioWatcher(options),
    restartDelay = 1000, stopGrace = 2000, windowAttempts = WINDOW_ATTEMPTS, windowDelay = WINDOW_DELAY_MS,
    settleDelay = SETTLE_MS, now = Date.now, create = createVisualizer,
    colorsFor = () => null, pipeGap = PIPE_GAP_MS, onMusicDim = () => {}, onOverlays = () => {},
    sleevedWatcher = options => new SleevedWatcher(options)
  }) {
    Object.assign(this, {
      config, logger, monitors, screens, spawn, kill, exec, x11, audioWatcher,
      restartDelay, stopGrace, windowAttempts, windowDelay, settleDelay, now, create, colorsFor, pipeGap, onMusicDim, onOverlays, sleevedWatcher
    });
    // Windows marked _BACKDROP_OVERLAY by other programs, by monitor, as found at its last placement
    this.overlays = new Map();
    // The music dim last reported to onMusicDim
    this.reportedDim = 0;
    this.entries = new Map();
    this.adapters = new Map();
    this.settings = null;
    this.error = null;
    // Counts configure() calls, so `backdrop visualizer reload` can tell when its reload has happened
    this.generation = 0;
    // From `backdrop start/stop --visualizer` and `backdrop visualizer preset`, over the config until the
    // daemon exits; undefined preset means visualizer.preset
    this.override = null;
    // Everything is off for the system load (daemon/LoadShedding.js); apart from whether it is enabled
    this.suspended = false;
    this.presetOverride = undefined;
    // Changes from the visualizer menu by instance name, over the preset until the daemon exits or a reset
    this.live = {};
    this.prepared = false;
    this.audio = { watcher: null, playing: null };
    // One placement at a time per monitor, so instances starting together stack in order
    this.placing = new Map();
    this.stopping = false;
    // Whether a compositor runs, from the last placement; null until checked. Without one the transparency
    // around the visualizer shows black.
    this.compositor = null;
  }

  async configure() {
    this.generation++;
    try {
      const settings = visualizerSettings(this.config.get().visualizer, this.settingsOptions());
      const runtimeDir = this.config.get().paths.runtime;
      const adapters = new Map(settings.instances.map(instance => [instance.name, this.create(settings, instance, { runtimeDir, exec: this.exec })]));
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

  // How far to dim the wallpaper (0-100) while the visualizer is on and its audio source plays, else 0
  get musicDim() {
    const dim = this.settings?.wallpaperDim ?? 0;
    return dim && this.active && !this.stopping && this.audio.playing === true ? dim : 0;
  }

  // Tells the daemon when musicDim changed
  noteMusicDim() {
    const dim = this.musicDim;
    if (dim === this.reportedDim) return;
    this.reportedDim = dim;
    this.logger.info(dim ? 'Music playing, wallpaper dimmed' : 'Wallpaper dim restored', { dim });
    const failed = error => this.logger.error('Failed to dim the wallpaper for music', { error: error.message });
    try {
      Promise.resolve(this.onMusicDim(dim)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  // Root-window geometry for an instance on a monitor, or null when it does not run there now
  wanted(instance, monitor) {
    // sleeve hides for silence rather than stopping, since a start takes about 2 s
    if (!this.active || this.suspended || (this.silenced && instance.engine !== 'sleeve')) return null;
    const layout = layoutFor(instance, monitor.name);
    return layout ? resolveGeometry(monitor, layout) : null;
  }

  // Stops the instances while the system load is high and starts them again after
  async setSuspended(on) {
    this.suspended = on;
    await this.sync();
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

  // Lays the visualizer menu's changes for one instance over the others it made ({ instance, changes }), or
  // drops them all (null). A change that does not check out is refused and leaves the visualizer as it was.
  // reload: false only records the change, for a caller that reloads next (a preset switch)
  // Opacity and the wallpaper color pick apply to the running instances; any other change restarts them.
  async setLive(change, { reload = true } = {}) {
    const live = change ? { ...this.live, [change.instance]: deepMerge(this.live[change.instance] ?? {}, change.changes) } : {};
    const next = visualizerSettings(this.config.get().visualizer, this.settingsOptions(live));
    this.live = live;
    if (!reload) return;
    if (this.runsWith(next)) await this.takeLive(next);
    else await this.reload();
  }

  // The options for visualizerSettings: the menu's changes and a preset switched from the command line
  settingsOptions(live = this.live) {
    return { live, ...(this.presetOverride === undefined ? {} : { preset: this.presetOverride }) };
  }

  // Whether the running instances can take these settings without a restart
  runsWith(next) {
    if (!(this.prepared && this.enabled && this.settings) || startSettings(this.settings) !== startSettings(next)) return false;
    return [...this.entries.values()].every(entry => !lostStartOption(entry.startedLook, next.instances.find(item => item.name === entry.instance.name)?.sleeve));
  }

  // Takes settings that differ only in what applies live: each running instance gets its new opacity and its
  // colors picked again
  async takeLive(next) {
    this.settings = next;
    const changed = new Set();
    for (const entry of this.entries.values()) {
      const instance = next.instances.find(item => item.name === entry.instance.name);
      if (!instance) continue;
      if (instance.opacity !== entry.instance.opacity) changed.add(entry);
      if (instance.sleeve && changedLook(entry.instance.sleeve, instance.sleeve)) this.display(entry, { look: instance.sleeve });
      entry.instance = instance;
      entry.adapter.instance = instance;
    }
    const withWindow = [...changed].filter(entry => entry.window);
    if (withWindow.length) {
      try {
        await this.x11(async x => {
          for (const entry of withWindow) await x.setOpacity(entry.window, entry.instance.opacity);
        });
      } catch (error) {
        this.logger.warn('Failed to set visualizer opacity', { error: error.message });
      }
    }
    await Promise.all([...this.monitors.keys()].map(name => this.recolor(name)));
    // wallpaper_dim may have turned the audio watch on or off, or changed the dim
    await this.watchAudio();
  }

  // After a saved change to the config file: takes it like a menu change when the running instances can,
  // else reloads
  async refresh() {
    let next = null;
    try {
      next = visualizerSettings(this.config.get().visualizer, this.settingsOptions());
    } catch {
      // The reload reports it and turns the visualizer off
    }
    if (next && this.runsWith(next)) {
      this.generation++;
      await this.takeLive(next);
      return;
    }
    await this.reload();
  }

  // Lays a preset over the section until the daemon exits (null: none, whatever visualizer.preset says)
  async setPreset(name) {
    this.presetOverride = name;
    await this.reload();
  }

  // Watches the audio source while only_while_playing or wallpaper_dim applies, and stops watching otherwise
  async watchAudio() {
    const wanted = Boolean(this.settings?.onlyWhilePlaying || this.settings?.wallpaperDim) && this.active && !this.stopping;
    const { source, silenceGrace } = this.settings ?? {};
    const current = this.audio.watcher;
    if (current && wanted && current.source === source && current.grace === silenceGrace * 1000) {
      this.noteMusicDim();
      return;
    }
    current?.stop();
    this.audio = { watcher: null, playing: null };
    if (!wanted) {
      this.noteMusicDim();
      return;
    }
    const watcher = this.audioWatcher({
      source, grace: silenceGrace * 1000, spawn: this.spawn, exec: this.exec, logger: this.logger,
      onChange: playing => this.onAudio(watcher, playing)
    });
    this.audio.watcher = watcher;
    this.audio.playing = await watcher.start();
    if (this.audio.playing === false && this.settings?.onlyWhilePlaying) this.logger.info('Audio is silent, visualizer waits for it');
    this.noteMusicDim();
  }

  async onAudio(watcher, playing) {
    if (this.audio.watcher !== watcher || this.stopping) return;
    this.audio.playing = playing;
    this.noteMusicDim();
    if (!this.settings?.onlyWhilePlaying) return;
    this.logger.info(playing ? 'Audio playing, visualizer starts' : 'Audio silent, visualizer stops');
    try {
      for (const entry of this.entries.values()) if (entry.instance.engine === 'sleeve') this.display(entry, { visible: playing });
      await this.sync();
    } catch (error) {
      this.logger.error('Visualizer failed to follow the audio', { error: error.message });
    }
  }

  // Watches sleeved while a sleeve instance can run: when it restarts it has forgotten what it was told
  watchSleeved() {
    const wanted = this.active && !this.stopping && (this.settings?.instances ?? []).some(instance => instance.engine === 'sleeve');
    if (!wanted) {
      this.sleeved?.stop();
      return;
    }
    this.sleeved ??= this.sleevedWatcher({ onHello: () => this.remindSleeved(), logger: this.logger });
    this.sleeved.start();
  }

  // Sends sleeved what it should know of each running page: the look, which it forgets on a restart, and hidden for
  // silence. Harmless when it has forgotten nothing, as at the first hello.
  remindSleeved() {
    for (const entry of this.entries.values()) {
      if (entry.instance.engine !== 'sleeve') continue;
      this.display(entry, { look: entry.instance.sleeve, ...(this.silenced ? { visible: false } : {}) });
    }
  }

  // Stops instances whose monitor is gone or moved, or that the settings or silence no longer want, then
  // starts the missing ones in the section's order
  async sync() {
    this.watchSleeved();
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
    const child = this.spawn(file, args, { detached: true, stdio: [instance.pipe ? 'pipe' : 'ignore', 'pipe', 'pipe'], env });
    const entry = {
      key: entryKey(monitor.name, instance.name), monitor, instance, adapter, geometry, child, restarts, output: [], failed: false, window: null,
      colors: null, writing: Promise.resolve(), startedLook: instance.sleeve ?? null
    };
    this.entries.set(entry.key, entry);
    // sleeved outlives its pages and remembers changes by their name, which would win over these start options
    if (instance.engine === 'sleeve') this.display(entry, { reset: true, ...(this.silenced ? { visible: false } : {}) });
    if (instance.pipe) {
      // GLava draws nothing until every piped value has arrived: the wallpaper's colors when known, else the
      // configured ones
      child.stdin?.on('error', () => {});
      this.sendColors(entry, this.colorsFor(monitor, instance, geometry) ?? instance.pipe);
    }
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
    entry.placed = this.findAndPlace(entry);
    return entry;
  }

  // Tells a running sleeve page about a change. In the background and best effort: without sleeved there is
  // nothing on the page to change (status 2), and it starts with the start options when sleeved appears.
  display(entry, change) {
    const { file, args } = entry.adapter.display(entry.monitor, change);
    return Promise.resolve().then(() => this.exec(file, args)).catch(error => {
      if (error.code === 2) this.logger.debug('sleeved is not running', { instance: entry.instance.name });
      else this.logger.warn('sleeve ctl display failed', { instance: entry.instance.name, error: error.message });
    });
  }

  // Writes colors to an instance's stdin, after any earlier writes; resolves once written. An adapter's
  // colorLines gives its own lines, which need no pacing; otherwise GLava's, one line per value (see PIPE_GAP_MS).
  sendColors(entry, colors) {
    entry.colors = colors;
    const lines = entry.adapter.colorLines?.(colors);
    entry.writing = entry.writing.then(async () => {
      for (const line of lines ?? Object.entries(colors).map(([name, value]) => `${name} = ${value}\n`)) {
        if (!entry.child.stdin || entry.child.stdin.destroyed || entry.colors !== colors) return;
        entry.child.stdin.write(line);
        if (!lines) await sleep(this.pipeGap);
      }
    });
    return entry.writing;
  }

  // Asks colorsFor again for the instances on a monitor that take their colors from the wallpaper, after the
  // daemon loads a new item there or samples it; resolves once the new colors are written
  recolor(name) {
    const changed = this.monitorEntries(name).flatMap(entry => {
      if (!entry.instance.pipe) return [];
      const colors = this.colorsFor(entry.monitor, entry.instance, entry.geometry) ?? entry.instance.pipe;
      if (JSON.stringify(colors) === JSON.stringify(entry.colors)) return [];
      this.logger.info('Visualizer colors from the wallpaper', { monitor: name, instance: entry.instance.name, colors });
      return [this.sendColors(entry, colors)];
    });
    return Promise.all(changed);
  }

  // Whether an instance or an overlay on the monitor takes its colors from the wallpaper (overlays always do)
  wantsWallpaperColors(name) {
    const monitor = this.monitors.get(name);
    if (!monitor) return false;
    return this.overlaysOn(name).length > 0 || (this.settings?.instances ?? []).some(instance => instance.pipe && this.wanted(instance, monitor));
  }

  // Running instances of a monitor, in the section's order
  monitorEntries(name) {
    return (this.settings?.instances ?? [])
      .map(instance => this.entries.get(entryKey(name, instance.name)))
      .filter(entry => entry && this.current(entry));
  }

  // Finds an instance's window, then places every window of the monitor found so far. Each instance searches by itself,
  // so a slow one (sleeve's takes about twice GLava's, far longer on a busy machine) does not leave the others under the wallpaper.
  async findAndPlace(entry) {
    entry.window = await this.findWindow(entry.adapter.title(entry.monitor), entry);
    entry.searched = true;
    return this.placeMonitor(entry.monitor.name);
  }

  placeMonitor(name) {
    const previous = this.placing.get(name) ?? Promise.resolve();
    const next = previous.then(() => this.place(name));
    this.placing.set(name, next.catch(() => {}));
    return next;
  }

  // Sets each instance's opacity and stacks the monitor's instances and overlays above its wallpaper, then
  // checks again once GLava has had time to lower itself. The order, bottom to top: the wallpaper, overlays
  // marked 'below', the instances in the section's order, overlays marked 'above'. Without a running
  // wallpaper GLava stays at the bottom, over the bare root window, and a monitor with sleeve is stacked from
  // the bottom in the same order. Resolves to whether they ended up in order
  // (or no wallpaper runs); false when there is nothing to place.
  async place(name) {
    const entries = this.monitorEntries(name);
    try {
      // Those searched for and not found get another look; ones still being searched for join when they are found
      const lost = entries.filter(entry => entry.searched && !entry.window);
      for (const entry of lost) entry.window = await this.findWindow(entry.adapter.title(entry.monitor), entry);
      const missing = lost.filter(entry => !entry.window && this.current(entry));
      for (const entry of missing) this.logger.warn('Visualizer window not found, cannot place it', { monitor: name, instance: entry.instance.name });
      const placed = entries.filter(entry => entry.window && this.current(entry));
      return await this.x11(async x => {
        const overlays = await this.findOverlays(name, x);
        if (!placed.length && !overlays.length) return false;
        this.noteCompositor(await x.hasCompositor());
        for (const entry of placed) {
          await x.setOpacity(entry.window, entry.instance.opacity);
          // A compositor's shadow would outline the window's whole rectangle, not what it draws
          await x.setNoShadow(entry.window);
        }
        const wallpaper = await this.wallpaperWindow(name, x);
        // GLava lowers itself, but sleeve stays where it maps, over every other window, unless it is placed. A
        // wallpaper whose window is not found yet is not the same as none: lowering would put sleeve beneath it.
        if (!wallpaper && (this.screens.has(name) || !placed.some(entry => entry.instance.engine === 'sleeve'))) return !missing.length;
        const layers = [
          ...overlays.filter(overlay => overlay.position === 'below').map(overlay => ({ window: overlay.window })),
          ...placed.map(entry => ({ window: entry.window, entry })),
          ...overlays.filter(overlay => overlay.position === 'above').map(overlay => ({ window: overlay.window }))
        ];
        const stack = async () => {
          let sibling = wallpaper;
          for (const layer of layers) {
            if (sibling) await x.stackAbove(layer.window, sibling);
            else await x.lower(layer.window);
            sibling = layer.window;
          }
        };
        await stack();
        await sleep(this.settleDelay);
        let sibling = wallpaper;
        for (const layer of layers) {
          if (layer.entry && !this.current(layer.entry)) return false;
          if (sibling && !await x.isAbove(layer.window, sibling)) {
            await stack();
            break;
          }
          sibling = layer.window;
        }
        return !missing.length;
      });
    } catch (error) {
      this.logger.warn('Failed to place the visualizer above the wallpaper', { monitor: name, error: error.message });
      return false;
    }
  }

  // Logs when the compositor goes missing or comes back; checked on every placement, since with i3 the
  // compositor often starts after the daemon
  noteCompositor(present) {
    if (present === this.compositor) return;
    if (!present) this.logger.warn('No compositor runs: the visualizer\'s transparency shows black (start picom or another compositor)');
    else if (this.compositor === false) this.logger.info('A compositor runs again');
    this.compositor = present;
  }

  // After the daemon starts a wallpaper. xwinwrap lowers itself, which already leaves the instances above it;
  // placing again keeps that true whatever order the windows mapped in.
  // A monitor without instances is only looked at for overlays when asked to (scan) or when it had some at
  // the last look, so a daemon without visualizers or overlays never opens an X connection.
  restack(name, { scan = false } = {}) {
    if (!this.monitorEntries(name).length && !scan && !this.overlays.get(name)?.length) return Promise.resolve(false);
    return this.placeMonitor(name);
  }

  // scan: also every monitor without instances, for overlays (`backdrop restack`, which overlay programs
  // run when their window maps or moves between above and below)
  restackAll({ scan = false } = {}) {
    const names = new Set([
      ...[...this.entries.values()].map(entry => entry.monitor.name),
      ...[...this.overlays.keys()].filter(name => this.overlays.get(name).length),
      ...(scan ? this.monitors.keys() : [])
    ]);
    return Promise.all([...names].map(name => this.restack(name, { scan })));
  }

  // The overlays whose center lies on the monitor, remembered for overlaysOn(); onOverlays is told when
  // the monitor's set changes (so the daemon samples the wallpaper for their colors and writes its state).
  // A failed look leaves the monitor without overlays.
  async findOverlays(name, x) {
    const monitor = this.monitors.get(name);
    let overlays = [];
    try {
      if (monitor) overlays = (await x.overlays()).filter(overlay => onMonitor(overlay.geometry, monitor));
    } catch (error) {
      this.logger.warn('Failed to look for overlay windows', { monitor: name, error: error.message });
    }
    const key = list => JSON.stringify(list.map(({ window, position, geometry }) => [window, position, geometry]));
    const previous = this.overlays.get(name) ?? [];
    this.overlays.set(name, overlays);
    if (key(previous) !== key(overlays)) {
      this.logger.info(overlays.length ? 'Overlays found' : 'Overlays gone', {
        monitor: name, overlays: overlays.map(({ window, name: title, position }) => ({ window, name: title, position }))
      });
      try {
        this.onOverlays(name);
      } catch (error) {
        this.logger.warn('Overlay change handling failed', { monitor: name, error: error.message });
      }
    }
    return overlays;
  }

  // The overlays found on a monitor at its last placement, bottom to top: { window, name, position, geometry }
  overlaysOn(name) {
    return this.overlays.get(name) ?? [];
  }

  // Whether entry is still a running instance
  current(entry) {
    return !this.stopping && this.entries.get(entry.key) === entry && !entry.failed
      && entry.child.exitCode === null && entry.child.signalCode === null;
  }

  async findWindow(title, entry) {
    const pattern = `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    // A sleeve start takes about 2 s, twice GLava's, and longer on a busy machine
    const attempts = this.windowAttempts * (entry.instance.engine === 'sleeve' ? SLEEVE_WINDOW_FACTOR : 1);
    for (let attempt = 0; attempt < attempts && this.current(entry); attempt++) {
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
    if (entry.instance.engine === 'sleeve' && code === SLEEVE_NO_RETRY) {
      entry.failed = true;
      this.logger.error('sleeve cannot start, giving up on it until reload', { monitor: name, instance, output });
      return;
    }
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
    // sync starts it again if an instance is still wanted
    this.sleeved?.stop();
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
    this.noteMusicDim();
    await this.stopAll();
  }

  // For state.json: the instances on a monitor, in the section's order
  describe(name) {
    return (this.settings?.instances ?? []).flatMap(instance => {
      const entry = this.entries.get(entryKey(name, instance.name));
      if (!entry) return [];
      return [{
        instance: instance.name, engine: instance.engine ?? this.settings.engine, module: instance.module, pid: entry.child.pid,
        running: !entry.failed, geometry: formatGeometry(entry.geometry),
        // The colors last sent from the wallpaper or the config, with palette.source: wallpaper
        ...(instance.pipe ? { colors: entry.colors } : {})
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
      silenced: this.silenced,
      suspended: this.suspended,
      compositor: this.compositor,
      // How far the wallpaper is dimmed for music now (visualizer.wallpaper_dim), for `backdrop dim`
      musicDim: this.musicDim,
      // The visualizer menu's changes, by instance
      live: this.live
    };
  }
}
