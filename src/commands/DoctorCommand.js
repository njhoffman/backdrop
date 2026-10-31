import fs from 'fs-extra';
import path from 'path';
import { readState, statePath } from '../display/Daemon.js';
import { findOrphans } from '../display/children.js';
import { withX11 } from '../display/x11.js';
import { checkVisualizer } from '../visualizer/check.js';
import { wantsJson } from '../utils/mediaView.js';
import { out, fmt, displayPath } from '../utils/output.js';

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
  { name: 'glava', need: 'the visualizer', wanted: config => Boolean(config.visualizer?.enabled) },
  { name: 'notify-send', need: 'desktop notifications', wanted: config => config.display?.notify !== 'off' },
  { name: 'pactl', need: 'visualizer.only_while_playing', wanted: config => Boolean(config.visualizer?.only_while_playing) },
  { name: 'i3-msg', need: 'menu.workspace', wanted: config => config.menu?.workspace !== false }
];

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
    checkVisualizers = checkVisualizer, pathExists = fs.pathExists
  } = {}) {
    Object.assign(this, { config, database, logger, version, which, x11, readStateFile, orphans, checkVisualizers, pathExists });
  }

  async run(options = {}) {
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
    this.checkConfig(settings, add);
    await this.checkDaemon(settings, add);
    await this.checkLibrary(add);
    if (options.visualizer) await this.checkVisualizer(settings, add);

    const failed = checks.filter(check => check.status === 'fail').length;
    const warned = checks.filter(check => check.status === 'warn').length;
    if (wantsJson(options)) out.json({ ok: !failed, failed, warned, checks });
    else this.print(checks, failed, warned);
    if (failed) process.exitCode = 1;
    return checks;
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
