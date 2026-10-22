import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { Daemon, readState } from '../display/Daemon.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { getMode } from '../display/Playlist.js';

const ENTRY_POINT = fileURLToPath(new URL('../index.js', import.meta.url));
const START_TIMEOUT_MS = 15_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DisplayCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.control = new DisplayControl({ config, database });
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  // Foreground daemon, for i3 `exec` or a systemd user unit
  async daemon() {
    this.logger.enableConsole();
    await new Daemon({ config: this.config, database: this.database, logger: this.logger }).run();
  }

  async start() {
    const running = await readState(this.runtimeDir);
    if (running) {
      console.log(chalk.yellow(`Already running (pid ${running.pid})`));
      return;
    }

    const child = spawn(process.execPath, [ENTRY_POINT, 'daemon'], { detached: true, stdio: 'ignore' });
    child.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await readState(this.runtimeDir);
      if (state) {
        console.log(chalk.green(`Started (pid ${state.pid}) on ${state.monitors.map(m => m.name).join(', ')}`));
        return;
      }
      if (child.exitCode !== null) {
        break;
      }
      await sleep(200);
    }
    throw new Error(`Daemon did not start; see ${this.config.get().paths.logfile}`);
  }

  async stop() {
    const state = await readState(this.runtimeDir);
    if (!state) {
      console.log(chalk.yellow('Not running'));
      return;
    }

    process.kill(state.pid, 'SIGTERM');
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && await readState(this.runtimeDir)) {
      await sleep(200);
    }
    if (await readState(this.runtimeDir)) {
      throw new Error(`Daemon (pid ${state.pid}) did not stop`);
    }
    console.log(chalk.green('Stopped'));
  }

  async status() {
    const state = await readState(this.runtimeDir);
    console.log(`Mode: ${getMode(this.database)}`);
    if (!state) {
      console.log('Daemon: not running');
      return;
    }

    console.log(`Daemon: running (pid ${state.pid})`);
    for (const monitor of state.monitors) {
      const { path, media } = await this.control.current(monitor.name).catch(() => ({}));
      const playing = path ? `${path}${media ? ` (speed ${media.speed})` : ''}` : 'nothing playing';
      console.log(`  ${monitor.name} ${monitor.width}x${monitor.height}: ${playing}`);
    }
  }

  async current(options) {
    const { monitor, path, media, rating } = await this.control.current(options.monitor);
    if (!path) {
      console.log(`${monitor.name}: nothing playing`);
      return;
    }

    console.log(path);
    if (media) {
      const stars = rating ? (rating.rating === 0 ? 'skipped' : `${rating.rating}/3`) : 'unrated';
      console.log(chalk.gray(`#${media.id} ${media.kind} ${media.width}x${media.height} ${media.source} ${stars} speed ${media.speed}`));
    }
  }

  async next(options) {
    await this.control.next(options.monitor);
  }

  async prev(options) {
    await this.control.prev(options.monitor);
  }

  async speed(value, options) {
    const { monitor, speed } = await this.control.speed(value, options.monitor);
    console.log(`${monitor.name}: speed ${speed}`);
  }

  async mode(requested) {
    const { mode, running, counts } = await this.control.mode(requested);
    console.log(`Mode: ${mode}`);
    if (running) {
      for (const [name, count] of Object.entries(counts)) {
        console.log(`  ${name}: ${count ? `${count} items` : chalk.yellow(`no ${mode}s at this resolution`)}`);
      }
    }
  }
}
