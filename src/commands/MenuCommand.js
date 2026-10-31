import { checkSetting } from '../config/schema.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { DisplayCommand } from './DisplayCommand.js';
import { RatingCommand } from './RatingCommand.js';
import { MODE_KINDS, getMode, otherMode, randomOrder } from '../display/Playlist.js';
import { readNextFilters, resolveNextFilters } from '../display/nextFilters.js';
import { matchFilters } from '../library/match.js';
import { thumbnailFor } from '../library/thumbnail.js';
import { describeNotification, escapeMarkup, notifyError } from '../utils/notify.js';
import { formatAdjustments } from '../utils/mediaView.js';
import { formatSetting } from '../utils/output.js';
import { enterWorkspace, workspaceName } from '../utils/workspace.js';
import { sendControl } from '../display/control.js';
import { ANCHORS, MODULES, PALETTE_PICKS, instanceLook, lookAsPreset, presetsOf, visualizerSettings } from '../visualizer/settings.js';

export { MENU_STYLES } from '../config/schema.js';
export const PANEL_THEME = fileURLToPath(new URL('../../share/rofi/backdrop-panel.rasi', import.meta.url));

// Wallpaper videos only ever play slowed down, so +0.1 stops at 1 (see stepMenu)
const SPEEDS = ['0.4', '0.5', '0.65', '0.75', '0.85', '1', '-0.1', '+0.1'];
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
// z opens the visualizer menu from the main one; i picks the instance it changes when there are several
const VISUALIZER_KEY = 'z';
const INSTANCE_KEY = 'i';

// Font Awesome glyphs for the visualizer menu: power, list, cube, adjust, volume, arrows, brush, undo, save
const VISUALIZER_ICONS = {
  power: '\uf011', preset: '\uf03a', module: '\uf1b2', opacity: '\uf042', amplify: '\uf028',
  position: '\uf047', colors: '\uf1fc', reset: '\uf0e2', save: '\uf0c7', instance: '\uf001'
};
const OPACITIES = ['0.2', '0.4', '0.6', '0.8', '1', '-0.1', '+0.1'];
const AMPLIFIES = ['100', '150', '200', '300', '400', '500', '-50', '+50'];
// Fixed gradients for the swatches, base color first (bars run from the first to the second)
const SWATCHES = {
  ocean: ['#003a5c', '#33aacc'], ember: ['#3d0c02', '#ff7a33'], forest: ['#0b3d20', '#7ad151'],
  violet: ['#2a0a4a', '#b07cff'], gold: ['#4a3200', '#ffd166'], mono: ['#202020', '#e0e0e0']
};
const PRESET_NAME = /^[A-Za-z0-9_-]+$/;

// A step value applied to current: an absolute value, or +/- a step, kept within min and max
export function stepValue(value, current, { min = -Infinity, max = Infinity, digits = 2 } = {}) {
  const next = /^[+-]/.test(value) ? current + Number(value) : Number(value);
  const factor = 10 ** digits;
  return Math.min(max, Math.max(min, Math.round(next * factor) / factor));
}

// Asks for a line of text with rofi; resolves to it, or null when dismissed or empty
export function askText(extraArgs = [], spawnProcess = spawn) {
  return (prompt, message) => new Promise((resolve, reject) => {
    const child = spawnProcess('rofi', ['-dmenu', '-p', prompt, ...(message ? ['-mesg', message] : []), ...extraArgs],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('rofi is not installed') : error));
    child.on('close', code => resolve(code === 0 && output.trim() ? output.trim() : null));
    child.stdin.end('');
  });
}

// The main menu is a fixed grid of this many columns, so buttons and their keys never move
const MAIN_COLUMNS = 5;

// Runs rofi -dmenu on the given input and resolves to the picked index, { key } for one of keys, or null
// when dismissed. -format i returns the index, so labels never have to be parsed back; -no-custom rejects
// typed text. keys are bound to kb-custom-1.., which make rofi exit with 10..; Tab moves between entries
// by default, so it is unbound first. A single click runs an entry: rofi's default selects on click and
// accepts on double click.
function runRofi(args, input, spawnProcess, keys = []) {
  const keyArgs = ['-me-select-entry', '', '-me-accept-entry', 'MousePrimary',
    ...keys.flatMap((key, index) => [`-kb-custom-${index + 1}`, key])];
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
// caption, and ones that do not apply to the item are drawn faded. The icon is markup itself (a glyph, or
// a colored swatch span), so it is not escaped.
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
// --random/--no-random and --query/--tag/--keywords are stored like next's (see nextFilters.js), apply to
// next and to the advance after keep and skip, and are shown beside the item's details. With i3 the menu
// shows an empty workspace (menu.workspace) while open, so the wallpaper is in full view.
// Menus are built as { prompt, title, message, status, preview, entries: [{ icon, label, caption, key,
// active, disabled }], keys } and drawn by a view, which resolves to an entry index, { key } or null.
export class MenuCommand {
  constructor(config, database, logger, {
    display, rating, view, thumbnail = thumbnailFor, workspace = enterWorkspace, ask, control = sendControl
  } = {}) {
    this.config = config;
    this.ask = ask ?? askText(config.get().menu?.rofi_args ?? []);
    this.sendControl = control;
    this.database = database;
    this.logger = logger;
    this.display = display ?? new DisplayCommand(config, database, logger);
    this.rating = rating ?? new RatingCommand(config, database, logger, { control: this.display.control });
    this.view = view;
    this.thumbnail = thumbnail;
    this.workspace = workspace;
  }

  get control() {
    return this.display.control;
  }

  style(requested) {
    return checkSetting('menu.style', requested ?? this.config.get().menu?.style ?? 'panel');
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
    let leave;
    try {
      const style = this.style(options.style);
      const workspace = workspaceName(this.config.get().menu?.workspace);
      // The filters are checked here, so a mistyped query fails before the menu opens or is stored
      matchFilters(this.database, options);
      this.current = { style, show: this.viewFor(style) };
      monitor = (await this.control.targetMonitor(options.monitor)).name;
      await resolveNextFilters(this.config.get().paths.runtime, options, { persist: true });
      leave = await this.workspace(workspace, monitor, { logger: this.logger });
    } catch (error) {
      await notifyError(error.message, { logger: this.logger });
      throw error;
    }
    try {
      // `backdrop menu visualizer`: only the visualizer menu, closed by Escape
      if (options.page === 'visualizer') {
        try {
          await this.visualizerMenu(monitor);
        } catch (error) {
          await notifyError(error.message, { logger: this.logger });
          throw error;
        }
        return;
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
    } finally {
      await leave();
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
    const { summary, body } = describeNotification({ monitor, media, rating, tags: this.database.getTags(media.id) }, { bold: true });
    const adjustments = formatAdjustments(media);
    const name = media.source === 'local' && media.original_name ? media.original_name : path.basename(media.path);
    const preview = this.current.style === 'panel'
      ? await this.thumbnail(media, this.config.get().paths.thumbnails, { logger: this.logger })
      : null;
    return {
      media, rating, preview, title: name,
      message: [summary, body, adjustments && `<b>${escapeMarkup(adjustments)}</b>`].filter(Boolean).join('\n')
    };
  }

  // Order and filters for next as stored now (next can change them while the menu is open), and the
  // target monitor when there is more than one, as Pango markup lines without attributes (see
  // rasiMarkup): the name, then the value in bold
  async status(monitor, monitors) {
    const filters = await readNextFilters(this.config.get().paths.runtime);
    const random = randomOrder(this.config.get().display, filters.random);
    const field = (name, value) => `${name}  <b>${escapeMarkup(value)}</b>`;
    const lines = [field('random', random ? 'on' : 'off')];
    if (filters.query?.length) lines.push(field('query', filters.query.map(query => `"${query}"`).join(', ')));
    if (filters.tag?.length) lines.push(field('tags', filters.tag.join(', ')));
    if (filters.keywords?.length) lines.push(field('words', filters.keywords.join(', ')));
    if (filters.image_duration !== undefined) lines.push(field('images', formatSetting(filters.image_duration)));
    if (filters.video_duration !== undefined) lines.push(field('videos', formatSetting(filters.video_duration)));
    lines.push(`${field('visualizer', 'menu')}  (${VISUALIZER_KEY})`);
    if (monitors.length > 1) lines.push(`${field('monitor', monitor)}  (Tab)`);
    return lines;
  }

  show(menu) {
    return this.current.show(menu);
  }

  // Two fixed rows: next, keep 1-3, speed over prev, skip, undo, mode, dim, with keys n 1 2 3 v and
  // p s u m d. Buttons that do not apply to the item stay in place, faded, and do nothing. Keep and skip
  // always move on to the next item, with the stored filters and order like next.
  async mainMenu(monitor) {
    const item = await this.describe(monitor);
    const { media } = item;
    const { monitors } = await this.control.state();
    const target = { monitor };
    const video = Boolean(media && MODE_KINDS.video.includes(media.kind));
    const other = otherMode(getMode(this.database));
    const keep = value => ({
      icon: ICONS.keep, label: `keep ${value}`, key: String(value), disabled: !media, active: item.rating?.rating === value,
      run: () => this.rating.keep(value, { ...target, next: true })
    });
    const entries = [
      { icon: ICONS.next, label: 'next', key: 'n', run: () => this.display.next(target) },
      keep(1), keep(2), keep(3),
      { icon: ICONS.speed, label: 'speed ▸', caption: video && media.speed !== 1 ? `speed ${media.speed}` : 'speed', key: 'v',
        disabled: !video, active: video && media.speed !== 1, run: () => this.stepMenu(monitor, 'speed', SPEEDS) },
      { icon: ICONS.prev, label: 'prev', key: 'p', run: () => this.display.prev({ monitor }) },
      { icon: ICONS.skip, label: 'skip', key: 's', disabled: !media, run: () => this.rating.skip(target) },
      { icon: ICONS.undo, label: 'undo', key: 'u', run: () => this.rating.undo() },
      { icon: ICONS[other], label: `mode: switch to ${other}s`, caption: 'mode', key: 'm', run: () => this.display.mode(other, { monitor }) },
      { icon: ICONS.dim, label: 'dim ▸', caption: media?.dim ? `dim ${media.dim}` : 'dim', key: 'd',
        disabled: !media, active: Boolean(media?.dim), run: () => this.stepMenu(monitor, 'dim', DIMS) }
    ];
    const keys = [QUIT_KEY, VISUALIZER_KEY, ...(monitors.length > 1 ? [MONITOR_KEY] : [])];

    const picked = await this.show({ prompt: 'backdrop', title: item.title, message: item.message, preview: item.preview,
      status: await this.status(monitor, monitors), entries, keys, columns: MAIN_COLUMNS });
    if (picked === null || picked.key === QUIT_KEY) return { quit: true };
    if (picked.key === MONITOR_KEY) return this.attempt(() => this.monitorMenu(monitor));
    if (picked.key === VISUALIZER_KEY) return this.attempt(() => this.visualizerMenu(monitor));
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
      await this.display[kind](this.step(kind, values[picked], current), { monitor });
    }
  }

  // +0.1 on speed stops at 1
  step(kind, value, current) {
    if (kind !== 'speed' || value !== '+0.1') return value;
    return Math.round(current * 100) + 10 > 100 ? '1' : value;
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

  // The visualizer: on/off, preset, module, opacity, amplify, position and colors of one instance, applied
  // live through control requests (visualizer_set) and kept until the daemon restarts; reset drops them and
  // save writes the look into the config as a preset. With several instances it asks which one first (i
  // switches). Resolves like the other menus: { quit: true } for q, {} for Escape.
  async visualizerMenu(monitor) {
    let instance = null;
    for (;;) {
      const state = await this.control.state();
      const visualizer = state.visualizer ?? {};
      const names = visualizer.instances?.length ? visualizer.instances : ['main'];
      if (!names.includes(instance)) {
        instance = names.length > 1 ? await this.instanceMenu(names, null) : names[0];
        if (instance === null) return {};
        if (instance.quit) return instance;
      }
      const section = this.config.get().visualizer;
      const options = { preset: visualizer.preset ?? null, live: visualizer.live ?? {} };
      const look = instanceLook(section, options, instance);
      const on = Boolean(visualizer.enabled);
      const item = await this.describe(monitor);
      const entries = [
        { icon: VISUALIZER_ICONS.power, label: on ? 'turn off' : 'turn on', caption: on ? 'on' : 'off', key: 'e', active: on,
          run: () => this.sendVisualizer(state, { visualizer: !on }) },
        { icon: VISUALIZER_ICONS.preset, label: 'preset ▸', caption: options.preset ?? 'preset', key: 'p', active: Boolean(options.preset),
          run: () => this.presetMenu(state, section, options.preset) },
        { icon: VISUALIZER_ICONS.module, label: 'module ▸', caption: look.module, key: 'm',
          run: () => this.pickMenu(state, instance, 'module', MODULES, look.module, module => ({ module })) },
        { icon: VISUALIZER_ICONS.opacity, label: 'opacity ▸', caption: `opacity ${look.opacity}`, key: 'o',
          run: () => this.visualizerStep(instance, 'opacity', OPACITIES, current => current.opacity,
            (value, current) => ({ opacity: stepValue(value, current, { min: 0.05, max: 1 }) })) },
        { icon: VISUALIZER_ICONS.amplify, label: 'amplify ▸', caption: `amplify ${look.amplify}`, key: 'a',
          run: () => this.visualizerStep(instance, 'amplify', AMPLIFIES, current => current.amplify,
            (value, current, now) => ({ [now.module]: { amplify: stepValue(value, current, { min: 10, digits: 0 }) } })) },
        { icon: VISUALIZER_ICONS.position, label: 'position ▸', caption: look.anchor, key: 'l',
          run: () => this.pickMenu(state, instance, 'position', ANCHORS, look.anchor, anchor => ({ placement: { anchor } })) },
        { icon: VISUALIZER_ICONS.colors, label: 'colors ▸', caption: look.palette.source === 'wallpaper' ? `wall ${look.palette.pick}` : 'fixed colors',
          key: 'c', active: look.palette.source === 'wallpaper', run: () => this.colorsMenu(instance) },
        { icon: VISUALIZER_ICONS.reset, label: 'reset', key: 'r', disabled: !Object.keys(options.live).length,
          run: () => this.sendVisualizer(state, { visualizer_reset: true }) },
        { icon: VISUALIZER_ICONS.save, label: 'save as preset', caption: 'save', key: 's', run: () => this.savePreset(state, section, options) }
      ];
      const status = this.visualizerStatus(state, instance, look, options, names);
      const keys = [QUIT_KEY, ...(names.length > 1 ? [INSTANCE_KEY] : [])];
      const message = visualizer.error ? `<b>visualizer off:</b> ${escapeMarkup(visualizer.error)}` : item.message;
      const picked = await this.show({ prompt: 'visualizer', title: `visualizer  ·  ${instance}`, message, preview: item.preview,
        status, entries, keys, columns: 5 });
      if (picked === null) return {};
      if (picked.key === QUIT_KEY) return { quit: true };
      if (picked.key === INSTANCE_KEY) {
        const chosen = await this.instanceMenu(names, instance);
        if (chosen?.quit) return chosen;
        if (chosen) instance = chosen;
        continue;
      }
      const entry = picked.key ? entries.find(candidate => candidate.key === picked.key) : entries[picked];
      if (!entry || entry.disabled) continue;
      const result = await this.attempt(entry.run);
      if (result.quit) return result;
    }
  }

  // Status lines: the instance when there are several, the preset, the colors the daemon last sent (with
  // palette.source: wallpaper), and whether menu changes are in effect
  visualizerStatus(state, instance, look, options, names) {
    const field = (name, value) => `${name}  <b>${escapeMarkup(value)}</b>`;
    const lines = [];
    if (names.length > 1) lines.push(`${field('instance', instance)}  (${INSTANCE_KEY})`);
    lines.push(field('preset', options.preset ?? 'none'));
    const sent = state.monitors?.flatMap(monitor => monitor.visualizers ?? []).find(item => item.instance === instance)?.colors;
    if (sent) lines.push(field('colors', Object.values(sent).map(value => value.slice(0, 7)).join(' to ')));
    else lines.push(field('colors', look.colors.join(' to ')));
    if (options.live[instance]) lines.push(field('changed', 'until restart (r resets)'));
    return lines;
  }

  async instanceMenu(names, current) {
    const picked = await this.show({ prompt: 'instance', title: 'visualizer instance', message: escapeMarkup('The visualizer this menu changes'),
      columns: names.length, entries: names.map(name => ({ icon: VISUALIZER_ICONS.instance, label: name, active: name === current })), keys: [QUIT_KEY] });
    if (picked === null) return null;
    if (picked.key === QUIT_KEY) return { quit: true };
    return names[picked];
  }

  // Sends a control request to the daemon and waits for it; a visualizer_set the daemon refused shows as an error
  async sendVisualizer(state, change) {
    const runtime = this.config.get().paths.runtime;
    const current = await this.sendControl(runtime, state, change, { logfile: this.config.get().paths.logfile });
    if (change.visualizer_set && current) {
      const { instance, changes } = change.visualizer_set;
      const applied = current.visualizer?.live?.[instance];
      if (!applied || !Object.keys(changes).every(key => applied[key] !== undefined)) {
        throw new Error(`The daemon refused the change; see ${this.config.get().paths.logfile}`);
      }
    }
    return {};
  }

  // Checks one instance's change against the section, preset and earlier changes, then sends it
  async changeVisualizer(instance, changes) {
    const state = await this.control.state();
    const visualizer = state.visualizer ?? {};
    const live = { ...(visualizer.live ?? {}) };
    live[instance] = { ...(live[instance] ?? {}), ...changes };
    visualizerSettings(this.config.get().visualizer, { preset: visualizer.preset ?? null, live });
    return this.sendVisualizer(state, { visualizer_set: { instance, changes } });
  }

  // One choice from values (modules, anchors), applied, then back to the visualizer menu
  async pickMenu(state, instance, name, values, current, toChanges) {
    const picked = await this.show({ prompt: name, title: `visualizer  ·  ${name}`, message: escapeMarkup(`${name}: ${current}`),
      columns: values.length, entries: values.map(value => ({ icon: VISUALIZER_ICONS[name === 'module' ? 'module' : 'position'], label: value, active: value === current })),
      keys: [QUIT_KEY] });
    if (picked === null) return {};
    if (picked.key === QUIT_KEY) return { quit: true };
    if (values[picked] === current) return {};
    return this.changeVisualizer(instance, toChanges(values[picked]));
  }

  // Steps like the speed and dim menus: each pick applies at once and the menu shows the new value
  async visualizerStep(instance, name, values, read, toChanges) {
    for (;;) {
      const state = await this.control.state();
      const options = { preset: state.visualizer?.preset ?? null, live: state.visualizer?.live ?? {} };
      const look = instanceLook(this.config.get().visualizer, options, instance);
      const current = read(look);
      const picked = await this.show({ prompt: `${name} (now ${current})`, title: `visualizer  ·  ${name} ${current}`, message: escapeMarkup(`${name}: ${current}`),
        columns: values.length, entries: values.map(value => ({ icon: VISUALIZER_ICONS[name], label: value, active: Number(value) === current && !/^[+-]/.test(value) })),
        keys: [QUIT_KEY] });
      if (picked === null) return {};
      if (picked.key === QUIT_KEY) return { quit: true };
      const changes = toChanges(values[picked], current, look);
      await this.changeVisualizer(instance, changes);
    }
  }

  // Where the colors come from: fixed (the module's colors, or a swatch) or the wallpaper by a pick rule
  async colorsMenu(instance) {
    for (;;) {
      const state = await this.control.state();
      const options = { preset: state.visualizer?.preset ?? null, live: state.visualizer?.live ?? {} };
      const look = instanceLook(this.config.get().visualizer, options, instance);
      const wallpaper = look.palette.source === 'wallpaper';
      const dot = color => `<span foreground="${color}">\u25cf</span>`;
      const entries = [
        { icon: VISUALIZER_ICONS.colors, label: 'fixed', caption: 'fixed', active: !wallpaper, changes: { palette: { source: 'config' } } },
        ...PALETTE_PICKS.map(pick => ({
          icon: VISUALIZER_ICONS.colors, label: `wallpaper ${pick}`, caption: `wall ${pick}`, active: wallpaper && look.palette.pick === pick,
          changes: { palette: { source: 'wallpaper', pick } }
        })),
        ...Object.entries(SWATCHES).map(([name, pair]) => {
          const colors = look.colors.length === 2 ? pair : [pair[1]];
          return {
            icon: colors.map(dot).join(''), label: name, active: !wallpaper && JSON.stringify(look.colors) === JSON.stringify(colors),
            changes: { palette: { source: 'config' }, [look.module]: { [look.colorOption]: look.colors.length === 2 ? colors : colors[0] } }
          };
        })
      ];
      const picked = await this.show({ prompt: 'colors', title: 'visualizer  ·  colors', message: escapeMarkup(`colors: ${wallpaper ? `from the wallpaper (${look.palette.pick})` : look.colors.join(' to ')}`),
        columns: 5, entries, keys: [QUIT_KEY] });
      if (picked === null) return {};
      if (picked.key === QUIT_KEY) return { quit: true };
      await this.changeVisualizer(instance, entries[picked].changes);
    }
  }

  async presetMenu(state, section, active) {
    const names = Object.keys(presetsOf(section));
    const values = [null, ...names];
    const picked = await this.show({ prompt: 'preset', title: 'visualizer  ·  preset', message: escapeMarkup(`preset: ${active ?? 'none'}`),
      columns: Math.min(values.length, 5), entries: values.map(name => ({ icon: VISUALIZER_ICONS.preset, label: name ?? 'none', active: name === active })),
      keys: [QUIT_KEY] });
    if (picked === null) return {};
    if (picked.key === QUIT_KEY) return { quit: true };
    if (values[picked] === active) return {};
    // The section and preset are checked here, before the daemon sees them
    visualizerSettings(section, { preset: values[picked], live: state.visualizer?.live ?? {} });
    return this.sendVisualizer(state, { preset: values[picked] });
  }

  // Writes the active preset with the menu's changes into the config as a preset, keeping the file's other
  // lines and comments, then switches the daemon to it with the changes dropped, so nothing moves
  async savePreset(state, section, options) {
    const name = await this.ask('preset name', escapeMarkup(`Save the current look as visualizer.presets.<name> (letters, digits, - and _)${options.preset ? `; now: ${options.preset}` : ''}`));
    if (name === null) return {};
    if (!PRESET_NAME.test(name)) throw new Error(`A preset name is letters, digits, - and _, not "${name}"`);
    const exists = await this.config.fileHas(['visualizer', 'presets', name]) || Boolean(presetsOf(section)[name]);
    if (exists) {
      const picked = await this.show({ prompt: 'replace?', title: `replace preset ${name}?`, message: escapeMarkup(`A preset named ${name} exists`),
        columns: 2, entries: [{ icon: VISUALIZER_ICONS.save, label: 'replace' }, { icon: VISUALIZER_ICONS.reset, label: 'keep it' }], keys: [QUIT_KEY] });
      if (picked !== 0) return picked?.key === QUIT_KEY ? { quit: true } : {};
    }
    const look = lookAsPreset(section, options);
    // Checked as the daemon will read it
    visualizerSettings({ ...section, presets: { ...(section.presets ?? {}), [name]: look } }, { preset: name });
    await this.config.setInFile(['visualizer', 'presets', name], look);
    await this.sendVisualizer(state, { reload_config: true, visualizer_reset: true, preset: name });
    return {};
  }
}
