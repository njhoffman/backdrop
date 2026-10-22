import { spawn as spawnProcess } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { MpvClient } from './MpvClient.js';
import { listMonitors, selectMonitors, geometry, run } from './Monitors.js';
import { getMode, lastMediaKey, loadPlaylist, appendToPlaylist, modeOfKind } from './Playlist.js';
import { Importer } from '../library/Importer.js';

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1000;
const STOP_GRACE_MS = 2000;
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
    importer = new Importer({ config, database, logger })
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
    this.logger.info('Daemon started', { pid: process.pid, monitors: monitors.map(m => m.name) });

    // Playback starts from the existing library; new imports are appended as they finish
    this.importing = this.importDirs(monitors[0]);
  }

  async importDirs(monitor) {
    const dirs = this.config.get().library.import_dirs;
    if (!dirs.length) {
      return;
    }

    try {
      const { imported } = await this.importer.importDirs(dirs, {
        resolution: `${monitor.width}x${monitor.height}`,
        shouldStop: () => this.stopping
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
    const screen = { monitor, socketPath, child, client: null, restarts: previous?.restarts ?? [] };
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
