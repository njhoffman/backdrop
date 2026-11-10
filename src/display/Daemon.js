import { spawn as spawnProcess } from 'child_process';
import { watch as watchFiles } from 'fs';
import { createRequire } from 'module';
import fs from 'fs-extra';
import path from 'path';
import { MpvClient } from './MpvClient.js';
import { listMonitors, selectMonitors, missingMonitors, geometry, run } from './Monitors.js';
import {
  getMode, displayMode, lastMediaKey, loadPlaylist, syncPlaylist, appendToPlaylist, modeOfKind, removeFailedEntry, contrastFor, reshuffleOnWrap,
  playbackLimits
} from './Playlist.js';
import { Importer } from '../library/Importer.js';
import { purgeTrash } from '../library/purge.js';
import { thumbnailFor } from '../library/thumbnail.js';
import { reverseVideo } from '../library/reverse.js';
import { smoothVideo } from '../library/smooth.js';
import { entryPath, playsBounce } from './bounce.js';
import { Bounce } from './daemon/Bounce.js';
import { Smooth } from './daemon/Smooth.js';
import { notifyMode, notifyPlaying, notifyError } from '../utils/notify.js';
import { outputTail } from './outputTail.js';
import { VisualizerManager, formatGeometry } from '../visualizer/VisualizerManager.js';
import { sampleMedia } from '../visualizer/palette.js';
import { ChildRegistry, processStart, reapOrphans } from './children.js';
import { cpuPercent } from './cpu.js';
import { readGpuMemory } from './gpu.js';
import { statePath, nextFiltersPath } from './runtimeFiles.js';
import { Screensaver, IDLE_CHECK_MS } from './daemon/Screensaver.js';
import { ControlRequests } from './daemon/ControlRequests.js';
import { ConfigChanges } from './daemon/ConfigChanges.js';
import { WallpaperColors } from './daemon/WallpaperColors.js';
import { Health } from './daemon/Health.js';
import { ImportWatcher, IMPORT_SETTLE_MS } from './daemon/ImportWatcher.js';
import { LoadShedding } from './daemon/LoadShedding.js';
import { OutputWatcher } from './outputWatcher.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1000;
// A started mpv with media to show that has not opened a file by then is killed, so the restart path tries again;
// after a hotplug one once came up with no picture and never left that state
const FIRST_FILE_TIMEOUT_MS = 15_000;
// mpv answers nothing while it sets up video, which a slow GPU or decoder probe can stretch to several seconds
const MPV_COMMAND_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 2000;
// An mpv that misses this many IPC health checks in a row is killed and restarted
const HEALTH_INTERVAL_MS = 30_000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Monitor layout changes (hotplug, xrandr) are picked up this often while no i3 output events arrive (another
// window manager, i3 restarting)
const MONITOR_POLL_MS = 5000;
// With i3's output events live, the layout is read on each event, and otherwise only this often as a fallback:
// each read has X re-read monitor EDIDs over DDC, which blocks it for a moment
const MONITOR_FALLBACK_MS = 60_000;
// The load average is read this often when the load section is on
const LOAD_INTERVAL_MS = 15_000;
// Files the daemon's imports hash and probe at once, fewer than the CLI so playback keeps its CPU
const DAEMON_IMPORT_CONCURRENCY = 2;
// The startup import logs how far it is at most this often
const IMPORT_PROGRESS_MS = 30_000;

const { version } = createRequire(import.meta.url)('../../package.json');
// sockaddr_un.sun_path is 108 bytes including the terminating NUL
const MAX_SOCKET_PATH = 107;

// Quiet time after the last change to the config file before it is read; editors write a file in steps
const CONFIG_SETTLE_MS = 300;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


export { statePath, controlPath, controlRequestPath, nextFiltersPath } from './runtimeFiles.js';

export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The running daemon's state ({ pid, monitors: [{ name, width, height, x, y, socket }] }), or null
export async function readState(runtimeDir) {
  try {
    const state = await fs.readJson(statePath(runtimeDir));
    return isProcessRunning(state.pid) ? state : null;
  } catch {
    return null;
  }
}

export function buildCommand(monitor, socketPath, display) {
  return {
    file: 'xwinwrap',
    args: [
      ...display.xwinwrap_args,
      '-g', geometry(monitor),
      '--',
      'mpv',
      '-wid', 'WID',
      '--no-config',
      `--input-ipc-server=${socketPath}`,
      '--idle=yes',
      '--loop-playlist=inf',
      '--no-audio',
      '--no-osc',
      '--no-osd-bar',
      '--no-input-default-bindings',
      '--no-stop-screensaver',
      // Warnings and errors reach the daemon's pipe (outputTail), so an exit can say why; --quiet drops the status line
      '--quiet',
      '--msg-level=all=warn',
      '--framedrop=vo',
      '--panscan=1.0',
      // VAAPI first: auto-safe tries NVIDIA's CUDA before it, which can stall mpv for 6 s on a machine without the card
      '--hwdec=vaapi,auto-safe',
      ...display.mpv_args
    ]
  };
}

export class Daemon {
  constructor({
    config, database, logger,
    spawn = spawnProcess, exec = run, connect = MpvClient.connect, kill = process.kill,
    restartDelay = RESTART_DELAY_MS, firstFileTimeout = FIRST_FILE_TIMEOUT_MS, stopGrace = STOP_GRACE_MS,
    healthInterval = HEALTH_INTERVAL_MS, purgeInterval = PURGE_INTERVAL_MS, importProgressInterval = IMPORT_PROGRESS_MS,
    monitorInterval = MONITOR_POLL_MS, now = Date.now, readFile,
    importer = new Importer({ config, database, logger }),
    purge = () => purgeTrash({ config, database, logger }),
    thumbnail = media => thumbnailFor(media, config.get().paths.thumbnails, { logger, nice: true }),
    // A bouncing video's reversed copy (src/library/reverse.js); resolves to its path, or null
    reverse = (media, { signal, dir } = {}) => reverseVideo(media, dir ?? config.get().paths.bounce, { logger, signal }),
    // A slowed video's smoothed copy (src/library/smooth.js); resolves to its path, or null
    smoothVideo: smoothen = (media, { dir, size, target, rife, signal } = {}) => smoothVideo(media, dir, { rife, size, target, logger, signal }),
    visualizers, reloadConfig = () => config.reloadSection('visualizer'),
    // The whole config file loaded and checked again, for a saved change; throws on a mistake in it
    readConfig = async () => {
      const fresh = new config.constructor(config.configPath);
      await fresh.loadConfig();
      return fresh;
    },
    watch = watchFiles, configSettle = CONFIG_SETTLE_MS, importSettle = IMPORT_SETTLE_MS,
    readStart = processStart, reap = runtimeDir => reapOrphans(runtimeDir, { kill, logger }),
    samplePalette = (media, monitor) => sampleMedia(media, monitor),
    // Bytes of GPU memory an mpv holds (src/display/gpu.js), null when unknown
    gpuMemory = pid => readGpuMemory(pid),
    // os.loadavg by default, for the load section
    loadavg,
    loadInterval = LOAD_INTERVAL_MS,
    // The visualizer adapter factory, for a test's stand-in engine (see test/display/stacking.integration.test.js)
    createVisualizer,
    // i3's output events (src/display/outputWatcher.js); null leaves the timer alone to find layout changes
    watchOutputs = options => new OutputWatcher(options),
    monitorFallback = MONITOR_FALLBACK_MS
  }) {
    this.watchOutputs = watchOutputs;
    this.monitorFallback = monitorFallback;
    this.outputWatcher = null;
    // When the layout was last read (this.now), for the fallback while output events are live
    this.lastMonitorCheck = 0;
    this.config = config;
    this.database = database;
    this.logger = logger;
    // Every child is recorded in children.json, so a start after a crash can end the ones left running
    this.children = new ChildRegistry({ runtimeDir: () => this.runtimeDir, readStart });
    this.spawn = this.children.track(spawn);
    this.reap = reap;
    // What each monitor shows, sampled for visualizer.palette.source: wallpaper: name -> { mediaId, sample }
    this.samplePalette = samplePalette;
    this.samples = new Map();
    this.sampling = new Map();
    this.exec = exec;
    this.connect = connect;
    this.kill = kill;
    this.restartDelay = restartDelay;
    this.firstFileTimeout = firstFileTimeout;
    this.stopGrace = stopGrace;
    this.importer = importer;
    this.importing = Promise.resolve();
    this.healthInterval = healthInterval;
    this.purgeInterval = purgeInterval;
    this.importProgressInterval = importProgressInterval;
    this.monitorInterval = monitorInterval;
    this.now = now;
    this.readFile = readFile;
    this.gpuMemory = gpuMemory;
    // Items already warned about for software decoding during this run
    this.softwareWarned = new Set();
    this.reconciling = null;
    this.purge = purge;
    this.thumbnail = thumbnail;
    this.reverse = reverse;
    this.smoothVideo = smoothen;
    this.timers = [];
    // Active monitors by name; screens holds their wallpaper processes, empty while the wallpaper is off
    this.monitors = new Map();
    this.screens = new Map();
    this.wallpaper = true;
    // Counts control requests applied, which CLIs before 2.38.2 wait on; handledRequests holds the ids of
    // the latest ones, so a CLI waits for its own request rather than for any
    this.controlGeneration = 0;
    this.handledRequests = [];
    // --image-duration/--video-duration from next or menu (next-filters.json), over display.* until cleared
    this.durations = {};
    // Concerns kept in their own modules (src/display/daemon/), each given this daemon
    this.controls = new ControlRequests(this);
    this.configChanges = new ConfigChanges(this);
    this.wallpaperColors = new WallpaperColors(this);
    this.health = new Health(this);
    this.importWatcher = new ImportWatcher(this, { settle: importSettle });
    this.load = new LoadShedding(this, { loadavg });
    this.bounce = new Bounce(this);
    this.smoothing = new Smooth(this);
    this.screensaver = new Screensaver(this);
    this.loadInterval = loadInterval;
    this.queue = Promise.resolve();
    this.visualizers = visualizers ?? new VisualizerManager({
      config, logger, monitors: this.monitors, screens: this.screens, spawn: this.spawn, kill, exec, restartDelay, stopGrace, now,
      colorsFor: (monitor, instance, geometry) => this.colorsFor(monitor, instance, geometry),
      veilFor: (monitor, geometry, lyricsArea) => this.wallpaperColors.veilFor(monitor, geometry, lyricsArea),
      onMusicDim: () => this.applyDims(),
      onOverlays: name => this.onOverlays(name),
      onWallpaper: () => this.enqueue(() => this.syncWallpaper()),
      ...(createVisualizer ? { create: createVisualizer } : {})
    });
    this.reloadConfig = reloadConfig;
    this.readConfig = readConfig;
    this.watch = watch;
    this.configSettle = configSettle;
    this.configWatcher = null;
    this.configTimer = null;
    this.stopping = false;
    this.stopped = null;
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  // wallpaper: false starts without wallpapers; visualizer: true or false overrides visualizer.enabled.
  // Both last until changed by a control request or the daemon exits.
  async start({ wallpaper = true, visualizer = null } = {}) {
    const existing = await readState(this.runtimeDir);
    if (existing) {
      throw new Error(`backdrop daemon already running (pid ${existing.pid})`);
    }
    // A daemon that died without stopping leaves its wallpapers and visualizers running; end them first
    await this.reap(this.runtimeDir);

    const { display } = this.config.get();
    const active = await listMonitors(this.exec);
    const monitors = selectMonitors(active, display.monitors);
    const missing = missingMonitors(active, display.monitors);
    // Configured monitors that are unplugged are started by hotplug polling once they appear,
    // even when none of them is active yet; with auto there is nothing to wait for
    if (!monitors.length && !missing.length) {
      throw new Error('No active monitors found');
    }
    if (missing.length) {
      this.logger.warn('Configured monitors not active, waiting for them', { missing });
    }

    await fs.ensureDir(this.runtimeDir, 0o700);
    await fs.remove(nextFiltersPath(this.runtimeDir));
    await this.controls.clear();
    this.stopped = new Promise(resolve => { this.resolveStopped = resolve; });
    this.wallpaper = wallpaper;
    this.visualizers.override = visualizer;
    await this.screensaver.begin();
    await this.load.begin();
    await this.bounce.begin().catch(error => this.logger.warn('Failed to clear old bounce work', { error: error.message }));

    try {
      // Before the wallpapers, since the look in use can do without them
      await this.visualizers.configure();
      for (const monitor of monitors) {
        this.monitors.set(monitor.name, monitor);
        if (this.showsWallpaper) await this.startScreen(monitor);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
    // After the monitors, since a copy is made at the size that covers them
    await this.smoothing.begin().catch(error => this.logger.warn('Failed to start smoothing', { error: error.message }));

    await this.visualizers.sync();
    if (!this.wallpaper && !this.visualizers.active) {
      await this.stop();
      throw new Error(`Nothing to show: the wallpaper is off and the visualizer did not start${this.visualizers.error ? ` (${this.visualizers.error})` : ''}`);
    }
    await this.writeState();
    this.logger.info('Daemon started', { version, pid: process.pid, monitors: monitors.map(m => m.name) });
    if (this.config.warnings?.length) this.logger.warn('Unknown config keys', { warnings: this.config.warnings });

    // Playback starts from the existing library; new imports are appended as they finish
    this.importing = this.importDirs(monitors[0] ?? null);

    this.watchConfig();
    this.importWatcher.start();

    // An interval of 0 turns the timer off (tests drive these directly)
    this.runPurge();
    this.every(this.purgeInterval, () => this.runPurge());
    this.every(this.healthInterval, () => this.checkHealth());
    this.outputWatcher = this.watchOutputs?.({ spawn: this.spawn, logger: this.logger, onChange: () => this.checkMonitors() }) ?? null;
    this.outputWatcher?.start();
    this.every(this.monitorInterval, () => this.pollMonitors());
    this.every(this.loadInterval, () => this.enqueue(() => this.load.check()));
    this.every(IDLE_CHECK_MS, () => this.enqueue(() => this.screensaver.checkIdle()));
  }

  // Wanted by the user and allowed by the system load
  get showsWallpaper() {
    return this.wallpaper && !this.load.off && !this.visualizers.hidesWallpaper;
  }

  // Follows a preset that hides the wallpaper or stops doing so
  async syncWallpaper() {
    if (this.stopping) return;
    if (this.showsWallpaper) {
      await this.controls.startWallpapers();
      await this.visualizers.restackAll();
    } else {
      await this.controls.stopWallpapers();
    }
    await this.writeState();
  }

  // The mode a monitor shows, which the load may be holding (see displayMode)
  screenMode(monitor) {
    return displayMode(this.database, monitor, { allowUpscale: this.config.get().display.allow_upscale });
  }

  // Active monitors to manage now; a configured monitor that is missing is picked up when it returns
  filterConfigured(active) {
    return selectMonitors(active, this.config.get().display.monitors);
  }

  // Starts, stops or respawns monitor instances to match the current layout; concurrent calls share one run
  checkMonitors() {
    if (this.stopping) return Promise.resolve();
    this.reconciling ??= this.reconcileMonitors().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  // The timer's check: every tick without live i3 output events, else only once monitorFallback has passed
  pollMonitors() {
    if (this.outputWatcher?.connected && this.now() - this.lastMonitorCheck < this.monitorFallback) return Promise.resolve();
    return this.checkMonitors();
  }

  async reconcileMonitors() {
    this.lastMonitorCheck = this.now();
    let reported;
    try {
      reported = await listMonitors(this.exec);
    } catch (error) {
      this.logger.warn('Cannot read monitor layout', { error: error.message });
      return;
    }
    // xrandr briefly reports nothing during some mode switches; keep playing rather than tear everything down
    if (!reported.length) {
      this.logger.warn('No active monitors reported, keeping the current layout');
      return;
    }
    const active = this.filterConfigured(reported);

    const byName = new Map(active.map(monitor => [monitor.name, monitor]));
    let changed = false;
    for (const [name, monitor] of [...this.monitors]) {
      const next = byName.get(name);
      if (next && geometry(next) === geometry(monitor)) continue;
      if (this.stopping) return;
      this.logger.info(next ? 'Monitor changed, restarting it' : 'Monitor removed', {
        monitor: name, from: geometry(monitor), to: next ? geometry(next) : null
      });
      this.monitors.delete(name);
      // Removed from the map first so handleExit does not treat the exit as a crash
      const screen = this.screens.get(name);
      if (screen) {
        this.screens.delete(name);
        await this.stopScreen(screen);
      }
      changed = true;
    }
    for (const monitor of active) {
      if (this.monitors.has(monitor.name) || this.stopping) continue;
      this.logger.info('Monitor added', { monitor: monitor.name, geometry: geometry(monitor) });
      this.monitors.set(monitor.name, monitor);
      if (this.showsWallpaper && !await this.startWallpaper(monitor)) {
        // Left out so the next poll tries again
        this.monitors.delete(monitor.name);
      }
      changed = true;
    }
    if (changed && !this.stopping) {
      await this.visualizers.sync();
      await this.writeState();
      // A larger monitor needs larger smoothed copies; until they are made, the originals play there
      this.smoothing.backlog();
    }
  }

  // Starts a monitor's wallpaper; a failure is logged and cleaned up. Resolves to whether it started.
  async startWallpaper(monitor) {
    try {
      await this.startScreen(monitor);
      return true;
    } catch (error) {
      this.logger.error('Failed to start monitor', { monitor: monitor.name, error: error.message });
      const screen = this.screens.get(monitor.name);
      if (screen) {
        this.screens.delete(monitor.name);
        await this.stopScreen(screen);
      }
      return false;
    }
  }

  // `backdrop start/stop --wallpaper`: wallpapers on every active monitor, or none. Running visualizers are
  // placed above the new wallpaper windows.
  setWallpaper(on) {
    return this.controls.setWallpaper(on);
  }

  // SIGUSR1: applies the pending control requests (see ControlRequests.apply). With neither part left on,
  // the daemon stops.
  applyControl() {
    return this.controls.apply();
  }

  imageDuration() {
    return this.controls.imageDuration();
  }

  videoDuration() {
    return this.controls.videoDuration();
  }

  // Re-reads the durations next and the menu stored and applies them to what plays now: the image's
  // display time, and the video's end, counted from when it started
  applyDurations() {
    return this.controls.applyDurations();
  }

  every(interval, fn) {
    if (interval > 0) {
      this.timers.push(setInterval(fn, interval).unref());
    }
  }

  async runPurge() {
    try {
      await this.purge();
    } catch (error) {
      this.logger.error('Trash purge failed', { error: error.message });
    }
  }

  // Supervision otherwise only sees process exits; an mpv that stops answering IPC is killed,
  // and handleExit restarts it within the usual restart budget. A healthy mpv is also sampled for CPU use.
  checkHealth() {
    return this.health.checkHealth();
  }

  // Measures the CPU mpv used since the previous sample. The interval counts toward the playing item only
  // if that item played through all of it, so a switch never charges one item for another's decoding.
  sample(screen, pid) {
    return this.health.sample(screen, pid);
  }

  // mpv reports the decoder only once a file is open, and observed properties only fire on changes,
  // so the decoder is read on each sample rather than on load
  recordDecoder(screen) {
    return this.health.recordDecoder(screen);
  }

  // The monitor imports record their default rating against
  firstMonitor() {
    return [...this.monitors.values()][0] ?? null;
  }

  // Imports library.import_dirs and appends what is new to every playlist; returns the import summary.
  // settle (watched folders) leaves files that are still changing for a later pass.
  async importDirs(monitor, { settle = 0 } = {}) {
    const dirs = this.config.get().library.import_dirs;
    if (!dirs.length) {
      return null;
    }

    try {
      let total = 0;
      let lastReport = Date.now();
      // A `backdrop import` already running covers the same folders and adds its finds to the playlists
      const summary = await this.importer.importDirs(dirs, {
        resolution: monitor ? `${monitor.width}x${monitor.height}` : null,
        whenLocked: 'skip',
        settle,
        shouldStop: () => this.stopping,
        concurrency: DAEMON_IMPORT_CONCURRENCY,
        onStart: count => {
          total = count;
          // A watched folder's change rescans every folder; only the full imports are worth a line
          if (!settle) this.logger.info('Import started', { files: total });
        },
        onFile: (file, outcome, done) => {
          if (Date.now() - lastReport >= this.importProgressInterval && done < total) {
            lastReport = Date.now();
            this.logger.info('Import progress', { done, total });
          }
        }
      });
      const { imported } = summary;
      if (!imported.length || this.stopping) {
        return summary;
      }

      for (const screen of this.screens.values()) {
        const added = await appendToPlaylist(screen.client, {
          database: this.database, config: this.config.get(), mode: this.screenMode(screen.monitor), monitor: screen.monitor, mediaIds: imported
        });
        this.logger.info('Added imported media to playlist', { monitor: screen.monitor.name, added });
      }
      return summary;
    } catch (error) {
      this.logger.error('Import failed', { error: error.message });
      return null;
    }
  }

  async startScreen(monitor) {
    const socketPath = path.join(this.runtimeDir, `${monitor.name}.sock`);
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
      throw new Error(`Socket path is longer than ${MAX_SOCKET_PATH} bytes, shorten paths.runtime: ${socketPath}`);
    }
    await fs.remove(socketPath);

    const { file, args } = buildCommand(monitor, socketPath, this.config.get().display);
    // Piped rather than ignored: xwinwrap's X errors and mpv's warnings are the only record of why one exits
    const child = this.spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = outputTail([child.stdout, child.stderr]);

    const previous = this.screens.get(monitor.name);
    const screen = {
      monitor, socketPath, child, output, client: null, restarts: previous?.restarts ?? [], failing: Promise.resolve()
    };
    this.screens.set(monitor.name, screen);

    child.on('error', error => this.logger.error('Failed to launch xwinwrap', { monitor: monitor.name, error: error.message }));
    child.on('exit', (code, signal) => this.handleExit(screen, code, signal));

    screen.client = await this.connect(socketPath, { attempts: 50, delay: 100, timeout: MPV_COMMAND_TIMEOUT_MS });
    screen.client.on('error', error => this.logger.warn('mpv socket error', { monitor: monitor.name, error: error.message }));
    screen.client.on('property-change', event => {
      if (event.name === 'path' && event.data) {
        this.onFileLoaded(screen, event.data);
      } else if (event.name === 'container-fps' && event.data) {
        this.onFrameRate(screen, event.data);
      } else if (event.name === 'contrast' && typeof event.data === 'number') {
        this.onContrast(screen, event.data);
      } else if (event.name === 'speed' && typeof event.data === 'number') {
        this.onSpeed(screen, event.data);
      }
    });
    screen.client.on('end-file', event => {
      if (event.reason === 'error') {
        // Serialized so concurrent failures do not remove entries by stale indexes
        screen.failing = screen.failing.then(() => this.onLoadFailed(screen, event));
      }
    });
    await screen.client.observeProperty(1, 'path');
    await screen.client.observeProperty(2, 'container-fps');
    await screen.client.observeProperty(3, 'contrast');
    await screen.client.observeProperty(4, 'speed');

    const count = await this.loadScreenPlaylist(screen);
    if (count) this.watchFirstFile(screen);
  }

  // Kills a screen's mpv when it has media but opens no file in time (no `path` from mpv), so handleExit
  // restarts it within the usual budget instead of leaving the monitor black
  watchFirstFile(screen) {
    if (!this.firstFileTimeout) return;
    clearTimeout(screen.firstFileTimer);
    screen.firstFileTimer = setTimeout(() => {
      const { child } = screen;
      if (this.stopping || screen.filename || this.screens.get(screen.monitor.name) !== screen ||
          child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      this.logger.error('mpv opened no file, restarting it', {
        monitor: screen.monitor.name, seconds: this.firstFileTimeout / 1000, output: screen.output?.lines()
      });
      this.killGroup(child, 'SIGKILL');
    }, this.firstFileTimeout);
    screen.firstFileTimer.unref?.();
  }

  // The monitor's eligible items as mpv's playlist, resuming the last one shown when it is still eligible
  async loadScreenPlaylist(screen) {
    const mode = this.screenMode(screen.monitor);
    const count = await loadPlaylist(screen.client, {
      database: this.database,
      config: this.config.get(),
      mode,
      monitor: screen.monitor,
      imageDuration: this.imageDuration()
    });
    if (!count) {
      this.logger.warn('No media to show', { monitor: screen.monitor.name, mode });
    }
    return count;
  }

  // After an eligibility change: the playlist follows what is eligible now, keeping the item on screen
  // playing when it still is (syncPlaylist)
  async syncScreenPlaylist(screen) {
    const mode = this.screenMode(screen.monitor);
    const { removed, added, count } = await syncPlaylist(screen.client, {
      database: this.database, config: this.config.get(), mode, monitor: screen.monitor
    });
    this.logger.info('Playlist updated', { monitor: screen.monitor.name, removed, added });
    if (!count) this.logger.warn('No media to show', { monitor: screen.monitor.name, mode });
  }

  // The dim an item shows with: its own, or visualizer.wallpaper_dim while music plays if that is more
  shownDim(media) {
    return Math.max(media?.dim ?? 0, this.visualizers.musicDim ?? 0);
  }

  // Sets every wallpaper's contrast again when the music dim changes, with each item's dim read again
  // (`backdrop dim` may have changed it since it loaded)
  async applyDims() {
    if (this.stopping) return;
    await Promise.all([...this.screens.values()].map(async screen => {
      if (!screen.client || !screen.media) return;
      screen.media = this.database.getMedia(screen.media.id) ?? screen.media;
      try {
        await screen.client.setProperty('contrast', contrastFor(this.shownDim(screen.media)));
      } catch (error) {
        this.logger.warn('Failed to set contrast', { monitor: screen.monitor.name, error: error.message });
      }
    }));
    await this.writeState();
  }

  // mpv's contrast changed (a load, the music dim, or `backdrop dim`): visualizer colors from the wallpaper
  // are checked for contrast against what shows now
  onContrast(screen, contrast) {
    if (screen.contrast === contrast) return;
    screen.contrast = contrast;
    if (!this.visualizers.wantsWallpaperColors?.(screen.monitor.name)) return;
    Promise.resolve(this.visualizers.recolor?.(screen.monitor.name)).catch(error => {
      this.logger.warn('Visualizer recolor failed', { monitor: screen.monitor.name, error: error.message });
    });
    // Overlay colors are read from the state, so it is written again with the new background
    if (this.visualizers.overlaysOn?.(screen.monitor.name).length) {
      this.writeState().catch(error => this.logger.warn('Failed to write state', { error: error.message }));
    }
  }

  // Applies the stored speed and dim and remembers the item so a restart resumes it.
  // Brightness is set on every load because mpv keeps it from the previous file.
  async onFileLoaded(screen, filename) {
    const filePath = entryPath(filename);
    const media = this.database.getMediaByPath(filePath);
    screen.media = media;
    // A bouncing video plays as its file and the reversed copy together (src/display/bounce.js)
    screen.bouncing = playsBounce(filename);
    screen.filename = filename;
    // A switch to the bounce at the end of a pass (daemon/Bounce.js) goes on counting from the replaced entry's load
    const carried = this.bounce.carried(screen, media);
    screen.loadedAt = carried ?? this.now();
    try {
      await screen.client.setProperty('contrast', contrastFor(this.shownDim(media)));
    } catch (error) {
      this.logger.warn('Failed to set contrast', { monitor: screen.monitor.name, error: error.message });
    }
    try {
      screen.entryId = await reshuffleOnWrap(screen.client, screen.entryId);
    } catch (error) {
      this.logger.warn('Failed to reshuffle playlist', { monitor: screen.monitor.name, error: error.message });
    }
    await this.applyLimits(screen, media, carried === null ? {} : { elapsed: (this.now() - carried) / 1000, position: 0 });
    if (!media) {
      this.logger.warn('Playing file not in library', { monitor: screen.monitor.name, path: filePath });
      return;
    }

    const mode = modeOfKind(media.kind);
    this.database.setSetting(lastMediaKey(mode, screen.monitor.name), media.id);
    if (mode === 'video') {
      try {
        await screen.client.setProperty('speed', media.speed);
      } catch (error) {
        this.logger.warn('Failed to set speed', { monitor: screen.monitor.name, error: error.message });
      }
    }
    await this.notify(screen, media);
    if (this.visualizers.wantsWallpaperColors?.(screen.monitor.name)) this.sampleScreen(screen.monitor.name);
    this.prefetchThumbnails(screen, media);
    await this.bounce.onLoaded(screen, media);
    await this.smoothing.onLoaded(screen, media, filename);
  }

  // Makes the panel menu's previews ahead of time so opening it does not wait for ffmpeg: the item
  // now playing, then the next playlist entry. Runs in the background, one monitor's queue at a time.
  prefetchThumbnails(screen, media) {
    try {
      if ((this.config.get().menu?.style ?? 'panel') !== 'panel') return;
    } catch {
      return;
    }
    screen.thumbnails = (screen.thumbnails ?? Promise.resolve()).then(async () => {
      if (!await this.thumbnail(media)) return;
      const playlist = await screen.client.getProperty('playlist');
      const next = playlist[playlist.findIndex(entry => entry.current) + 1];
      const upcoming = next && this.database.getMediaByPath(entryPath(next.filename));
      if (upcoming) await this.thumbnail(upcoming);
    }).catch(error => this.logger.warn('Thumbnail prefetch failed', { monitor: screen.monitor.name, error: error.message }));
  }

  // Media added before frame rates were recorded gets its rate from mpv the first time it plays.
  // mpv reports container-fps only once the file is open, after the path change.
  onFrameRate(screen, value) {
    const { media } = screen;
    const fps = Number(value);
    if (!media || media.fps || modeOfKind(media.kind) !== 'video' || !Number.isFinite(fps) || fps <= 0) return;
    media.fps = Math.round(fps * 1000) / 1000;
    try {
      this.database.updateMedia(media.id, { fps: media.fps });
    } catch (error) {
      this.logger.warn('Failed to record frame rate', { mediaId: media.id, error: error.message });
    }
  }

  // With display.notify: all every load is announced, including automatic advances
  async notify(screen, media) {
    try {
      if (notifyMode(this.config.get().display) !== 'all') return;
    } catch (error) {
      this.logger.warn('Invalid notify setting', { error: error.message });
      return;
    }
    const rating = this.database.getLatestRating(media.id);
    await notifyPlaying(this.database, { monitor: screen.monitor, media, rating }, { logger: this.logger, thumbnails: this.config.get().paths.thumbnails });
  }

  // The playing video's speed changed (`backdrop speed`, or mpv's own keys): the limit is counted again from
  // where it plays now, so a slowed video still ends after about the video duration. The speed set on each
  // load matches the item's stored one and changes nothing.
  async onSpeed(screen, speed) {
    const { media } = screen;
    if (!media || modeOfKind(media.kind) !== 'video' || media.speed === speed) return;
    screen.media = { ...media, speed };
    try {
      const position = await screen.client.getProperty('time-pos');
      // A load may have replaced the item while time-pos was read
      if (screen.media?.id !== media.id) return;
      await this.applyLimits(screen, screen.media, { elapsed: (this.now() - (screen.loadedAt ?? this.now())) / 1000, position });
    } catch (error) {
      this.logger.warn('Failed to recount the video duration', { monitor: screen.monitor.name, error: error.message });
    }
  }

  // Ends videos after the video duration (display.video_duration, or one next or the menu set). A file outside the library loops in video mode as before.
  // elapsed: seconds the item has played, when the duration changes while it plays; position: mpv's time-pos, when the speed did
  async applyLimits(screen, media, { elapsed = 0, position } = {}) {
    try {
      const timeout = this.videoDuration();
      // A bounce plays the video forwards and backwards, so one pass is twice the video
      const played = media && screen.bouncing ? { ...media, duration: media.duration * 2 } : media;
      const limits = media || this.screenMode(screen.monitor) !== 'video' ? playbackLimits(played, timeout, elapsed, position) : { 'loop-file': 'inf', end: 'none' };
      for (const [name, value] of Object.entries(limits)) {
        await screen.client.setProperty(name, value);
      }
    } catch (error) {
      this.logger.warn('Failed to set video duration', { monitor: screen.monitor.name, error: error.message });
    }
  }

  async onLoadFailed(screen, event) {
    try {
      const removed = await removeFailedEntry(screen.client, event.playlist_entry_id);
      if (!removed) return;
      this.logger.warn('Dropped unplayable file from playlist', {
        monitor: screen.monitor.name, path: removed.filename, error: event.file_error
      });
      if (!removed.remaining) {
        this.logger.warn('No playable media left', { monitor: screen.monitor.name });
      }
    } catch (error) {
      this.logger.warn('Failed to drop unplayable file', { monitor: screen.monitor.name, error: error.message });
    }
  }

  async handleExit(screen, code, signal) {
    screen.client?.close();
    clearTimeout(screen.firstFileTimer);
    if (this.stopping || this.screens.get(screen.monitor.name) !== screen) {
      return;
    }

    const now = Date.now();
    screen.restarts = screen.restarts.filter(time => now - time < RESTART_WINDOW_MS);
    if (screen.restarts.length >= MAX_RESTARTS) {
      this.logger.error('mpv keeps exiting, giving up on monitor', {
        monitor: screen.monitor.name, code, signal, output: screen.output?.lines()
      });
      await notifyError(`The wallpaper on ${screen.monitor.name} keeps failing and was given up; restart it with backdrop stop and backdrop start`, { logger: this.logger });
      return;
    }
    screen.restarts.push(now);

    this.logger.warn('mpv exited, restarting', { monitor: screen.monitor.name, code, signal, output: screen.output?.lines() });
    await sleep(this.restartDelay);
    // Hotplug may have removed or replaced the monitor during the delay
    if (this.stopping || this.screens.get(screen.monitor.name) !== screen) {
      return;
    }
    try {
      await this.startScreen(screen.monitor);
      this.logger.info('mpv restarted', { monitor: screen.monitor.name });
      // Keeps the visualizer above the new wallpaper window
      this.visualizers.restack(screen.monitor.name);
      await this.writeState();
    } catch (error) {
      this.logger.error('Failed to restart monitor', { monitor: screen.monitor.name, error: error.message });
    }
  }

  // A visualizer instance's colors from the item its monitor shows, or null (its configured colors) while
  // nothing is known: no wallpaper runs, or the item is not sampled yet, in which case sampling starts and
  // the instance is recolored once it is done
  colorsFor(monitor, instance, geometry) {
    return this.wallpaperColors.colorsFor(monitor, instance, geometry);
  }

  // Samples what a monitor shows (in the background, once per item) and recolors its visualizers
  sampleScreen(name) {
    return this.wallpaperColors.sampleScreen(name);
  }

  // The overlays on a monitor changed: sample its wallpaper for their colors, and write the state
  onOverlays(name) {
    if (this.visualizers.overlaysOn(name).length) this.sampleScreen(name);
    return this.writeState().catch(error => this.logger.warn('Failed to write state', { error: error.message }));
  }

  describeOverlays(monitor) {
    return (this.visualizers.overlaysOn?.(monitor.name) ?? []).map(({ window, name, position, geometry }) => ({
      window, name, position, geometry: formatGeometry(geometry), colors: this.wallpaperColors.overlayColors(monitor, geometry)
    }));
  }

  // Written to a temporary file and renamed, so a CLI command never reads a half-written state.
  // cpu is the monitor's recent average (percent of one core), null until two samples were taken;
  // gpuMemory the bytes of GPU memory its mpv held at the last health check, null when unknown.
  // Writes are queued: the monitors' health checks run at once, and two writes sharing the temporary file
  // would interleave into a state.json that no longer parses. Each takes its snapshot when it runs.
  writeState() {
    const write = (this.stateWrite ?? Promise.resolve()).catch(() => {}).then(() => this.writeStateNow());
    this.stateWrite = write;
    return write;
  }

  async writeStateNow() {
    // A sample finishing during shutdown must not recreate the state file stop() removes
    if (this.stopping) return;
    const monitors = [...this.monitors.values()].map(monitor => {
      const { socketPath = null, recent = [], hwdec = null, gpuMemory = null } = this.screens.get(monitor.name) ?? {};
      return {
        ...monitor,
        // null while the wallpaper is off: CLI commands that need mpv say so
        socket: socketPath,
        cpu: cpuPercent(recent.reduce((sum, item) => sum + item.cpuSeconds, 0), recent.reduce((sum, item) => sum + item.seconds, 0)),
        hwdec,
        gpuMemory,
        // Every instance on the monitor, and the first as visualizer for readers of 2.20.0-2.24.0 state
        visualizers: this.visualizers.describe(monitor.name),
        visualizer: this.visualizers.describe(monitor.name)[0] ?? null,
        // Windows marked _BACKDROP_OVERLAY on the monitor, bottom to top, with what the wallpaper shows behind them
        overlays: this.describeOverlays(monitor)
      };
    });
    const file = statePath(this.runtimeDir);
    const temporary = `${file}.${process.pid}.tmp`;
    // version tells the CLI this daemon reloads the visualizer on SIGHUP, and control that it applies
    // control requests on SIGUSR1, rather than dying from either signal; handled that it reads one file per request
    await fs.writeJson(temporary, {
      pid: process.pid, version, wallpaper: this.wallpaper, load: this.load.summary(), control: this.controlGeneration, handled: this.handledRequests, monitors,
      visualizer: this.visualizers.summary(), screensaver: this.screensaver.summary()
    });
    await fs.rename(temporary, file);
  }

  async stop() {
    if (this.stopping) {
      return this.stopped;
    }
    this.stopping = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.configTimer);
    this.configWatcher?.close();
    this.importWatcher.stop();
    this.outputWatcher?.stop();
    this.outputWatcher = null;
    await this.reconciling;

    await this.screensaver.leave();
    await this.bounce.stop();
    await this.smoothing.stop();
    await this.visualizers.stop();
    await Promise.all([...this.screens.values()].map(screen => this.stopScreen(screen)));
    this.screens.clear();
    this.monitors.clear();
    await this.importing;
    try {
      this.load.clear();
    } catch (error) {
      this.logger.warn('Failed to clear the load hold', { error: error.message });
    }
    await fs.remove(statePath(this.runtimeDir));
    await fs.remove(nextFiltersPath(this.runtimeDir));
    await this.controls.clear();
    this.children.remove();

    this.logger.info('Daemon stopped');
    this.resolveStopped?.();
  }

  async stopScreen({ child, client, socketPath, monitor, firstFileTimer }) {
    clearTimeout(firstFileTimer);
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once('exit', resolve));

    try {
      await client?.command('quit');
    } catch {
      // mpv may already be gone
    }
    client?.close();

    // xwinwrap does not always exit with its child, so signal the whole process group
    this.killGroup(child, 'SIGTERM');
    const timedOut = await Promise.race([exited.then(() => false), sleep(this.stopGrace).then(() => true)]);
    if (timedOut) {
      this.killGroup(child, 'SIGKILL');
    }

    await fs.remove(socketPath);
    // The playlist file daemons before 2.42.0 wrote for loadlist
    await fs.remove(path.join(this.runtimeDir, `${monitor.name}.m3u`));
  }

  killGroup(child, signal) {
    try {
      this.kill(-child.pid, signal);
    } catch {
      // already exited
    }
  }

  // Applies saved changes to the config file without a restart (see applyConfigChange). The directory is
  // watched rather than the file, since editors often save by renaming a new file over it; changes are read
  // once the file has been quiet for configSettle.
  watchConfig() {
    return this.configChanges.watch();
  }

  // Applies a saved config file. The whole file is loaded and checked again first: a file that no longer
  // parses, a value that does not check out, or a visualizer section that does not, keeps every running
  // setting and is announced with a desktop notification, since nobody is at a prompt to see it. Then the
  // visualizer restarts when its section changed, and every other changed setting is applied by its kind
  // (LIVE_SETTINGS); ones a running mpv cannot take are announced as needing a restart.
  applyConfigChange() {
    return this.configChanges.apply();
  }

  // Takes the changed settings outside the visualizer section from a checked config and applies each by its
  // kind; returns the keys applied and the ones that need a restart
  applySettings(next) {
    return this.configChanges.applySettings(next);
  }

  // Unknown keys a save added, announced once each: nobody is at a prompt to see the CLI's warnings
  reportConfigWarnings(previous) {
    return this.configChanges.reportWarnings(previous);
  }

  // SIGHUP (`backdrop visualizer reload`): re-reads the visualizer section and restarts only the
  // visualizer. A config file that no longer parses keeps the running visualizer and logs why.
  reloadVisualizer() {
    return this.configChanges.reloadVisualizer();
  }

  // An uncaught error or rejection: stops the children, giving up after a bounded wait, then exits 1
  async crash(error, exit = process.exit) {
    this.logger.error('Daemon crashed, stopping', { error: error?.message ?? String(error), stack: error?.stack });
    await Promise.race([this.stop().catch(() => {}), sleep(this.stopGrace * 2 + 1000)]);
    exit(1);
  }

  // Signal handlers run one at a time
  enqueue(task) {
    this.queue = this.queue.then(task).catch(error => this.logger.error('Daemon request failed', { error: error.message }));
    return this.queue;
  }

  // Runs until SIGINT/SIGTERM, or until a control request leaves nothing on. An uncaught error stops
  // the wallpapers and visualizers before the process exits, rather than leaving them running.
  async run(options) {
    await this.start(options);
    const shutdown = () => this.stop();
    const crash = error => this.crash(error);
    process.once('uncaughtException', crash);
    process.once('unhandledRejection', crash);
    const reload = () => this.enqueue(() => this.reloadVisualizer());
    const control = () => this.enqueue(() => this.applyControl());
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.on('SIGHUP', reload);
    process.on('SIGUSR1', control);
    await this.stopped;
    process.off('SIGHUP', reload);
    process.off('SIGUSR1', control);
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
  }
}
