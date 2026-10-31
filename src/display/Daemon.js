import { spawn as spawnProcess } from 'child_process';
import { watch as watchFiles } from 'fs';
import { createRequire } from 'module';
import fs from 'fs-extra';
import path from 'path';
import { MpvClient } from './MpvClient.js';
import { listMonitors, selectMonitors, missingMonitors, geometry, run } from './Monitors.js';
import {
  getMode, lastMediaKey, loadPlaylist, appendToPlaylist, modeOfKind, removeFailedEntry, brightnessFor, reshuffleOnWrap,
  playbackLimits, validVideoDuration
} from './Playlist.js';
import { Importer } from '../library/Importer.js';
import { purgeTrash } from '../library/purge.js';
import { thumbnailFor } from '../library/thumbnail.js';
import { notifyError, notifyMode, notifyPlaying } from '../utils/notify.js';
import { VisualizerManager } from '../visualizer/VisualizerManager.js';
import { visualizerSettings } from '../visualizer/settings.js';
import { ChildRegistry, processStart, reapOrphans } from './children.js';
import { readCpuSeconds, isSoftwareDecoder, isLargeVideo, cpuPercent, RECENT_SAMPLES } from './cpu.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1000;
const STOP_GRACE_MS = 2000;
// An mpv that misses this many IPC health checks in a row is killed and restarted
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_FAILURES = 2;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Monitor layout changes (hotplug, xrandr) are picked up this often
const MONITOR_POLL_MS = 5000;
// The startup import logs how far it is at most this often
const IMPORT_PROGRESS_MS = 30_000;

const { version } = createRequire(import.meta.url)('../../package.json');
// sockaddr_un.sun_path is 108 bytes including the terminating NUL
const MAX_SOCKET_PATH = 107;

// Quiet time after the last change to the config file before it is read; editors write a file in steps
const CONFIG_SETTLE_MS = 300;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function statePath(runtimeDir) {
  return path.join(runtimeDir, 'state.json');
}

// What `backdrop start/stop --wallpaper/--visualizer` asks a running daemon to change (see applyControl)
export function controlPath(runtimeDir) {
  return path.join(runtimeDir, 'control.json');
}

// Filters for next that last as long as this daemon (see nextFilters.js); removed when it starts and stops
export function nextFiltersPath(runtimeDir) {
  return path.join(runtimeDir, 'next-filters.json');
}

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
      '--really-quiet',
      '--framedrop=vo',
      '--panscan=1.0',
      '--hwdec=auto-safe',
      ...display.mpv_args
    ]
  };
}

export class Daemon {
  constructor({
    config, database, logger,
    spawn = spawnProcess, exec = run, connect = MpvClient.connect, kill = process.kill,
    restartDelay = RESTART_DELAY_MS, stopGrace = STOP_GRACE_MS,
    healthInterval = HEALTH_INTERVAL_MS, purgeInterval = PURGE_INTERVAL_MS, importProgressInterval = IMPORT_PROGRESS_MS,
    monitorInterval = MONITOR_POLL_MS, now = Date.now, readFile,
    importer = new Importer({ config, database, logger }),
    purge = () => purgeTrash({ config, database, logger }),
    thumbnail = media => thumbnailFor(media, config.get().paths.thumbnails, { logger, nice: true }),
    visualizers, reloadConfig = () => config.reloadSection('visualizer'),
    watch = watchFiles, configSettle = CONFIG_SETTLE_MS,
    readStart = processStart, reap = runtimeDir => reapOrphans(runtimeDir, { kill, logger })
  }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    // Every child is recorded in children.json, so a start after a crash can end the ones left running
    this.children = new ChildRegistry({ runtimeDir: () => this.runtimeDir, readStart });
    this.spawn = this.children.track(spawn);
    this.reap = reap;
    this.exec = exec;
    this.connect = connect;
    this.kill = kill;
    this.restartDelay = restartDelay;
    this.stopGrace = stopGrace;
    this.importer = importer;
    this.importing = Promise.resolve();
    this.healthInterval = healthInterval;
    this.purgeInterval = purgeInterval;
    this.importProgressInterval = importProgressInterval;
    this.monitorInterval = monitorInterval;
    this.now = now;
    this.readFile = readFile;
    // Items already warned about for software decoding during this run
    this.softwareWarned = new Set();
    this.reconciling = null;
    this.purge = purge;
    this.thumbnail = thumbnail;
    this.timers = [];
    // Active monitors by name; screens holds their wallpaper processes, empty while the wallpaper is off
    this.monitors = new Map();
    this.screens = new Map();
    this.wallpaper = true;
    // Counts control requests applied, so the CLI can tell when its request has been
    this.controlGeneration = 0;
    // --image-duration/--video-duration from next or menu (next-filters.json), over display.* until cleared
    this.durations = {};
    this.queue = Promise.resolve();
    this.visualizers = visualizers ?? new VisualizerManager({
      config, logger, monitors: this.monitors, screens: this.screens, spawn: this.spawn, kill, exec, restartDelay, stopGrace, now
    });
    this.reloadConfig = reloadConfig;
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
    await fs.remove(controlPath(this.runtimeDir));
    this.stopped = new Promise(resolve => { this.resolveStopped = resolve; });
    this.wallpaper = wallpaper;
    this.visualizers.override = visualizer;

    try {
      for (const monitor of monitors) {
        this.monitors.set(monitor.name, monitor);
        if (this.wallpaper) await this.startScreen(monitor);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }

    await this.visualizers.configure();
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

    // An interval of 0 turns the timer off (tests drive these directly)
    this.runPurge();
    this.every(this.purgeInterval, () => this.runPurge());
    this.every(this.healthInterval, () => this.checkHealth());
    this.every(this.monitorInterval, () => this.checkMonitors());
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

  async reconcileMonitors() {
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
      if (this.wallpaper && !await this.startWallpaper(monitor)) {
        // Left out so the next poll tries again
        this.monitors.delete(monitor.name);
      }
      changed = true;
    }
    if (changed && !this.stopping) {
      await this.visualizers.sync();
      await this.writeState();
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
  async setWallpaper(on) {
    if (on === this.wallpaper || this.stopping) return;
    this.wallpaper = on;
    if (on) {
      for (const monitor of [...this.monitors.values()]) {
        if (!this.screens.has(monitor.name)) await this.startWallpaper(monitor);
      }
      await this.visualizers.restackAll();
    } else {
      const screens = [...this.screens.values()];
      this.screens.clear();
      await Promise.all(screens.map(screen => this.stopScreen(screen)));
    }
    this.logger.info(on ? 'Wallpaper on' : 'Wallpaper off');
  }

  // SIGUSR1: applies control.json ({ pid, wallpaper, visualizer, durations, preset }, each optional), written by
  // the CLI for this daemon's pid. With neither part left on, the daemon stops.
  async applyControl() {
    if (this.stopping) return;
    let request = {};
    try {
      const { pid, ...rest } = await fs.readJson(controlPath(this.runtimeDir));
      if (pid === process.pid) request = rest;
      await fs.remove(controlPath(this.runtimeDir));
    } catch {
      // No request: the generation still moves so the CLI does not wait for nothing
    }
    if (typeof request.wallpaper === 'boolean') await this.setWallpaper(request.wallpaper);
    if (request.durations) await this.applyDurations();
    if (request.preset !== undefined) {
      await this.visualizers.setPreset(request.preset);
      this.logger.info('Visualizer preset', this.visualizers.summary());
    }
    if (typeof request.visualizer === 'boolean') {
      await this.visualizers.setEnabled(request.visualizer);
      this.logger.info(request.visualizer ? 'Visualizer on' : 'Visualizer off', this.visualizers.summary());
    }
    this.controlGeneration++;
    if (!this.wallpaper && !this.visualizers.active) {
      this.logger.info('Wallpaper and visualizer are off, stopping');
      await this.stop();
      return;
    }
    await this.writeState();
  }

  imageDuration() {
    return this.durations.image_duration ?? this.config.get().display.image_duration;
  }

  videoDuration() {
    return validVideoDuration(this.durations.video_duration ?? this.config.get().display.video_duration ?? 0);
  }

  // Re-reads the durations next and the menu stored and applies them to what plays now: the image's
  // display time, and the video's end, counted from when it started
  async applyDurations() {
    try {
      const { pid, image_duration: image, video_duration: video } = await fs.readJson(nextFiltersPath(this.runtimeDir));
      this.durations = pid === process.pid ? Object.fromEntries(Object.entries({ image_duration: image, video_duration: video })
        .filter(([, value]) => value !== undefined)) : {};
    } catch {
      this.durations = {};
    }
    this.logger.info('Durations', { image: this.imageDuration(), video: this.videoDuration() });
    for (const screen of [...this.screens.values()]) {
      try {
        await screen.client.setProperty('image-display-duration', this.imageDuration());
      } catch (error) {
        this.logger.warn('Failed to set image duration', { monitor: screen.monitor.name, error: error.message });
      }
      if (screen.media) await this.applyLimits(screen, screen.media, { elapsed: (this.now() - (screen.loadedAt ?? this.now())) / 1000 });
    }
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
  async checkHealth() {
    await Promise.all([...this.screens.values()].map(async screen => {
      if (this.stopping || screen.checking || screen.child.exitCode !== null || screen.child.signalCode !== null) {
        return;
      }
      screen.checking = true;
      try {
        const pid = await screen.client.getProperty('pid');
        screen.healthFailures = 0;
        await this.sample(screen, pid);
      } catch (error) {
        screen.healthFailures = (screen.healthFailures ?? 0) + 1;
        this.logger.warn('mpv health check failed', { monitor: screen.monitor.name, failures: screen.healthFailures, error: error.message });
        if (screen.healthFailures >= HEALTH_FAILURES && !this.stopping) {
          this.logger.error('mpv is not responding, restarting', { monitor: screen.monitor.name });
          this.killGroup(screen.child, 'SIGKILL');
        }
      } finally {
        screen.checking = false;
      }
    }));
  }

  // Measures the CPU mpv used since the previous sample. The interval counts toward the playing item only
  // if that item played through all of it, so a switch never charges one item for another's decoding.
  async sample(screen, pid) {
    let cpu;
    try {
      cpu = await readCpuSeconds(pid, this.readFile);
    } catch (error) {
      this.logger.debug('Cannot read mpv CPU time', { monitor: screen.monitor.name, error: error.message });
      return;
    }
    const at = this.now();
    const last = screen.sample;
    screen.sample = { pid, cpu, at, media: screen.media };
    if (last?.pid === pid && at > last.at && cpu >= last.cpu) {
      const seconds = (at - last.at) / 1000;
      const cpuSeconds = cpu - last.cpu;
      screen.recent = [...(screen.recent ?? []), { seconds, cpuSeconds }].slice(-RECENT_SAMPLES);
      if (screen.media && screen.media === last.media && screen.loadedAt <= last.at) {
        try {
          this.database.addPlaybackSample(screen.media.id, seconds, cpuSeconds);
        } catch (error) {
          this.logger.warn('Failed to record playback cost', { mediaId: screen.media.id, error: error.message });
        }
      }
    }
    await this.recordDecoder(screen);
    await this.writeState().catch(error => this.logger.warn('Failed to write state', { error: error.message }));
  }

  // mpv reports the decoder only once a file is open, and observed properties only fire on changes,
  // so the decoder is read on each sample rather than on load
  async recordDecoder(screen) {
    const { media } = screen;
    if (!media || modeOfKind(media.kind) !== 'video') {
      screen.hwdec = null;
      return;
    }
    let hwdec;
    try {
      hwdec = await screen.client.getProperty('hwdec-current');
    } catch {
      return;
    }
    screen.hwdec = hwdec || 'no';
    try {
      this.database.setDecoder(media.id, screen.hwdec);
    } catch (error) {
      this.logger.warn('Failed to record decoder', { mediaId: media.id, error: error.message });
    }
    if (isSoftwareDecoder(hwdec) && isLargeVideo(media) && !this.softwareWarned.has(media.id)) {
      this.softwareWarned.add(media.id);
      this.logger.warn('Video above 1080p is decoded in software', {
        monitor: screen.monitor.name, mediaId: media.id, size: `${media.width}x${media.height}`, path: media.path
      });
    }
  }

  async importDirs(monitor) {
    const dirs = this.config.get().library.import_dirs;
    if (!dirs.length) {
      return;
    }

    try {
      let total = 0;
      let lastReport = Date.now();
      const { imported } = await this.importer.importDirs(dirs, {
        resolution: monitor ? `${monitor.width}x${monitor.height}` : null,
        shouldStop: () => this.stopping,
        onStart: count => {
          total = count;
          this.logger.info('Import started', { files: total });
        },
        onFile: (file, outcome, done) => {
          if (Date.now() - lastReport >= this.importProgressInterval && done < total) {
            lastReport = Date.now();
            this.logger.info('Import progress', { done, total });
          }
        }
      });
      if (!imported.length || this.stopping) {
        return;
      }

      const mode = getMode(this.database);
      for (const screen of this.screens.values()) {
        const added = await appendToPlaylist(screen.client, {
          database: this.database, config: this.config.get(), mode, monitor: screen.monitor, mediaIds: imported
        });
        this.logger.info('Added imported media to playlist', { monitor: screen.monitor.name, added });
      }
    } catch (error) {
      this.logger.error('Import on startup failed', { error: error.message });
    }
  }

  async startScreen(monitor) {
    const socketPath = path.join(this.runtimeDir, `${monitor.name}.sock`);
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
      throw new Error(`Socket path is longer than ${MAX_SOCKET_PATH} bytes, shorten paths.runtime: ${socketPath}`);
    }
    await fs.remove(socketPath);

    const { file, args } = buildCommand(monitor, socketPath, this.config.get().display);
    const child = this.spawn(file, args, { detached: true, stdio: 'ignore' });

    const previous = this.screens.get(monitor.name);
    const screen = { monitor, socketPath, child, client: null, restarts: previous?.restarts ?? [], failing: Promise.resolve() };
    this.screens.set(monitor.name, screen);

    child.on('error', error => this.logger.error('Failed to launch xwinwrap', { monitor: monitor.name, error: error.message }));
    child.on('exit', (code, signal) => this.handleExit(screen, code, signal));

    screen.client = await this.connect(socketPath, { attempts: 50, delay: 100 });
    screen.client.on('error', error => this.logger.warn('mpv socket error', { monitor: monitor.name, error: error.message }));
    screen.client.on('property-change', event => {
      if (event.name === 'path' && event.data) {
        this.onFileLoaded(screen, event.data);
      } else if (event.name === 'container-fps' && event.data) {
        this.onFrameRate(screen, event.data);
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

    const count = await loadPlaylist(screen.client, {
      database: this.database,
      config: this.config.get(),
      mode: getMode(this.database),
      monitor,
      runtimeDir: this.runtimeDir,
      imageDuration: this.imageDuration()
    });
    if (!count) {
      this.logger.warn('No media to show', { monitor: monitor.name, mode: getMode(this.database) });
    }
  }

  // Applies the stored speed and dim and remembers the item so a restart resumes it.
  // Brightness is set on every load because mpv keeps it from the previous file.
  async onFileLoaded(screen, filePath) {
    const media = this.database.getMediaByPath(filePath);
    screen.media = media;
    screen.loadedAt = this.now();
    try {
      await screen.client.setProperty('brightness', brightnessFor(media?.dim ?? 0));
    } catch (error) {
      this.logger.warn('Failed to set brightness', { monitor: screen.monitor.name, error: error.message });
    }
    try {
      screen.entryId = await reshuffleOnWrap(screen.client, screen.entryId);
    } catch (error) {
      this.logger.warn('Failed to reshuffle playlist', { monitor: screen.monitor.name, error: error.message });
    }
    await this.applyLimits(screen, media);
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
    this.prefetchThumbnails(screen, media);
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
      const upcoming = next && this.database.getMediaByPath(next.filename);
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
    await notifyPlaying(this.database, { monitor: screen.monitor, media, rating }, { logger: this.logger });
  }

  // Ends videos after the video duration (display.video_duration, or one next or the menu set). A file outside the library loops in video mode as before.
  // elapsed: seconds the item has played, when the duration changes while it plays
  async applyLimits(screen, media, { elapsed = 0 } = {}) {
    try {
      const timeout = this.videoDuration();
      const limits = media || getMode(this.database) !== 'video' ? playbackLimits(media, timeout, elapsed) : { 'loop-file': 'inf', end: 'none' };
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
    if (this.stopping || this.screens.get(screen.monitor.name) !== screen) {
      return;
    }

    const now = Date.now();
    screen.restarts = screen.restarts.filter(time => now - time < RESTART_WINDOW_MS);
    if (screen.restarts.length >= MAX_RESTARTS) {
      this.logger.error('mpv keeps exiting, giving up on monitor', { monitor: screen.monitor.name, code, signal });
      return;
    }
    screen.restarts.push(now);

    this.logger.warn('mpv exited, restarting', { monitor: screen.monitor.name, code, signal });
    await sleep(this.restartDelay);
    // Hotplug may have removed or replaced the monitor during the delay
    if (this.stopping || this.screens.get(screen.monitor.name) !== screen) {
      return;
    }
    try {
      await this.startScreen(screen.monitor);
      // Keeps the visualizer above the new wallpaper window
      this.visualizers.restack(screen.monitor.name);
      await this.writeState();
    } catch (error) {
      this.logger.error('Failed to restart monitor', { monitor: screen.monitor.name, error: error.message });
    }
  }

  // Written to a temporary file and renamed, so a CLI command never reads a half-written state.
  // cpu is the monitor's recent average (percent of one core), null until two samples were taken.
  async writeState() {
    // A sample finishing during shutdown must not recreate the state file stop() removes
    if (this.stopping) return;
    const monitors = [...this.monitors.values()].map(monitor => {
      const { socketPath = null, recent = [], hwdec = null } = this.screens.get(monitor.name) ?? {};
      return {
        ...monitor,
        // null while the wallpaper is off: CLI commands that need mpv say so
        socket: socketPath,
        cpu: cpuPercent(recent.reduce((sum, item) => sum + item.cpuSeconds, 0), recent.reduce((sum, item) => sum + item.seconds, 0)),
        hwdec,
        // Every instance on the monitor, and the first as visualizer for readers of 2.20.0-2.24.0 state
        visualizers: this.visualizers.describe(monitor.name),
        visualizer: this.visualizers.describe(monitor.name)[0] ?? null
      };
    });
    const file = statePath(this.runtimeDir);
    const temporary = `${file}.${process.pid}.tmp`;
    // version tells the CLI this daemon reloads the visualizer on SIGHUP, and control that it applies
    // control.json on SIGUSR1, rather than dying from either signal
    await fs.writeJson(temporary, {
      pid: process.pid, version, wallpaper: this.wallpaper, control: this.controlGeneration, monitors,
      visualizer: this.visualizers.summary()
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
    await this.reconciling;

    await this.visualizers.stop();
    await Promise.all([...this.screens.values()].map(screen => this.stopScreen(screen)));
    this.screens.clear();
    this.monitors.clear();
    await this.importing;
    await fs.remove(statePath(this.runtimeDir));
    await fs.remove(nextFiltersPath(this.runtimeDir));
    await fs.remove(controlPath(this.runtimeDir));
    this.children.remove();

    this.logger.info('Daemon stopped');
    this.resolveStopped?.();
  }

  async stopScreen({ child, client, socketPath, monitor }) {
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
    await fs.remove(path.join(this.runtimeDir, `${monitor.name}.m3u`));
  }

  killGroup(child, signal) {
    try {
      this.kill(-child.pid, signal);
    } catch {
      // already exited
    }
  }

  // Applies saved changes to the config file's visualizer section without `backdrop visualizer reload`.
  // The directory is watched rather than the file, since editors often save by renaming a new file over
  // it; changes are read once the file has been quiet for configSettle.
  watchConfig() {
    const file = this.config.configPath;
    if (!this.watch || !file) return;
    try {
      this.configWatcher = this.watch(path.dirname(file), (event, name) => {
        if (name && name !== path.basename(file)) return;
        clearTimeout(this.configTimer);
        this.configTimer = setTimeout(() => this.enqueue(() => this.applyConfigChange()), this.configSettle);
      });
      this.configWatcher.on('error', error => this.logger.warn('Config watch failed', { error: error.message }));
    } catch (error) {
      this.logger.warn('Not watching the config file; use `backdrop visualizer reload`', { file, error: error.message });
    }
  }

  // Restarts the visualizer when its section changed. A file that no longer parses, or a visualizer value
  // that does not check out, keeps the running visualizer and its settings, and is announced with a
  // desktop notification, since nobody is at a prompt to see it.
  async applyConfigChange() {
    if (this.stopping) return;
    const settings = this.config.get();
    const previous = { section: settings.visualizer, user: this.config.userConfig?.visualizer, warnings: this.config.warnings ?? [] };
    try {
      await this.reloadConfig();
      visualizerSettings(settings.visualizer);
    } catch (error) {
      settings.visualizer = previous.section;
      if (this.config.userConfig) this.config.userConfig.visualizer = previous.user;
      this.logger.error('Config change not applied, keeping the running visualizer', { error: error.message });
      await notifyError(`Config not applied: ${error.message}`, { logger: this.logger });
      return;
    }
    await this.reportConfigWarnings(previous.warnings);
    if (JSON.stringify(settings.visualizer) === JSON.stringify(previous.section)) return;
    await this.visualizers.reload();
    await this.writeState();
    this.logger.info('Visualizer reloaded after a config change', this.visualizers.summary());
    // Problems only found when starting it, such as missing GLava shaders
    if (this.visualizers.error) {
      await notifyError(`Visualizer off: ${this.visualizers.error}`, { logger: this.logger });
    }
  }

  // Unknown keys a save added, announced once each: nobody is at a prompt to see the CLI's warnings
  async reportConfigWarnings(previous) {
    const added = (this.config.warnings ?? []).filter(warning => !previous.includes(warning));
    if (!added.length) return;
    this.logger.warn('Unknown config keys', { warnings: added });
    await notifyError(added.join('\n'), { logger: this.logger });
  }

  // SIGHUP (`backdrop visualizer reload`): re-reads the visualizer section and restarts only the
  // visualizer. A config file that no longer parses keeps the running visualizer and logs why.
  async reloadVisualizer() {
    if (this.stopping) return;
    try {
      await this.reloadConfig();
    } catch (error) {
      this.logger.error('Visualizer reload failed, keeping the running one', { error: error.message });
      return;
    }
    await this.visualizers.reload();
    await this.writeState();
    this.logger.info('Visualizer reloaded', this.visualizers.summary());
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
