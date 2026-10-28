import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Daemon, readState } from '../display/Daemon.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { getMode, eligibleMedia } from '../display/Playlist.js';
import { out, fmt, icon, displayPath, describeMedia, formatResolution } from '../utils/output.js';
import { printMedia } from '../utils/mediaView.js';

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
      out.info(`Already running (pid ${running.pid})`);
      return;
    }

    const child = spawn(process.execPath, [ENTRY_POINT, 'daemon'], { detached: true, stdio: 'ignore' });
    child.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await readState(this.runtimeDir);
      if (state) {
        out.success(`Started (pid ${state.pid}) on ${state.monitors.map(m => m.name).join(', ')}`);
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
      out.info('Not running');
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
    out.success('Stopped');
  }

  async status() {
    const state = await readState(this.runtimeDir);
    out.row('Mode', fmt.cyan(getMode(this.database)));
    if (!state) {
      out.row('Daemon', fmt.yellow('not running'));
      return;
    }

    out.row('Daemon', `${fmt.green('running')} ${fmt.dim(`(pid ${state.pid})`)}`);
    const mode = getMode(this.database);
    const { allow_upscale: allowUpscale } = this.config.get().display;
    for (const monitor of state.monitors) {
      const { path, media } = await this.control.current(monitor.name).catch(() => ({}));
      const eligible = eligibleMedia(this.database, mode, monitor, { allowUpscale }).length;
      out.print(`  ${icon('monitor')}${fmt.bold(monitor.name)} ${fmt.dim(`${formatResolution(monitor.width, monitor.height)}, ${eligible} ${mode}s eligible`)}`);
      if (!path) {
        out.field('info', fmt.yellow('nothing playing'));
        out.detail(this.blankReason(mode, monitor, eligible, allowUpscale));
        continue;
      }
      if (media) out.field(media.kind, `${fmt.bold(`#${media.id}`)}  ${describeMedia(media)}${this.adjustments(media)}`);
      out.field('path', displayPath(path));
    }
  }

  adjustments(media) {
    const list = [media.speed !== 1 && `speed ${media.speed}`, media.dim && `dim ${media.dim}`].filter(Boolean);
    return list.length ? fmt.dim(`  ${list.join(', ')}`) : '';
  }

  // Why a monitor shows nothing, with the likely fix
  blankReason(mode, monitor, eligible, allowUpscale) {
    if (eligible) {
      return `${eligible} ${mode}s fit but none loaded; check the log for unplayable files, or run \`backdrop mode ${mode}\` to reload`;
    }
    if (allowUpscale) {
      return `No ${mode}s in the library; import or download some, or switch with \`backdrop mode\``;
    }
    return `No ${mode}s at least ${monitor.width}x${monitor.height}; download for this size, `
      + 'switch with `backdrop mode`, or set display.allow_upscale';
  }

  async current(options) {
    const { monitor, path, media, rating } = await this.control.current(options.monitor);
    if (!path) {
      out.info(`${monitor.name}: nothing playing`);
      return;
    }

    // The first line stays the bare path (full when piped) for scripts
    out.print(displayPath(path));
    if (media) printMedia(this.database, media, { rating, path: false, extra: [this.adjustments(media)] });
  }

  async next(options) {
    await this.control.next(options.monitor);
  }

  async prev(options) {
    await this.control.prev(options.monitor);
  }

  async speed(value, options) {
    const { monitor, speed } = await this.control.speed(value, options.monitor);
    out.print(`${monitor.name}: speed ${fmt.cyan(speed)}`);
  }

  async dim(value, options) {
    const { monitor, dim } = await this.control.dim(value, options.monitor);
    out.print(`${monitor.name}: dim ${fmt.cyan(dim)}`);
  }

  async mode(requested) {
    const { mode, running, counts } = await this.control.mode(requested);
    out.row('Mode', fmt.cyan(mode));
    if (running) {
      for (const [name, count] of Object.entries(counts)) {
        out.print(`  ${fmt.bold(name)}: ${count ? `${count} items` : fmt.yellow(`no ${mode}s at this resolution`)}`);
      }
    }
  }
}
