import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { DisplayCommand } from './DisplayCommand.js';
import { RatingCommand } from './RatingCommand.js';
import { MODE_KINDS, getMode, otherMode } from '../display/Playlist.js';
import { thumbnailFor } from '../library/thumbnail.js';
import { describeNotification, escapeMarkup, notifyError } from '../utils/notify.js';
import { formatAdjustments } from '../utils/mediaView.js';

export const MENU_STYLES = ['panel', 'minimal'];
export const PANEL_THEME = fileURLToPath(new URL('../../share/rofi/backdrop-panel.rasi', import.meta.url));

const SPEEDS = ['0.5', '0.75', '1', '1.25', '1.5', '+0.1', '-0.1'];
const DIMS = ['0', '20', '40', '60', '+10', '-10'];

// Nerd Font glyphs (Font Awesome code points), as in the CLI's nerd symbol set. The star is the plain
// Unicode one: fonts without Nerd glyphs map U+F005 to something else entirely.
const ICONS = {
  keep: '★', skip: '', undo: '', prev: '', next: '', random: '',
  goNext: '', speed: '', dim: '', video: '', image: '', monitor: ''
};

// Runs rofi -dmenu on the given input and resolves to the picked index, or null when dismissed.
// -format i returns the index, so labels never have to be parsed back; -no-custom rejects typed text.
function runRofi(args, input, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('rofi', ['-dmenu', '-i', '-no-custom', '-format', 'i', ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('rofi is not installed') : error));
    child.on('close', code => {
      // rofi exits 1 when dismissed with Escape
      if (code === 1) resolve(null);
      else if (code === 0 && /^\d+$/.test(output.trim())) resolve(Number(output.trim()));
      else reject(new Error(`rofi exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

function activeArgs(menu) {
  return menu.active?.length ? ['-a', menu.active.join(',')] : [];
}

// A rasi string literal
function rasiString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// One line per entry, icon first, under the item's summary
export function minimalView(extraArgs = [], spawnProcess = spawn) {
  return menu => runRofi([
    '-p', menu.prompt, ...(menu.message ? ['-mesg', menu.message] : []), ...activeArgs(menu), ...extraArgs
  ], `${menu.entries.map(entry => (entry.icon ? `${entry.icon}  ${entry.label}` : entry.label)).join('\n')}\n`, spawnProcess);
}

// Buttons per row at most; a full main menu (13 entries) fills two rows
const PANEL_COLUMNS = 7;

// A grid of buttons (a large icon over a caption) under a preview banner, titled with the item's file name.
// Entries hold a line break, so they are separated by | instead; three lines of height fit the large icon and caption.
export function panelView(extraArgs = [], spawnProcess = spawn, theme = PANEL_THEME) {
  return menu => {
    const lines = Math.ceil(menu.entries.length / (menu.columns ?? PANEL_COLUMNS));
    const columns = Math.ceil(menu.entries.length / lines);
    const input = menu.entries.map(entry =>
      `<span font_size="x-large">${entry.icon || ' '}</span>\n${escapeMarkup(entry.caption ?? entry.label).replace(/\|/g, '¦')}`).join('|');
    return runRofi([
      '-markup-rows', '-sep', '|', '-eh', '3', '-theme', theme,
      '-theme-str', `listview { columns: ${columns}; lines: ${lines}; }`,
      ...(menu.preview ? ['-theme-str', `preview { background-image: url(${rasiString(menu.preview)}, width); }`] : []),
      '-p', menu.title ?? menu.prompt, '-mesg', menu.message || ' ', ...activeArgs(menu), ...extraArgs
    ], input, spawnProcess);
  };
}

// A rofi menu over the playback and rating commands for the monitor under the pointer (or --monitor).
// It closes after an action unless --stay is given; speed and dim stay in their submenu for repeated steps.
// Menus are built as { prompt, title, message, preview, entries: [{ icon, label, caption }], active } and
// drawn by a view: panel (buttons and a preview) or minimal (a list).
export class MenuCommand {
  constructor(config, database, logger, { display, rating, view, thumbnail = thumbnailFor } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.display = display ?? new DisplayCommand(config, database, logger);
    this.rating = rating ?? new RatingCommand(config, database, logger, { control: this.display.control });
    this.view = view;
    this.thumbnail = thumbnail;
  }

  get control() {
    return this.display.control;
  }

  style(requested) {
    const style = requested ?? this.config.get().menu?.style ?? 'panel';
    if (!MENU_STYLES.includes(style)) throw new Error(`menu.style must be ${MENU_STYLES.join(' or ')}, not ${style}`);
    return style;
  }

  viewFor(style) {
    if (this.view) return this.view;
    const args = this.config.get().menu?.rofi_args ?? [];
    return style === 'panel' ? panelView(args) : minimalView(args);
  }

  // Each menu returns null when dismissed, { monitor } to retarget, { back: true } to show the main menu
  // again, or { done: true } after an action. Opened from a keybinding there is no terminal to read an
  // error from, so errors are also sent as notifications; with --stay the menu then stays open.
  async open(options = {}) {
    let monitor;
    try {
      this.current = { style: this.style(options.style) };
      this.current.show = this.viewFor(this.current.style);
      monitor = (await this.control.targetMonitor(options.monitor)).name;
    } catch (error) {
      await notifyError(error.message, { logger: this.logger });
      throw error;
    }
    for (;;) {
      let result;
      try {
        result = await this.mainMenu(monitor);
      } catch (error) {
        await notifyError(error.message, { logger: this.logger });
        if (!options.stay) throw error;
        continue;
      }
      if (!result) return;
      if (result.monitor) monitor = result.monitor;
      else if (!result.back && !options.stay) return;
    }
  }

  // The playing item: title (its file name), message (summary and details, Pango markup) and, for the
  // panel, a preview banner. e.g. "#412  video  3840x2160\n0:18 · 25 fps · ★★☆ · DP-1\nocean, waves"
  async describe(monitorName) {
    const { monitor, media, rating } = await this.control.current(monitorName);
    if (!media) {
      return { media: null, rating: null, title: monitor.name, message: escapeMarkup(`${monitor.name}: nothing from the library playing`) };
    }
    const { summary, body } = describeNotification({ monitor, media, rating, tags: this.database.getTags(media.id) });
    const adjustments = formatAdjustments(media);
    const name = media.source === 'local' && media.original_name ? media.original_name : path.basename(media.path);
    const preview = this.current.style === 'panel'
      ? await this.thumbnail(media, this.config.get().paths.thumbnails, { logger: this.logger })
      : null;
    return {
      media, rating, preview, title: name,
      message: [escapeMarkup(summary), body, adjustments && escapeMarkup(adjustments)].filter(Boolean).join('\n')
    };
  }

  show(menu) {
    return this.current.show(menu);
  }

  async mainMenu(monitor) {
    const item = await this.describe(monitor);
    const { media } = item;
    const target = { monitor };
    const items = [];
    if (media) {
      // Rating from the menu always moves on to the next item
      for (const value of [1, 2, 3]) {
        items.push({ icon: ICONS.keep, label: `keep ${value}`, run: () => this.rating.keep(value, { ...target, next: true }) });
      }
      items.push({ icon: ICONS.skip, label: 'skip', run: () => this.rating.skip(target) });
    }
    // Rating and moving through the playlist first, so a full panel reads as one row of each
    items.push(
      { icon: ICONS.undo, label: 'undo', run: () => this.rating.undo() },
      { icon: ICONS.prev, label: 'prev', run: () => this.display.prev(target) },
      { icon: ICONS.next, label: 'next', run: () => this.display.next({ ...target, random: false }) },
      { icon: ICONS.random, label: 'next (random)', caption: 'random', run: () => this.display.next({ ...target, random: true }) }
    );
    if (media) items.push({ icon: ICONS.goNext, label: 'go-next', run: () => this.rating.goNext(target) });
    if (media && MODE_KINDS.video.includes(media.kind)) {
      items.push({ icon: ICONS.speed, label: 'speed ▸', caption: 'speed', run: () => this.stepMenu(monitor, 'speed', SPEEDS) });
    }
    if (media) items.push({ icon: ICONS.dim, label: 'dim ▸', caption: 'dim', run: () => this.stepMenu(monitor, 'dim', DIMS) });
    const other = otherMode(getMode(this.database));
    items.push({ icon: ICONS[other], label: `mode: switch to ${other}s`, caption: `${other}s`, run: () => this.display.mode(other, target) });
    const { monitors } = await this.control.state();
    if (monitors.length > 1) {
      items.push({ icon: ICONS.monitor, label: `monitor: ${monitor} ▸`, caption: monitor, run: () => this.monitorMenu(monitor) });
    }

    // The current rating's keep button is highlighted
    const active = items.flatMap((entry, index) => (item.rating?.rating && entry.label === `keep ${item.rating.rating}` ? [index] : []));
    const picked = await this.show({ prompt: 'backdrop', title: item.title, message: item.message, preview: item.preview, entries: items, active });
    if (picked === null) return null;
    return (await items[picked].run()) ?? { done: true };
  }

  // Applies values until dismissed, showing the new value each time; dismissing it ends the action
  async stepMenu(monitor, kind, values) {
    for (;;) {
      const item = await this.describe(monitor);
      if (!item.media) return { back: true };
      const current = kind === 'speed' ? item.media.speed : item.media.dim;
      const prompt = `${kind} (now ${current})`;
      const entries = values.map(value => ({ icon: ICONS[kind], label: value }));
      const active = values.flatMap((value, index) => (Number(value) === current && !/^[+-]/.test(value) ? [index] : []));
      const picked = await this.show({ prompt, title: `${item.title}  ·  ${prompt}`, message: item.message, preview: item.preview,
        entries, active, columns: values.length });
      if (picked === null) return { done: true };
      await this.display[kind](values[picked], { monitor });
    }
  }

  async monitorMenu(current) {
    const { monitors } = await this.control.state();
    const message = escapeMarkup(`Target for the menu's actions: ${current}`);
    const picked = await this.show({ prompt: 'monitor', title: 'monitor', message, columns: monitors.length,
      entries: monitors.map(monitor => ({ icon: ICONS.monitor, label: monitor.name })),
      active: monitors.flatMap((monitor, index) => (monitor.name === current ? [index] : [])) });
    return picked === null ? { back: true } : { monitor: monitors[picked].name };
  }
}
