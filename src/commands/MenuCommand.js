import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { DisplayCommand } from './DisplayCommand.js';
import { RatingCommand } from './RatingCommand.js';
import { MODE_KINDS, getMode, otherMode, randomOrder } from '../display/Playlist.js';
import { matchFilters } from '../library/match.js';
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
  speed: '', dim: '', video: '', image: '', monitor: ''
};

// Keys every menu answers besides its buttons': q closes the menu from anywhere, Tab opens the monitor picker
const QUIT_KEY = 'q';
const MONITOR_KEY = 'Tab';

// The main menu is a fixed grid of this many columns, so buttons and their keys never move
const MAIN_COLUMNS = 5;

// Runs rofi -dmenu on the given input and resolves to the picked index, { key } for one of keys, or null
// when dismissed. -format i returns the index, so labels never have to be parsed back; -no-custom rejects
// typed text. keys are bound to kb-custom-1.., which make rofi exit with 10..; Tab moves between entries
// by default, so it is unbound first.
function runRofi(args, input, spawnProcess, keys = []) {
  const keyArgs = keys.flatMap((key, index) => [`-kb-custom-${index + 1}`, key]);
  if (keys.includes('Tab')) keyArgs.unshift('-kb-element-next', '');
  return new Promise((resolve, reject) => {
    const child = spawnProcess('rofi', ['-dmenu', '-i', '-no-custom', '-format', 'i', ...keyArgs, ...args],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('rofi is not installed') : error));
    child.on('close', code => {
      // rofi exits 1 when dismissed with Escape
      if (code === 1) resolve(null);
      else if (code >= 10 && code < 10 + keys.length) resolve({ key: keys[code - 10] });
      else if (code === 0 && /^\d+$/.test(output.trim())) resolve(Number(output.trim()));
      else reject(new Error(`rofi exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

// Keys to bind for a menu: its buttons' keys, then the menu-wide ones
function menuKeys(menu) {
  return [...new Set([...menu.entries.map(entry => entry.key).filter(Boolean), ...(menu.keys ?? [])])];
}

function activeArgs(menu) {
  const active = menu.entries.flatMap((entry, index) => (entry.active ? [index] : []));
  return active.length ? ['-a', active.join(',')] : [];
}

// A rasi string literal
function rasiString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// A rasi string literal holding Pango markup. rasi rejects a string holding a line break or a quoted part,
// escaped or not, so lines are joined with its \n escape, the markup can use only attribute-free tags
// such as <b>, and quotes and backslashes in the text become entities.
function rasiMarkup(text) {
  const escaped = String(text).replace(/\\/g, '&#92;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return `"${escaped.replace(/\n/g, '\\n')}"`;
}

// One line per entry, icon and key first, under the item's summary; the status goes last in the message
export function minimalView(extraArgs = [], spawnProcess = spawn) {
  return menu => {
    const message = [menu.message, menu.status?.join('  ·  ')].filter(Boolean).join('\n');
    const input = menu.entries.map(entry => [entry.icon, entry.key, entry.label].filter(Boolean).join('  ')).join('\n');
    return runRofi([
      '-p', menu.prompt, ...(message ? ['-mesg', message] : []), ...activeArgs(menu), ...extraArgs
    ], `${input}\n`, spawnProcess, menuKeys(menu));
  };
}

// Buttons per row at most in submenus
const PANEL_COLUMNS = 7;

// A button's markup: a large icon over its key (dimmed) and caption. Highlighted buttons have a bold
// caption, and ones that do not apply to the item are drawn faded.
function buttonMarkup(entry) {
  const caption = escapeMarkup(entry.caption ?? entry.label).replace(/\|/g, '¦');
  const key = entry.key ? `<span alpha="55%">${escapeMarkup(entry.key)}</span>  ` : '';
  const text = `<span font_size="x-large">${entry.icon || ' '}</span>\n${key}${entry.active ? `<b>${caption}</b>` : caption}`;
  return entry.disabled ? `<span alpha="35%">${text}</span>` : text;
}

// A grid of buttons under a preview banner, titled with the item's file name, with the item's details and
// the menu's status side by side. Entries hold a line break, so they are separated by | instead; three
// lines of height fit the large icon and caption.
export function panelView(extraArgs = [], spawnProcess = spawn, theme = PANEL_THEME) {
  return menu => {
    const lines = Math.ceil(menu.entries.length / (menu.columns ?? PANEL_COLUMNS));
    const columns = Math.ceil(menu.entries.length / lines);
    return runRofi([
      '-markup-rows', '-sep', '|', '-eh', '3', '-theme', theme,
      '-theme-str', `listview { columns: ${columns}; lines: ${lines}; }`,
      '-theme-str', `textbox-status { content: ${rasiMarkup(menu.status?.join('\n') || ' ')}; }`,
      ...(menu.preview ? ['-theme-str', `preview { background-image: url(${rasiString(menu.preview)}, width); }`] : []),
      '-p', menu.title ?? menu.prompt, '-mesg', menu.message || ' ', ...activeArgs(menu), ...extraArgs
    ], menu.entries.map(buttonMarkup).join('|'), spawnProcess, menuKeys(menu));
  };
}

// A rofi menu over the playback and rating commands for the monitor under the pointer (or --monitor).
// It stays open after each action until q, or Escape on the main menu; Escape in a submenu goes back.
// --random/--no-random and --query/--tag/--keywords apply to next and to the advance after keep and skip,
// and are shown beside the item's details; they are set only from the command line.
// Menus are built as { prompt, title, message, status, preview, entries: [{ icon, label, caption, key,
// active, disabled }], keys } and drawn by a view, which resolves to an entry index, { key } or null.
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

  // Each menu resolves to { quit: true }, { monitor } to retarget, or {} to show the main menu again.
  // Opened from a keybinding there is no terminal to read an error from, so errors are sent as
  // notifications. A failed action leaves the menu open; failing to read what plays closes it, since
  // every redraw would fail the same way.
  async open(options = {}) {
    let monitor;
    try {
      const style = this.style(options.style);
      // The filters are checked once here, so a mistyped query fails before the menu opens
      matchFilters(this.database, options);
      this.current = {
        style, show: this.viewFor(style),
        random: randomOrder(this.config.get().display, options.random),
        filters: { query: options.query, tag: options.tag, keywords: options.keywords }
      };
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
        throw error;
      }
      if (result.quit) return;
      if (result.monitor) monitor = result.monitor;
    }
  }

  // Runs a picked action; an error is announced and the menu stays open
  async attempt(action) {
    try {
      return (await action()) ?? {};
    } catch (error) {
      await notifyError(error.message, { logger: this.logger });
      return {};
    }
  }

  // The playing item: title (its file name), message (summary and details, Pango markup) and, for the
  // panel, a preview banner. e.g. "#412  video  3840x2160\n0:18 · 25 fps · ★★☆ · DP-1\nocean, waves"
  async describe(monitorName) {
    const { monitor, media, rating } = await this.control.selected(monitorName);
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
      message: [escapeMarkup(summary), body, adjustments && `<b>${escapeMarkup(adjustments)}</b>`].filter(Boolean).join('\n')
    };
  }

  // Order and filters for next, and the target monitor when there is more than one, as Pango markup lines
  // without attributes (see rasiMarkup): the name, then the value in bold
  status(monitor, monitors) {
    const { random, filters } = this.current;
    const field = (name, value) => `${name}  <b>${escapeMarkup(value)}</b>`;
    const lines = [field('random', random ? 'on' : 'off')];
    if (filters.query?.length) lines.push(field('query', filters.query.map(query => `"${query}"`).join(', ')));
    if (filters.tag?.length) lines.push(field('tags', filters.tag.join(', ')));
    if (filters.keywords?.length) lines.push(field('words', filters.keywords.join(', ')));
    if (monitors.length > 1) lines.push(`${field('monitor', monitor)}  (Tab)`);
    return lines;
  }

  show(menu) {
    return this.current.show(menu);
  }

  // Two fixed rows: next, keep 1-3, speed over prev, skip, undo, mode, dim, with keys n 1 2 3 s and
  // p 0 u m d. Buttons that do not apply to
  // the item stay in place, faded, and do nothing. Keep and skip always move on to the next item.
  async mainMenu(monitor) {
    const item = await this.describe(monitor);
    const { media } = item;
    const { monitors } = await this.control.state();
    const target = { monitor, random: this.current.random, ...this.current.filters };
    const video = Boolean(media && MODE_KINDS.video.includes(media.kind));
    const other = otherMode(getMode(this.database));
    const keep = value => ({
      icon: ICONS.keep, label: `keep ${value}`, key: String(value), disabled: !media, active: item.rating?.rating === value,
      run: () => this.rating.keep(value, { ...target, next: true })
    });
    const entries = [
      { icon: ICONS.next, label: 'next', key: 'n', run: () => this.display.next(target) },
      keep(1), keep(2), keep(3),
      { icon: ICONS.speed, label: 'speed ▸', caption: video && media.speed !== 1 ? `speed ${media.speed}` : 'speed', key: 's',
        disabled: !video, active: video && media.speed !== 1, run: () => this.stepMenu(monitor, 'speed', SPEEDS) },
      { icon: ICONS.prev, label: 'prev', key: 'p', run: () => this.display.prev({ monitor }) },
      { icon: ICONS.skip, label: 'skip', key: '0', disabled: !media, run: () => this.rating.skip(target) },
      { icon: ICONS.undo, label: 'undo', key: 'u', run: () => this.rating.undo() },
      { icon: ICONS[other], label: `mode: switch to ${other}s`, caption: 'mode', key: 'm', run: () => this.display.mode(other, { monitor }) },
      { icon: ICONS.dim, label: 'dim ▸', caption: media?.dim ? `dim ${media.dim}` : 'dim', key: 'd',
        disabled: !media, active: Boolean(media?.dim), run: () => this.stepMenu(monitor, 'dim', DIMS) }
    ];
    const keys = [QUIT_KEY, ...(monitors.length > 1 ? [MONITOR_KEY] : [])];

    const picked = await this.show({ prompt: 'backdrop', title: item.title, message: item.message, preview: item.preview,
      status: this.status(monitor, monitors), entries, keys, columns: MAIN_COLUMNS });
    if (picked === null || picked.key === QUIT_KEY) return { quit: true };
    if (picked.key === MONITOR_KEY) return this.attempt(() => this.monitorMenu(monitor));
    const entry = picked.key ? entries.find(candidate => candidate.key === picked.key) : entries[picked];
    if (!entry || entry.disabled) return {};
    return this.attempt(entry.run);
  }

  // Applies values until Escape, which goes back to the main menu, showing the new value each time
  async stepMenu(monitor, kind, values) {
    for (;;) {
      const item = await this.describe(monitor);
      if (!item.media) return {};
      const current = kind === 'speed' ? item.media.speed : item.media.dim;
      const prompt = `${kind} (now ${current})`;
      const entries = values.map(value => ({
        icon: ICONS[kind], label: value, active: Number(value) === current && !/^[+-]/.test(value)
      }));
      const picked = await this.show({ prompt, title: `${item.title}  ·  ${prompt}`, message: item.message, preview: item.preview,
        entries, keys: [QUIT_KEY], columns: values.length });
      if (picked === null) return {};
      if (picked.key === QUIT_KEY) return { quit: true };
      await this.display[kind](values[picked], { monitor });
    }
  }

  async monitorMenu(current) {
    const { monitors } = await this.control.state();
    const message = escapeMarkup(`Target for the menu's actions: ${current}`);
    const picked = await this.show({ prompt: 'monitor', title: 'monitor', message, columns: monitors.length,
      entries: monitors.map(monitor => ({ icon: ICONS.monitor, label: monitor.name, active: monitor.name === current })),
      keys: [QUIT_KEY] });
    if (picked === null) return {};
    if (picked.key === QUIT_KEY) return { quit: true };
    return { monitor: monitors[picked].name };
  }
}
