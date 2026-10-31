import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Daemon, readState } from '../display/Daemon.js';
import { sendControl } from '../display/control.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { readNextFilters, resolveNextFilters } from '../display/nextFilters.js';
import { getMode, eligibleMedia, randomOrder } from '../display/Playlist.js';
import { matchFilters, matchingMedia } from '../library/match.js';
import { out, fmt, icon, displayPath, describeMedia, formatResolution, formatCpu, formatDecoder, formatSetting } from '../utils/output.js';
import {
  printMedia, printPlaying, formatMediaLine, formatMediaHeader, formatAdjustments, formatPlaybackCost, wantsJson, mediaJson, playingJson
} from '../utils/mediaView.js';
import { notifyCommand } from '../utils/notify.js';
import { visualizerSettings } from '../visualizer/settings.js';

const ENTRY_POINT = fileURLToPath(new URL('../index.js', import.meta.url));
const START_TIMEOUT_MS = 15_000;
// The parts of the daemon `start` and `stop` can address on their own
const PARTS = ['wallpaper', 'visualizer'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DisplayCommand {
  constructor(config, database, logger, { kill = process.kill, spawnProcess = spawn, timeout = START_TIMEOUT_MS } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.control = new DisplayControl({ config, database });
    this.kill = kill;
    this.spawnProcess = spawnProcess;
    this.timeout = timeout;
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  // Foreground daemon, for i3 `exec` or a systemd user unit. --no-wallpaper starts without wallpapers;
  // --visualizer/--no-visualizer override visualizer.enabled.
  async daemon(options = {}) {
    this.logger.enableConsole();
    await new Daemon({ config: this.config, database: this.database, logger: this.logger })
      .run({ wallpaper: options.wallpaper ?? true, visualizer: options.visualizer ?? null });
  }

  // The parts --wallpaper and --visualizer name, or null for the whole daemon
  parts(options) {
    const named = PARTS.filter(part => options[part]);
    return named.length ? named : null;
  }

  // Without flags, starts the daemon with the wallpaper and, if visualizer.enabled, the visualizer.
  // --wallpaper/--visualizer start only those parts, or turn them on in a running daemon.
  async start(options = {}) {
    const parts = this.parts(options);
    const running = await readState(this.runtimeDir);
    if (running) {
      if (!parts) out.info(`Already running (pid ${running.pid})`);
      else await this.request(running, Object.fromEntries(parts.map(part => [part, true])));
      return;
    }
    // Checked here so a mistake shows at the prompt rather than only in the daemon log
    if (parts?.includes('visualizer')) visualizerSettings(this.config.get().visualizer);

    const flags = parts
      ? [parts.includes('wallpaper') ? '--wallpaper' : '--no-wallpaper', parts.includes('visualizer') ? '--visualizer' : '--no-visualizer']
      : [];
    const child = this.spawnProcess(process.execPath, [ENTRY_POINT, 'daemon', ...flags], { detached: true, stdio: 'ignore' });
    child.unref();

    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const state = await readState(this.runtimeDir);
      if (state) {
        out.success(`Started (pid ${state.pid}) on ${state.monitors.map(m => m.name).join(', ')}: ${this.describeParts(state)}`);
        return;
      }
      if (child.exitCode !== null) {
        break;
      }
      await sleep(200);
    }
    throw new Error(`Daemon did not start; see ${this.config.get().paths.logfile}`);
  }

  // Without flags, stops the daemon. --wallpaper/--visualizer turn only those parts off; the daemon stops
  // itself when neither is left on.
  async stop(options = {}) {
    const state = await readState(this.runtimeDir);
    if (!state) {
      out.info('Not running');
      return;
    }
    const parts = this.parts(options);
    if (parts) {
      await this.request(state, Object.fromEntries(parts.map(part => [part, false])));
      return;
    }

    this.kill(state.pid, 'SIGTERM');
    await this.waitForExit(state.pid);
    out.success('Stopped');
  }

  async waitForExit(pid) {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline && await readState(this.runtimeDir)) {
      await sleep(100);
    }
    if (await readState(this.runtimeDir)) {
      throw new Error(`Daemon (pid ${pid}) did not stop`);
    }
  }

  // Asks the running daemon to switch parts on or off ({ wallpaper, visualizer }) and reports what is on
  // afterwards, or that it stopped because nothing was left on
  async request(state, change) {
    if (change.visualizer) visualizerSettings(this.config.get().visualizer);
    const current = await sendControl(this.runtimeDir, state, change, {
      kill: this.kill, timeout: this.timeout, logfile: this.config.get().paths.logfile
    });
    if (!current) {
      out.success('Stopped: the wallpaper and visualizer are both off');
      return;
    }
    if (change.visualizer && current.visualizer.error) throw new Error(`Visualizer off: ${current.visualizer.error}`);
    out.success(this.describeParts(current));
  }

  // e.g. "wallpaper on, visualizer off"
  describeParts(state) {
    const visualizer = state.visualizer?.enabled && !state.visualizer.error;
    return `wallpaper ${state.wallpaper === false ? 'off' : 'on'}, visualizer ${visualizer ? 'on' : 'off'}`;
  }

  async status(options = {}) {
    if (wantsJson(options)) {
      out.json(await this.statusJson());
      return;
    }
    const state = await readState(this.runtimeDir);
    out.row('Mode', fmt.cyan(getMode(this.database)));
    for (const warning of this.config.warnings ?? []) out.row('Config', fmt.yellow(warning));
    if (!state) {
      out.row('Daemon', fmt.yellow('not running'));
      return;
    }

    out.row('Daemon', `${fmt.green('running')} ${fmt.dim(`(pid ${state.pid}; ${this.describeParts(state)})`)}`);
    if (state.visualizer?.error) out.row('Visualizer', fmt.yellow(`off: ${state.visualizer.error}`));
    else if (state.visualizer?.enabled && (state.visualizer.preset || state.visualizer.silenced)) {
      out.row('Visualizer', [state.visualizer.preset && `preset ${state.visualizer.preset}`, state.visualizer.silenced && 'waiting for sound']
        .filter(Boolean).join(', '));
    }
    const next = this.describeNextFilters(await readNextFilters(this.runtimeDir));
    if (next) out.row('Next', `${next} ${fmt.dim('(next --clear to drop)')}`);
    if (!state.monitors.length) {
      out.field('info', fmt.yellow('waiting for the monitors in display.monitors to become active'));
      return;
    }
    const mode = getMode(this.database);
    const { allow_upscale: allowUpscale } = this.config.get().display;
    for (const monitor of state.monitors) {
      if (!monitor.socket) {
        out.field('info', fmt.yellow('wallpaper off (backdrop start --wallpaper)'));
        continue;
      }
      const { path, media } = await this.control.current(monitor.name).catch(() => ({}));
      const eligible = eligibleMedia(this.database, mode, monitor, { allowUpscale }).length;
      const details = [formatResolution(monitor.width, monitor.height), `${eligible} ${mode}s eligible`];
      // Recent average from the daemon's samples, once it has two
      if (Number.isFinite(monitor.cpu)) details.push(`cpu ${formatCpu(monitor.cpu)}${monitor.hwdec ? ` ${formatDecoder(monitor.hwdec)}` : ''}`);
      out.print(`  ${icon('monitor')}${fmt.bold(monitor.name)} ${fmt.dim(details.join(', '))}`);
      for (const item of monitor.visualizers ?? (monitor.visualizer ? [monitor.visualizer] : [])) out.field('info', this.describeVisualizer(item));
      if (!path) {
        out.field('info', fmt.yellow('nothing playing'));
        out.detail(this.blankReason(mode, monitor, eligible, allowUpscale));
        continue;
      }
      if (media) out.field(media.kind, `${fmt.bold(`#${media.id}`)}  ${describeMedia(media)}${this.adjustments(media)}`);
      out.field('path', displayPath(path));
    }
  }

  // status --json: cpu_percent and decoder are the daemon's recent samples, null until it has them
  async statusJson() {
    const state = await readState(this.runtimeDir);
    const mode = getMode(this.database);
    const { allow_upscale: allowUpscale } = this.config.get().display;
    const monitors = [];
    for (const monitor of state?.monitors ?? []) {
      const { media, rating } = await this.control.current(monitor.name).catch(() => ({}));
      monitors.push({
        name: monitor.name, width: monitor.width, height: monitor.height,
        eligible: eligibleMedia(this.database, mode, monitor, { allowUpscale }).length,
        cpu_percent: Number.isFinite(monitor.cpu) ? Math.round(monitor.cpu * 10) / 10 : null,
        decoder: formatDecoder(monitor.hwdec) || null,
        visualizer: monitor.visualizer ?? null,
        visualizers: monitor.visualizers ?? (monitor.visualizer ? [monitor.visualizer] : []),
        playing: media ? mediaJson(this.database, media, rating) : null
      });
    }
    const daemon = {
      running: Boolean(state), pid: state?.pid ?? null,
      wallpaper: state ? state.wallpaper !== false : null,
      visualizer: state ? Boolean(state.visualizer?.enabled && !state.visualizer.error) : null
    };
    return { mode, daemon, monitors, config_warnings: this.config.warnings ?? [] };
  }

  describeVisualizer({ instance, module, geometry, running }) {
    const name = instance && instance !== 'main' ? ` ${instance}` : '';
    return `visualizer${name} ${module} at ${geometry}${running ? '' : fmt.yellow(' (gave up after repeated exits; backdrop visualizer reload)')}`;
  }

  // Filters and order next keeps using, e.g. 'random, query "clouds", tags sky'
  describeNextFilters({ random, query, tag, keywords, image_duration: image, video_duration: video }) {
    const parts = [];
    if (random !== undefined) parts.push(random ? 'random' : 'in order');
    if (query?.length) parts.push(`query ${query.map(text => `"${text}"`).join(', ')}`);
    if (tag?.length) parts.push(`tags ${tag.join(', ')}`);
    if (keywords?.length) parts.push(`words ${keywords.join(', ')}`);
    if (image !== undefined) parts.push(`images ${formatSetting(image)}`);
    if (video !== undefined) parts.push(`videos ${formatSetting(video)}`);
    return parts.join(', ');
  }

  adjustments(media) {
    const text = formatAdjustments(media);
    return text ? fmt.dim(`  ${text}`) : '';
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
    const json = wantsJson(options);
    const { monitor, path, media, rating } = await this.control.current(options.monitor);
    if (json) {
      out.json(playingJson(this.database, { monitor, media, rating }));
      return;
    }
    if (!path) {
      out.info(`${monitor.name}: nothing playing`);
      return;
    }

    if ((options.line || options.header) && media) {
      if (options.header) out.print(formatMediaHeader());
      out.print(formatMediaLine(media, { rating }));
      return;
    }
    // The first line stays the bare path (full when piped) for scripts
    out.print(displayPath(path));
    if (!media) return;
    printMedia(this.database, media, { rating, path: false, extra: [this.adjustments(media)] });
    const cost = formatPlaybackCost(this.database.getPlaybackStats(media.id));
    if (cost) out.field('cpu', fmt.dim(cost));
  }

  // --query, --tag and --keywords jump to a matching item instead; the playlist itself stays as it was
  // Filters and order given here stay in effect until next --clear or a daemon restart
  async next(options = {}) {
    // Checked before they are stored, so a mistyped query is not kept
    matchFilters(this.database, options);
    options = await resolveNextFilters(this.runtimeDir, options, {
      persist: true, kill: this.kill, timeout: this.timeout, logfile: this.config.get().paths.logfile
    });
    const random = randomOrder(this.config.get().display, options.random);
    const matches = matchingMedia(this.database, options);
    await this.show(await this.control.next(options.monitor, matches ? { random, matches } : { random }), options);
  }

  async prev(options = {}) {
    await this.show(await this.control.prev(options.monitor), options);
  }

  // Prints and announces what a monitor plays after a command switched it
  async show(playing, options) {
    printPlaying(this.database, playing, options);
    await notifyCommand(this.config, this.database, playing, { logger: this.logger });
  }

  async speed(value, options) {
    const { monitor, speed } = await this.control.speed(value, options.monitor);
    out.print(`${monitor.name}: speed ${fmt.cyan(speed)}`);
  }

  async dim(value, options) {
    const { monitor, dim } = await this.control.dim(value, options.monitor);
    out.print(`${monitor.name}: dim ${fmt.cyan(dim)}`);
  }

  // With the daemon running, the reload also shows what the target monitor now plays
  async mode(requested, options = {}) {
    // With the wallpaper off only the mode changes; the wallpaper starts in it when turned on
    const running = await this.control.state({ required: false });
    const playing = running && running.wallpaper !== false ? await this.control.switchTo(options.monitor, () => this.control.mode(requested)) : null;
    const { mode, counts } = playing?.result ?? await this.control.mode(requested);
    // --json: the new mode and what the target monitor now plays, or a null monitor when stopped
    if (wantsJson(options)) {
      out.json({ mode, ...(playing ? playingJson(this.database, playing) : { monitor: null, item: null }) });
      return;
    }
    out.row('Mode', fmt.cyan(mode));
    for (const [name, count] of Object.entries(running ? counts : {})) {
      out.print(`  ${fmt.bold(name)}: ${count ? `${count} items` : fmt.yellow(`no ${mode}s at this resolution`)}`);
    }
    if (playing) await this.show(playing, options);
  }
}
