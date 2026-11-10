import fs from 'fs-extra';
import path from 'path';
import { readState, statePath } from '../display/Daemon.js';
import { findOrphans } from '../display/children.js';
import { withX11 } from '../display/x11.js';
import { run } from '../display/Monitors.js';
import { checkVisualizer } from '../visualizer/check.js';
import { enginesOf, visualizerSettings } from '../visualizer/settings.js';
import { ANIMATED_WEBP } from '../library/probe.js';
import { encodeCounts, listReversed } from '../library/reverse.js';
import { neededSize } from '../display/bounce.js';
import { SMOOTH_BELOW, SMOOTH_FPS, listSmoothed, rifeModel, smoothedReady, stutters, wantsSmoothing } from '../library/smooth.js';
import { wantsJson } from '../utils/mediaView.js';
import { out, fmt, displayPath, formatBytes } from '../utils/output.js';

// mpv's IPC socket path limit; the daemon refuses longer ones
const MAX_SOCKET_PATH = 107;
// A long xrandr output name, for the socket path estimate
const LONG_MONITOR_NAME = 'HDMI-A-1-10';
const MISSING_SHOWN = 3;

// Tools by what needs them; required ones fail, the others warn when the feature that needs them is on
const TOOLS = [
  { name: 'mpv', need: 'plays the wallpaper', required: true },
  { name: 'xwinwrap', need: 'puts mpv on the desktop', required: true },
  { name: 'ffmpeg', need: 'thumbnails and wallpaper colors', required: true },
  { name: 'ffprobe', need: 'reads media sizes on import', required: true },
  { name: 'xrandr', need: 'finds the monitors', required: true },
  { name: 'xdotool', need: 'finds the monitor under the pointer and the visualizer windows', required: true },
  { name: 'rofi', need: 'backdrop menu', wanted: () => true },
  { name: 'glava', need: 'the visualizer', wanted: config => Boolean(config.visualizer?.enabled) && enginesOf(config.visualizer).has('glava') },
  { name: 'sleeve', need: 'the sleeve visualizer instances (docs/specs/sleeve.md)', wanted: config => Boolean(config.visualizer?.enabled) && enginesOf(config.visualizer).has('sleeve') },
  { name: 'notify-send', need: 'desktop notifications', wanted: config => config.display?.notify !== 'off' },
  { name: 'pactl', need: 'visualizer.only_while_playing or wallpaper_dim', wanted: config => Boolean(config.visualizer?.only_while_playing || config.visualizer?.wallpaper_dim) },
  { name: 'i3-msg', need: 'menu.workspace', wanted: config => config.menu?.workspace !== false }
];

// The first sleeve with the contract in docs/specs/sleeve.md
const SLEEVE_MIN = [0, 33];
// And with the wallpaper layer's areas, background and --map-below
const SLEEVE_LAYER_MIN = [0, 36];

function usesSleeveLayer(section) {
  try {
    return visualizerSettings(section).instances.some(({ sleeve }) => sleeve && (sleeve.lyricsArea || sleeve.nowArea || sleeve.background || sleeve.mapBelow));
  } catch {
    return false;
  }
}

// Whether an executable is on $PATH
async function onPath(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      await fs.access(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

// Reports what backdrop needs and finds wrong, without changing anything: tools, the X display and a
// compositor, the config, the daemon and processes a crashed one left, and the library (database integrity,
// items whose files are missing). Each problem names the command that fixes it. Fails (exit 1) on any failure;
// warnings do not. --visualizer also runs `visualizer check`.
export class DoctorCommand {
  constructor(config, database, logger, {
    version = null, which = onPath, x11 = withX11, readStateFile = readState, orphans = findOrphans,
    checkVisualizers = checkVisualizer, pathExists = fs.pathExists, exec = run
  } = {}) {
    Object.assign(this, { config, database, logger, version, which, x11, readStateFile, orphans, checkVisualizers, pathExists, exec });
  }

  async run(options = {}) {
    const { ok, failed, warned, checks } = await this.check(options);
    if (wantsJson(options)) out.json({ ok, failed, warned, checks });
    else this.print(checks, failed, warned);
    if (failed) process.exitCode = 1;
    return checks;
  }

  // Every check as data, nothing printed: { ok, failed, warned, checks: [{ group, name, status, detail, hint? }] },
  // for run and the web interface's Status page
  async check(options = {}) {
    const checks = [];
    const add = (group, name, status, detail, hint) => checks.push({ group, name, status, detail, ...(hint ? { hint } : {}) });
    const settings = this.config.get();

    for (const tool of TOOLS) {
      if (await this.which(tool.name)) {
        add('tools', tool.name, 'ok', tool.need);
      } else if (tool.required) {
        add('tools', tool.name, 'fail', `not installed; ${tool.need}`, `install ${tool.name}`);
      } else if (tool.wanted(settings)) {
        add('tools', tool.name, 'warn', `not installed; ${tool.need}`, `install ${tool.name}`);
      }
    }

    await this.checkDisplay(settings, add);
    await this.checkSleeve(settings, add);
    this.checkConfig(settings, add);
    await this.checkDaemon(settings, add);
    await this.checkLibrary(add);
    if (options.visualizer) await this.checkVisualizer(settings, add);

    const failed = checks.filter(check => check.status === 'fail').length;
    const warned = checks.filter(check => check.status === 'warn').length;
    return { ok: !failed, failed, warned, checks };
  }

  async checkDisplay(settings, add) {
    if (!process.env.DISPLAY) {
      add('display', 'X display', 'fail', 'DISPLAY is not set', 'run backdrop from your X session, or set DISPLAY');
      return;
    }
    let compositor;
    try {
      compositor = await this.x11(x => x.hasCompositor());
      add('display', 'X display', 'ok', process.env.DISPLAY);
    } catch (error) {
      add('display', 'X display', 'fail', `cannot connect to ${process.env.DISPLAY}: ${error.message}`, 'check DISPLAY and XAUTHORITY');
      return;
    }
    if (compositor) add('display', 'compositor', 'ok', 'running');
    else if (settings.visualizer?.enabled) {
      add('display', 'compositor', 'warn', 'none runs: the area around the visualizer shows black', 'start picom or another compositor');
    }
    const socket = path.join(settings.paths.runtime, `${LONG_MONITOR_NAME}.sock`);
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
      add('display', 'socket path', 'fail', `${socket} is longer than ${MAX_SOCKET_PATH} bytes`, 'set a shorter paths.runtime or XDG_RUNTIME_DIR');
    }
  }

  checkConfig(settings, add) {
    const { errors = [], warnings = [], visualizerError } = this.config;
    if (!errors.length && !warnings.length && !visualizerError) add('config', 'config', 'ok', displayPath(this.config.configPath));
    for (const error of errors) add('config', 'value', 'fail', error, `fix it in ${displayPath(this.config.configPath)}`);
    for (const warning of warnings) add('config', 'unknown key', 'warn', warning);
    if (visualizerError) add('config', 'visualizer', 'warn', `${visualizerError}; the visualizer stays off`);
    const pexels = settings.sources?.pexels;
    if (pexels && !pexels.api_key) {
      add('config', 'Pexels key', 'warn', 'no sources.pexels.api_key or PEXELS_API: search and download cannot reach Pexels', 'set PEXELS_API or sources.pexels.api_key');
    }
  }

  async checkDaemon(settings, add) {
    const runtime = settings.paths.runtime;
    const state = await this.readStateFile(runtime);
    if (state) {
      const behind = this.version && state.version && state.version !== this.version;
      add('daemon', 'daemon', behind ? 'warn' : 'ok', `running (pid ${state.pid}${state.version ? `, ${state.version}` : ''})`,
        behind ? `it runs ${state.version}, the CLI is ${this.version}: backdrop stop, then backdrop start` : undefined);
    } else if (await this.pathExists(statePath(runtime))) {
      add('daemon', 'daemon', 'warn', 'not running, but its state file is left from a daemon that did not stop', 'backdrop stop clears it');
    } else {
      add('daemon', 'daemon', 'ok', 'not running');
    }
    const found = this.orphans(runtime);
    if (found?.orphans.length) {
      const names = found.orphans.map(({ command, pid }) => `${command} (pid ${pid})`).join(', ');
      add('daemon', 'left running', 'warn', `${names}, from daemon ${found.daemon}, which exited without stopping`, 'backdrop stop ends them');
    }
  }

  async checkLibrary(add) {
    try {
      const result = Object.values(this.database.db.prepare('PRAGMA quick_check').get() ?? {})[0];
      if (result === 'ok') add('library', 'database', 'ok', 'integrity check passed');
      else add('library', 'database', 'fail', `integrity check: ${result}`, 'restore the database from a backup');
    } catch (error) {
      add('library', 'database', 'fail', error.message);
    }
    await this.checkAnimatedWebp(add);
    await this.checkBounceCache(add);
    await this.checkSmooth(add);
    const items = this.database.findMedia({ downloaded: true }).filter(item => item.path);
    const missing = [];
    for (const item of items) if (!await this.pathExists(item.path)) missing.push(item);
    if (!missing.length) {
      add('library', 'files', 'ok', `${items.length} items, every file present`);
      return;
    }
    const shown = missing.slice(0, MISSING_SHOWN).map(item => `#${item.id}`).join(', ');
    add('library', 'files', 'warn', `${missing.length} of ${items.length} items have no file (${shown}${missing.length > MISSING_SHOWN ? ', ...' : ''})`,
      'backdrop rescan --all lists them; backdrop remove <id> drops one');
  }

  // How much of display.bounce_cache_gb the reversed copies use; nothing to show when there are none
  async checkBounceCache(add) {
    const { display, paths } = this.config.get();
    const copies = await listReversed(paths.bounce);
    if (!copies.length) return;
    const used = copies.reduce((sum, copy) => sum + copy.size, 0);
    const limit = (display.bounce_cache_gb ?? 0) * 1024 ** 3;
    const of = limit ? ` of ${formatBytes(limit)}` : ' (no limit)';
    // The daemon prunes after each encode, so being well over means it is not running or cannot delete
    const over = limit && used > limit * 1.1;
    // How often videos are reversed: with a cache far smaller than the videos, about one encode per play
    const { today, yesterday } = encodeCounts(this.database);
    const minutes = seconds => `${Math.round(seconds / 6) / 10} min`;
    const encodes = `; ${today.count} encoded today (${minutes(today.seconds)}), ${yesterday.count} yesterday`;
    add('library', 'bounce cache', over ? 'warn' : 'ok', `${copies.length} reversed ${copies.length === 1 ? 'copy' : 'copies'}, ${formatBytes(used)}${of}${encodes}`,
      over ? `the daemon prunes it to display.bounce_cache_gb; delete ${displayPath(paths.bounce)} to clear it` : undefined);
  }

  // display.smooth: RIFE and its model where the config says, and how many slowed videos have their copies
  async checkSmooth(add) {
    const { display, paths } = this.config.get();
    if (!display.smooth) return;
    const binary = display.smooth_rife;
    const found = binary.includes('/') ? await this.pathExists(binary) : await this.which(binary);
    if (!found) {
      add('library', 'smoothing', 'fail', `RIFE not found: ${binary}`, 'install rife-ncnn-vulkan and set display.smooth_rife to it');
      return;
    }
    if (binary.includes('/') && !await this.pathExists(rifeModel(binary))) {
      add('library', 'smoothing', 'fail', `no rife-v4.6 model beside ${binary}`, 'copy the release\'s rife-v4.6 folder next to the binary');
      return;
    }
    const slowed = this.database.findMedia({ kind: ['video', 'gif'], status: ['new', 'kept'], downloaded: true })
      .filter(media => wantsSmoothing(media, display.smooth_fps ?? SMOOTH_FPS)
        && (stutters(media, display.smooth_below ?? SMOOTH_BELOW) || smoothedReady(media, paths.smooth)));
    // A copy counts only when it covers the daemon's monitors, as when it plays; without a daemon sizes go unchecked
    const state = await this.readStateFile(paths.runtime).catch(() => null);
    const monitors = state?.monitors ?? [];
    const ready = slowed.filter(media => smoothedReady(media, paths.smooth, neededSize(media, monitors))).length;
    const small = slowed.filter(media => smoothedReady(media, paths.smooth) && !smoothedReady(media, paths.smooth, neededSize(media, monitors))).length;
    const copies = await listSmoothed(paths.smooth);
    const used = copies.reduce((sum, copy) => sum + copy.size, 0);
    const limit = (display.smooth_cache_gb ?? 0) * 1024 ** 3;
    // The daemon stops the backlog at the limit, so the rest wait rather than come
    const full = limit && used + (copies.length ? used / new Set(copies.map(copy => copy.id)).size : 0) > limit;
    const larger = small ? `; ${small} ${small === 1 ? 'copy is' : 'copies are'} smaller than the monitors need, the original plays until a larger one is made` : '';
    const rest = ready < slowed.length ? `${larger}${full ? '; the cache is full, so only what plays now and next is made' : '; the daemon makes the rest'}` : '';
    const cache = copies.length ? `, ${formatBytes(used)}${limit ? ` of ${formatBytes(limit)}` : ' (no limit)'}` : '';
    // The daemon prunes after each copy, so being well over means it is not running or cannot delete
    const over = limit && used > limit * 1.1;
    add('library', 'smoothing', over ? 'warn' : 'ok', `${ready} of ${slowed.length} slowed videos smoothed${cache}${rest}`,
      over ? `the daemon prunes it to display.smooth_cache_gb; delete ${displayPath(paths.smooth)} to clear it` : undefined);
  }

  // Animated WebP in the import folders that this FFmpeg could not decode, still there to convert
  async checkAnimatedWebp(add) {
    const files = [];
    for (const row of this.database.importedFilesWithDetail(ANIMATED_WEBP)) {
      if (await this.pathExists(row.source_path)) files.push(row.source_path);
    }
    if (!files.length) return;
    const shown = files.slice(0, MISSING_SHOWN).map(file => path.basename(file)).join(', ');
    add('library', 'animated WebP', 'warn', `${files.length} not imported: FFmpeg cannot decode them (${shown}${files.length > MISSING_SHOWN ? ', ...' : ''})`,
      'convert each to GIF beside it (magick a.webp a.gif); the next import picks the GIF up');
  }

  // What the sleeve engine needs that shows without starting it; a shell not installed or a blocked sandbox only
  // shows by starting one, which `--visualizer` does (status 2 with sleeve's advice)
  async checkSleeve(settings, add) {
    if (!settings.visualizer?.enabled || !enginesOf(settings.visualizer).has('sleeve') || !await this.which('sleeve')) return;
    const version = await this.exec('sleeve', ['--version']).then(text => text.trim(), () => null);
    const [major, minor] = (version ?? '').split('.').map(Number);
    const needed = usesSleeveLayer(settings.visualizer) ? SLEEVE_LAYER_MIN : SLEEVE_MIN;
    if (version && (major > needed[0] || (major === needed[0] && minor >= needed[1]))) add('visualizer', 'sleeve', 'ok', `version ${version}`);
    else add('visualizer', 'sleeve', 'warn', `version ${version ?? 'unknown'}; this config needs ${needed.join('.')} or later`, 'update sleeve');
    const shell = await this.exec('systemctl', ['--user', 'is-active', 'sleeve-shell.service']).then(text => text.trim(), () => 'inactive');
    if (shell === 'active') {
      add('visualizer', 'sleeve overlay', 'warn', 'sleeve-shell.service runs as well as the sleeve engine, so the lyrics draw twice', 'systemctl --user disable --now sleeve-shell.service');
    }
  }

  async checkVisualizer(settings, add) {
    const results = await this.checkVisualizers(settings.visualizer ?? {});
    for (const result of results) {
      const name = `${result.preset ?? '(no preset)'} ${result.instance ?? ''}`.trim();
      if (result.ok) add('visualizer', name, 'ok', 'runs');
      else add('visualizer', name, 'fail', result.error ?? `exited with code ${result.code}${result.output?.length ? `: ${result.output.at(-1)}` : ''}`, 'backdrop visualizer check shows its output');
    }
  }

  print(checks, failed, warned) {
    const marks = { ok: fmt.green('ok  '), warn: fmt.yellow('warn'), fail: fmt.red('fail') };
    let group = null;
    for (const check of checks) {
      if (check.group !== group) {
        group = check.group;
        out.heading(group);
      }
      out.print(`  ${marks[check.status]}  ${check.name}: ${check.detail}`);
      if (check.hint && check.status !== 'ok') out.detail(`        ${check.hint}`);
    }
    out.print('');
    if (failed) out.error(`${failed} failed, ${warned} ${warned === 1 ? 'warning' : 'warnings'}`);
    else if (warned) out.warn(`No failures, ${warned} ${warned === 1 ? 'warning' : 'warnings'}`);
    else out.success('Everything checks out');
  }
}
