import { Daemon, readState } from '../display/Daemon.js';
import { readNextFilters } from '../display/nextFilters.js';
import { getMode, getChosenMode, displayMode, describePlaylistFilter, getPlaylistFilter, playlistMatch } from '../display/Playlist.js';
import { DisplayService } from '../services/DisplayService.js';
import { readWebInfo, webAddress } from '../web/info.js';
import { bounceState } from '../display/bounce.js';
import { out, fmt, icon, displayPath, describeMedia, formatResolution, formatCpu, formatDecoder, formatSetting, formatBytes } from '../utils/output.js';
import {
  printMedia, printPlaying, formatMediaLine, formatMediaHeader, formatAdjustments, formatPlaybackCost, wantsJson, playingJson
} from '../utils/mediaView.js';

// A visualizer's colors for status: GLava's { fg, fg2 }, or the background sleeve was sent ('' before any)
function colorText(colors) {
  if (!colors) return '';
  if (colors.main) return `over ${colors.background}`;
  return Object.values(colors).map(value => value.replace(/^(#[0-9a-f]{6})ff$/i, '$1')).join(' to ');
}

export class DisplayCommand {
  constructor(config, database, logger, { service, version = null, ...options } = {}) {
    this.config = config;
    this.version = version;
    this.database = database;
    this.logger = logger;
    this.service = service ?? new DisplayService({ config, database, logger, ...options });
  }

  get control() {
    return this.service.control;
  }

  set control(control) {
    this.service.control = control;
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

  // Without flags, starts the daemon with the wallpaper and, if visualizer.enabled, the visualizer.
  // --wallpaper/--visualizer start only those parts, or turn them on in a running daemon.
  async start(options = {}) {
    const { action, state } = await this.service.start(options);
    if (action === 'running') out.info(`Already running (pid ${state.pid})`);
    else if (action === 'changed') this.printParts(state);
    else out.success(`Started (pid ${state.pid}) on ${state.monitors.map(m => m.name).join(', ')}: ${this.describeParts(state)}`);
  }

  // Without flags, stops the daemon. --wallpaper/--visualizer turn only those parts off; the daemon stops
  // itself when neither is left on.
  async stop(options = {}) {
    const result = await this.service.stop(options);
    if (result.action === 'reaped') {
      const names = result.orphans.map(({ command, pid }) => `${command} (pid ${pid})`).join(', ');
      out.success(`Stopped ${names}, left running by a daemon that exited without stopping`);
    } else if (result.action === 'not-running') {
      out.info('Not running');
    } else if (result.action === 'changed') {
      this.printParts(result.state);
    } else {
      out.success('Stopped');
    }
  }

  // What is on after a part was switched, or that the daemon stopped because nothing was left on
  printParts(state) {
    if (!state) out.success('Stopped: the wallpaper and visualizer are both off');
    else out.success(this.describeParts(state));
  }

  // `backdrop restack`, for programs that draw overlays: run when their window maps or changes between
  // above and below. Reports the overlays found on each monitor.
  async restack(options = {}) {
    const monitors = await this.service.restack();
    if (wantsJson(options)) {
      out.json({ monitors });
      return;
    }
    const found = monitors.flatMap(monitor => monitor.overlays.map(overlay => ({ monitor: monitor.name, ...overlay })));
    if (!found.length) {
      out.success('Restacked; no overlay windows found');
      return;
    }
    out.success(`Restacked with ${found.length} overlay${found.length === 1 ? '' : 's'}`);
    for (const overlay of found) out.field('info', `${overlay.monitor}: ${this.describeOverlay(overlay)}`);
  }

  // e.g. 'overlay "sleeve" above the visualizer at 2560x1440+0+0, background #1a2b3c'
  describeOverlay({ name, position, geometry, colors }) {
    const title = name ? ` "${name}"` : '';
    const background = colors?.background ? `, background ${colors.background}` : '';
    return `overlay${title} ${position} the visualizer at ${geometry}${background}`;
  }

  // e.g. "wallpaper on, visualizer off"
  describeParts(state) {
    const visualizer = state.visualizer?.enabled && !state.visualizer.error;
    const held = state.load?.level === 'off' ? ' (held by load)' : '';
    const hidden = state.visualizer?.hidesWallpaper ? ' (the preset hides it)' : '';
    return [
      `wallpaper ${state.wallpaper === false ? 'off' : `${held || hidden ? 'off' : 'on'}${held || hidden}`}`,
      `visualizer ${visualizer ? `${held ? 'off' : 'on'}${held}` : 'off'}`
    ].join(', ');
  }

  // e.g. "images only at 1.90 a CPU, videos back under 1.12 (1 min average, 8 CPUs)"
  describeLoad({ level, value, window, limit, resume_below: resume, cpus }) {
    const load = `${Number(value).toFixed(2)} a CPU`;
    const average = `(${window} min average${cpus ? `, ${cpus} CPUs` : ''})`;
    if (level === 'off') return `${fmt.yellow(`off at ${load}`)}, back under ${resume} ${average}`;
    if (level === 'image') return `${fmt.yellow(`images only at ${load}`)}, videos back under ${resume} ${average}`;
    return `${load}, limit ${limit} ${average}`;
  }

  async status(options = {}) {
    if (wantsJson(options)) {
      out.json(await this.statusJson());
      return;
    }
    const state = await readState(this.runtimeDir);
    const chosen = getChosenMode(this.database);
    const shown = getMode(this.database);
    out.row('Mode', `${fmt.cyan(shown)}${shown === chosen ? '' : fmt.dim(` (${chosen} held back by the system load)`)}`);
    const filter = getPlaylistFilter(this.database);
    if (filter) out.row('Playlist', `${describePlaylistFilter(filter)} ${fmt.dim('(backdrop playlist --clear for everything)')}`);
    for (const warning of this.config.warnings ?? []) out.row('Config', fmt.yellow(warning));
    // Without the token: `backdrop web --open` opens it with one
    const web = await readWebInfo(this.runtimeDir);
    if (web) out.row('Web', `${webAddress(web.port)} ${fmt.dim(`(pid ${web.pid}; backdrop web --open)`)}`);
    if (!state) {
      out.row('Daemon', fmt.yellow('not running'));
      return;
    }

    out.row('Daemon', `${fmt.green('running')} ${fmt.dim(`(pid ${state.pid}; ${this.describeParts(state)})`)}`);
    if (state.load) out.row('Load', this.describeLoad(state.load));
    if (state.screensaver) out.row('Screensaver', this.describeScreensaver(state.screensaver));
    if (state.smoothing?.fallback) out.row('Smoothing', this.describeSmoothing(state.smoothing));
    const waiting = this.describeIdleWait(state.smoothing);
    if (waiting) out.row('Smoothing', waiting);
    const reversing = this.describeIdleWait(state.bounce);
    if (reversing) out.row('Bounce', reversing);
    if (state.visualizer?.error) out.row('Visualizer', fmt.yellow(`off: ${state.visualizer.error}`));
    if (state.visualizer?.enabled && state.visualizer.compositor === false) {
      out.row('Visualizer', fmt.yellow('no compositor runs: the area around the bars shows black (start picom or another compositor)'));
    }
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
    const { allow_upscale: allowUpscale } = this.config.get().display;
    for (const monitor of state.monitors) {
      if (!monitor.socket) {
        const why = state.wallpaper === false ? '(backdrop start --wallpaper)'
          : state.load?.level === 'off' ? 'until the system load falls' : 'while the preset hides it';
        out.field('info', fmt.yellow(`wallpaper off ${why}`));
        continue;
      }
      const mode = displayMode(this.database, monitor, { allowUpscale });
      const { path, media } = await this.control.current(monitor.name).catch(() => ({}));
      const { media: eligibleItems, fallback } = playlistMatch(this.database, mode, monitor, { allowUpscale, exclude: state.dropped });
      const eligible = eligibleItems.length;
      const details = [formatResolution(monitor.width, monitor.height), `${eligible} ${mode}s ${filter && !fallback ? 'in the playlist' : 'eligible'}`];
      // Recent average from the daemon's samples, once it has two
      if (Number.isFinite(monitor.cpu)) details.push(`cpu ${formatCpu(monitor.cpu)}${monitor.hwdec ? ` ${formatDecoder(monitor.hwdec)}` : ''}`);
      if (Number.isFinite(monitor.gpuMemory)) details.push(`gpu ${formatBytes(monitor.gpuMemory)}`);
      out.print(`  ${icon('monitor')}${fmt.bold(monitor.name)} ${fmt.dim(details.join(', '))}`);
      if (fallback) out.field('info', fmt.yellow(`the playlist matches no ${mode} for this monitor; playing every ${mode}`));
      for (const item of monitor.visualizers ?? (monitor.visualizer ? [monitor.visualizer] : [])) out.field('info', this.describeVisualizer(item));
      for (const overlay of monitor.overlays ?? []) out.field('info', this.describeOverlay(overlay));
      if (!path) {
        out.field('info', fmt.yellow('nothing playing'));
        out.detail(this.blankReason(mode, monitor, eligible, allowUpscale));
        continue;
      }
      if (media) {
        const reversing = bounceState(media, this.config.get()) === 'reversing' ? fmt.yellow('  reversing for bounce') : '';
        out.field(media.kind, `${fmt.bold(`#${media.id}`)}  ${describeMedia(media)}${this.adjustments(media)}${reversing}`);
      }
      out.field('path', displayPath(path));
    }
  }

  // The daemon's screensaver state for status: what started it and since when, or off
  describeScreensaver({ active, trigger, since }) {
    if (!active) return fmt.dim('off');
    const how = { key: 'by key', idle: 'after idle' }[trigger] ?? trigger;
    const at = Number.isFinite(since) ? `, since ${new Date(since).toTimeString().slice(0, 5)}` : '';
    return `${fmt.green('on')} ${fmt.dim(`(${how}${at}; backdrop screensaver off)`)}`;
  }

  // Only when a GPU job moved to the CPU: what happened, and that a restart tries the GPU again
  describeSmoothing({ gpu, fallback }) {
    const at = Number.isFinite(fallback.at) ? ` since ${new Date(fallback.at).toTimeString().slice(0, 5)}` : '';
    return `${fmt.yellow(`on the CPU${at}`)} ${fmt.dim(`(${fallback.reason}; restart the daemon to try GPU ${gpu} again)`)}`;
  }

  // While videos wait for an idle gate (src/display/IdleGate.js; state.json smoothing or bounce) to open: how loaded
  // the machine is, and how long it has been idle enough. With an offload host (state.json host) the gate does not
  // hold them: where they are made instead.
  describeIdleWait(queue) {
    const gate = queue?.gate;
    if (queue?.host && queue.enabled !== false && (queue.waiting || queue.encoding)) {
      const videos = queue.waiting ? `${queue.waiting} ${queue.waiting === 1 ? 'video waits' : 'videos wait'}` : 'none waits';
      return `${fmt.green(`on ${queue.host}`)} ${fmt.dim(`(${queue.encoding ? `#${queue.encoding} now; ` : ''}${videos})`)}`;
    }
    if (!queue || queue.enabled === false || !queue.waiting || !gate || gate.open || gate.idle_load === null) return null;
    const perCpu = gate.load ? `load ${gate.load.five.toFixed(2)} a CPU` : 'load not read yet';
    const low = Number.isFinite(gate.low_since) ? `, under it since ${new Date(gate.low_since).toTimeString().slice(0, 5)}` : '';
    const videos = `${queue.waiting} ${queue.waiting === 1 ? 'video waits' : 'videos wait'}`;
    return `${fmt.yellow('waiting for an idle machine')} ${fmt.dim(`(${videos}; ${perCpu}${low}; starts after ${gate.idle_minutes} min under ${gate.idle_load})`)}`;
  }

  // status --json (DisplayService.status)
  statusJson() {
    return this.service.status();
  }

  // colors are the ones piped from the wallpaper (or the config, until it is sampled); opaque ones lose their alpha
  describeVisualizer({ instance, module, geometry, running, colors }) {
    const name = instance && instance !== 'main' ? ` ${instance}` : '';
    const shown = colorText(colors) ? `, colors ${colorText(colors)}` : '';
    return `visualizer${name} ${module} at ${geometry}${shown}${running ? '' : fmt.yellow(' (gave up after repeated exits; backdrop visualizer reload)')}`;
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
    if (bounceState(media, this.config.get()) === 'reversing') out.field('info', fmt.yellow('bounces once its reversed copy is made'));
  }

  // --query, --tag and --keywords jump to a matching item instead; the playlist itself stays as it was
  // Filters and order given here stay in effect until next --clear or a daemon restart
  async next(options = {}) {
    const { playing, options: resolved } = await this.service.next(options);
    printPlaying(this.database, playing, resolved);
  }

  async prev(options = {}) {
    const { playing } = await this.service.prev(options);
    printPlaying(this.database, playing, options);
  }

  async speed(value, options) {
    const { monitor, speed } = await this.service.speed(value, options);
    out.print(`${monitor.name}: speed ${fmt.cyan(speed)}`);
  }

  async dim(value, options) {
    const { monitor, dim, shown = dim } = await this.service.dim(value, options);
    out.print(`${monitor.name}: dim ${fmt.cyan(dim)}${shown > dim ? fmt.dim(` (${shown} while music plays)`) : ''}`);
  }

  async bounce(value, options) {
    const { monitor, media, bounce, bouncing } = await this.service.bounce(value, options);
    const source = bounce === null ? fmt.dim(' (display.video_loop)') : '';
    // The reversed copy is made in the background; once it is there the video switches at the end of a pass
    const state = bouncing ? bounceState({ ...media, bounce }, this.config.get()) : 'off';
    const when = state === 'reversing' ? fmt.yellow(', reversing in the background; it bounces once that is done')
      : state === 'ready' ? fmt.dim(', from the end of this pass') : '';
    out.print(`${monitor.name}: bounce ${fmt.cyan(bouncing ? 'on' : 'off')}${source}${when}`);
  }

  // With the daemon running, the reload also shows what the target monitor now plays
  // `backdrop restart [--if-stale]`: the daemon and a running `backdrop web` on this checkout's code
  async restart(options = {}) {
    const { daemon, web } = await this.service.restart({ ifStale: Boolean(options.ifStale), version: this.version });
    const say = (name, outcome) => {
      if (outcome === 'not-running') out.row(name, fmt.dim('not running'));
      else if (outcome === 'current') out.row(name, `${fmt.dim('already on')} ${this.version}`);
      else out.row(name, `${fmt.green('restarted')} ${outcome.from ? `${outcome.from} -> ` : ''}${this.version}`);
    };
    say('Daemon', daemon);
    say('Web', web);
  }

  // `backdrop playlist`: sets the playlist filter with --query/--tag/--keywords, drops it with --clear, and shows it
  // with neither; each monitor's count, and a warning for one the filter leaves empty (it plays everything)
  async playlist(options = {}) {
    const { filter, changed, running, monitors } = await this.service.playlist(options);
    if (wantsJson(options)) {
      out.json({ filter, monitors });
      return;
    }
    out.row('Playlist', filter ? describePlaylistFilter(filter) : fmt.dim(changed ? 'everything (filter cleared)' : 'everything (no filter)'));
    if (!running) {
      out.detail(changed ? 'The daemon is not running; its next start plays this playlist' : 'The daemon is not running');
      return;
    }
    for (const [name, { count, fallback }] of Object.entries(monitors)) {
      out.print(`  ${fmt.bold(name)}: ${fallback ? fmt.yellow(`nothing matches here; playing all ${count} eligible items`) : `${count} items`}`);
    }
  }

  async mode(requested, options = {}) {
    const { mode, held, counts, running, playing } = await this.service.mode(requested, options);
    // --json: the new mode and what the target monitor now plays, or a null monitor when stopped
    if (wantsJson(options)) {
      out.json({ mode, ...(held ? { held } : {}), ...(playing ? playingJson(this.database, playing) : { monitor: null, item: null }) });
      return;
    }
    out.row('Mode', `${fmt.cyan(mode)}${held ? fmt.dim(` (showing ${held}s until the system load falls)`) : ''}`);
    for (const [name, count] of Object.entries(running ? counts : {})) {
      out.print(`  ${fmt.bold(name)}: ${count ? `${count} items` : fmt.yellow(`no ${mode}s at this resolution`)}`);
    }
    if (playing) printPlaying(this.database, playing, options);
  }
}
