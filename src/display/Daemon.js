import { spawn as spawnProcess } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs-extra';
import path from 'path';
import { MpvClient } from './MpvClient.js';
import { listMonitors, selectMonitors, geometry, run } from './Monitors.js';
import { getMode, lastMediaKey, loadPlaylist, appendToPlaylist, modeOfKind, removeFailedEntry } from './Playlist.js';
import { Importer } from '../library/Importer.js';
import { purgeTrash } from '../library/purge.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1000;
const STOP_GRACE_MS = 2000;
// An mpv that misses this many IPC health checks in a row is killed and restarted
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_FAILURES = 2;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The startup import logs how far it is at most this often
const IMPORT_PROGRESS_MS = 30_000;

const { version } = createRequire(import.meta.url)('../../package.json');
// sockaddr_un.sun_path is 108 bytes including the terminating NUL
const MAX_SOCKET_PATH = 107;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function statePath(runtimeDir) {
  return path.join(runtimeDir, 'state.json');
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
    importer = new Importer({ config, database, logger }),
    purge = () => purgeTrash({ config, database, logger })
  }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.spawn = spawn;
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
    this.purge = purge;
    this.timers = [];
    this.screens = new Map();
    this.stopping = false;
    this.stopped = null;
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  async start() {
    const existing = await readState(this.runtimeDir);
    if (existing) {
      throw new Error(`backdrop daemon already running (pid ${existing.pid})`);
    }

    const { display } = this.config.get();
    const monitors = selectMonitors(await listMonitors(this.exec), display.monitors);
    if (!monitors.length) {
      throw new Error('No active monitors found');
    }

    await fs.ensureDir(this.runtimeDir, 0o700);
    this.stopped = new Promise(resolve => { this.resolveStopped = resolve; });

    try {
      for (const monitor of monitors) {
        await this.startScreen(monitor);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }

    await this.writeState();
    this.logger.info('Daemon started', { version, pid: process.pid, monitors: monitors.map(m => m.name) });

    // Playback starts from the existing library; new imports are appended as they finish
    this.importing = this.importDirs(monitors[0]);

    // An interval of 0 turns the timer off (tests drive these directly)
    this.runPurge();
    this.every(this.purgeInterval, () => this.runPurge());
    this.every(this.healthInterval, () => this.checkHealth());
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
  // and handleExit restarts it within the usual restart budget
  async checkHealth() {
    await Promise.all([...this.screens.values()].map(async screen => {
      if (this.stopping || screen.checking || screen.child.exitCode !== null || screen.child.signalCode !== null) {
        return;
      }
      screen.checking = true;
      try {
        await screen.client.getProperty('pid');
        screen.healthFailures = 0;
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

  async importDirs(monitor) {
    const dirs = this.config.get().library.import_dirs;
    if (!dirs.length) {
      return;
    }

    try {
      let total = 0;
      let lastReport = Date.now();
      const { imported } = await this.importer.importDirs(dirs, {
        resolution: `${monitor.width}x${monitor.height}`,
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
      }
    });
    screen.client.on('end-file', event => {
      if (event.reason === 'error') {
        // Serialized so concurrent failures do not remove entries by stale indexes
        screen.failing = screen.failing.then(() => this.onLoadFailed(screen, event));
      }
    });
    await screen.client.observeProperty(1, 'path');

    const count = await loadPlaylist(screen.client, {
      database: this.database,
      config: this.config.get(),
      mode: getMode(this.database),
      monitor,
      runtimeDir: this.runtimeDir
    });
    if (!count) {
      this.logger.warn('No media to show', { monitor: monitor.name, mode: getMode(this.database) });
    }
  }

  // Applies the stored speed and remembers the item so a restart resumes it
  async onFileLoaded(screen, filePath) {
    const media = this.database.getMediaByPath(filePath);
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
    if (this.stopping) {
      return;
    }
    try {
      await this.startScreen(screen.monitor);
      await this.writeState();
    } catch (error) {
      this.logger.error('Failed to restart monitor', { monitor: screen.monitor.name, error: error.message });
    }
  }

  async writeState() {
    const monitors = [...this.screens.values()].map(({ monitor, socketPath }) => ({ ...monitor, socket: socketPath }));
    await fs.writeJson(statePath(this.runtimeDir), { pid: process.pid, monitors });
  }

  async stop() {
    if (this.stopping) {
      return this.stopped;
    }
    this.stopping = true;
    this.timers.forEach(clearInterval);
    this.timers = [];

    await Promise.all([...this.screens.values()].map(screen => this.stopScreen(screen)));
    this.screens.clear();
    await this.importing;
    await fs.remove(statePath(this.runtimeDir));

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

  // Runs until SIGINT/SIGTERM
  async run() {
    await this.start();
    const shutdown = () => this.stop();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await this.stopped;
  }
}
