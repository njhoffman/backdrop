import { BUILTIN_PRESETS } from './presets.js';

// The visualizer config section, checked and normalized. Errors name the key, since the daemon only logs
// them and `backdrop visualizer reload` prints them.

export const ENGINES = ['glava'];
export const MODULES = ['bars', 'graph', 'radial', 'circle', 'wave'];
export const AUDIO_BACKENDS = ['pulseaudio', 'fifo'];
export const ANCHORS = ['bottom', 'top', 'left', 'right', 'center', 'fill'];
const DIRECTIONS = { inward: 0, outward: 1 };
export const PALETTE_SOURCES = ['config', 'wallpaper'];
export const PALETTE_PICKS = ['vivid', 'dominant', 'complement'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Settings shared by every instance, which an instance cannot set for itself
const SHARED_KEYS = ['enabled', 'engine', 'audio', 'source', 'glava', 'preset', 'presets', 'instances', 'only_while_playing', 'silence_grace'];
// Settings of one visualizer; at the top of the section they are the defaults every instance inherits
const INSTANCE_KEYS = ['name', 'module', 'monitors', 'placement', 'rect', 'opacity', 'palette', 'defines', 'requests', ...MODULES];
// What a preset cannot change
const PRESET_EXCLUDED = ['enabled', 'preset', 'presets'];

// Objects merge recursively; lists and scalars from the override replace the base
export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = isObject(value) && isObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

function fail(key, expected, value) {
  throw new Error(`visualizer.${key} must be ${expected}, not ${JSON.stringify(value)}`);
}

function oneOf(key, value, allowed) {
  if (!allowed.includes(value)) fail(key, allowed.join(', '), value);
  return value;
}

function integer(key, value, { min = 0, max = Infinity } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(key, max === Infinity ? `an integer from ${min}` : `an integer from ${min} to ${max}`, value);
  }
  return value;
}

function text(key, value, expected) {
  if (typeof value !== 'string' || !value.trim() || /["\n\r]/.test(value)) fail(key, expected, value);
  return value.trim();
}

function fraction(key, value) {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) fail(key, 'a number from 0 to 1', value);
  return value;
}

function boolean(key, value) {
  if (typeof value !== 'boolean') fail(key, 'true or false', value);
  return value;
}

// A length in pixels or a percentage of the monitor: 360, "25%"
export function length(key, value) {
  if (Number.isInteger(value) && value >= 0) return { px: value };
  const match = typeof value === 'string' && /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (match && Number(match[1]) <= 100) return { percent: Number(match[1]) };
  return fail(key, 'pixels or a percentage such as "25%"', value);
}

export function color(key, value) {
  if (typeof value !== 'string' || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    fail(key, 'a color such as "#33aacc" or "#33aacc80"', value);
  }
  return value.toLowerCase();
}

function placement(key, value) {
  if (!isObject(value)) fail(key, 'a mapping with anchor, width, height and margin', value);
  return {
    anchor: oneOf(`${key}.anchor`, value.anchor ?? 'bottom', ANCHORS),
    width: length(`${key}.width`, value.width ?? '100%'),
    height: length(`${key}.height`, value.height ?? '25%'),
    margin: length(`${key}.margin`, value.margin ?? 0)
  };
}

function rect(key, value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) fail(key, 'a mapping with x, y, width and height', value);
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(name => {
    if (value[name] === undefined) fail(`${key}.${name}`, 'set when rect is used', undefined);
    return [name, length(`${key}.${name}`, value[name])];
  }));
}

// all, a list of monitor names, or a mapping of names to true or to their own placement/rect
function monitors(value, layout, prefix = '') {
  if (value === 'all') return { all: true, overrides: {} };
  if (Array.isArray(value)) {
    if (!value.every(name => typeof name === 'string' && name)) fail(`${prefix}monitors`, 'all, a list of names or a mapping', value);
    return { all: false, overrides: Object.fromEntries(value.map(name => [name, layout])) };
  }
  if (!isObject(value)) fail(`${prefix}monitors`, 'all, a list of names or a mapping', value);
  const overrides = {};
  for (const [name, entry] of Object.entries(value)) {
    if (entry === false) continue;
    if (entry === true) {
      overrides[name] = layout;
      continue;
    }
    if (!isObject(entry)) fail(`${prefix}monitors.${name}`, 'true, false or a mapping with placement or rect', entry);
    overrides[name] = {
      placement: entry.placement ? placement(`${prefix}monitors.${name}.placement`, { ...entry.placement }) : layout.placement,
      rect: entry.rect !== undefined ? rect(`${prefix}monitors.${name}.rect`, entry.rect) : layout.rect
    };
  }
  return { all: false, overrides };
}

// One color, or two for a gradient across `position` pixels of GRADIENT, as a GLava COLOR. @fg: lets a
// later --pipe binding replace the color live.
function gradientColor(key, value, position) {
  const colors = Array.isArray(value) ? value : [value];
  if (!colors.length || colors.length > 2) fail(key, 'one color, or two for a gradient', value);
  const [from, to] = colors.map((item, index) => color(`${key}[${index}]`, item));
  return to ? `@fg:mix(${from}, ${to}, clamp(${position} / GRADIENT, 0, 1))` : `@fg:${from}`;
}

// A GLSL float literal
function glslFloat(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function number(key, value, { min = -Infinity, above = null } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (above !== null && value <= above)) {
    fail(key, above !== null ? `a number above ${above}` : min === -Infinity ? 'a number' : `a number from ${min}`, value);
  }
  return value;
}

// Converters from a typed option to a #define value, by kind
const OPTION_KINDS = {
  count: (key, value) => integer(key, value, { min: 1 }),
  size: (key, value) => glslFloat(number(key, value, { min: 0 })),
  width: (key, value) => glslFloat(number(key, value, { above: 0 })),
  offset: (key, value) => glslFloat(number(key, value)),
  flag: (key, value) => (boolean(key, value) ? 1 : 0),
  degrees: (key, value) => `(${glslFloat(number(key, value))} * PI / 180.0)`,
  foreground: (key, value) => `@fg:${color(key, value)}`,
  background: (key, value) => `@bg:${color(key, value)}`
};

// Typed options of the modules other than bars: option name -> [#define, kind or converter]. Only the
// options given are written; the rest keep GLava's defaults.
const MODULE_OPTIONS = {
  graph: {
    amplify: ['VSCALE', 'count'],
    colors: ['COLOR', (key, value) => gradientColor(key, value, 'pos')],
    gradient: ['GRADIENT', 'count'],
    direction: ['DIRECTION', (key, value) => ({ inward: 1, outward: -1 })[oneOf(key, value, ['inward', 'outward'])]],
    outline: ['DRAW_OUTLINE', 'flag'],
    outline_color: ['OUTLINE', 'background'],
    highlight: ['DRAW_HIGHLIGHT', 'flag'],
    anti_alias: ['ANTI_ALIAS', 'flag'],
    join_channels: ['JOIN_CHANNELS', 'flag'],
    flip: ['INVERT', 'flag']
  },
  radial: {
    radius: ['C_RADIUS', 'size'],
    line: ['C_LINE', 'size'],
    bars: ['NBARS', 'count'],
    width: ['BAR_WIDTH', 'width'],
    amplify: ['AMPLIFY', 'count'],
    colors: ['COLOR', (key, value) => gradientColor(key, value, 'd')],
    gradient: ['GRADIENT', 'count'],
    rotate: ['ROTATE', 'degrees'],
    outline_color: ['OUTLINE', 'background'],
    offset_x: ['CENTER_OFFSET_X', 'offset'],
    offset_y: ['CENTER_OFFSET_Y', 'offset']
  },
  circle: {
    radius: ['C_RADIUS', 'size'],
    line: ['C_LINE', 'size'],
    color: ['OUTLINE', 'foreground'],
    amplify: ['AMPLIFY', 'count'],
    rotate: ['ROTATE', 'degrees'],
    fill: ['C_FILL', 'flag'],
    smooth: ['C_SMOOTH', 'flag']
  },
  wave: {
    color: ['BASE_COLOR', 'foreground'],
    min_thickness: ['MIN_THICKNESS', 'size'],
    max_thickness: ['MAX_THICKNESS', 'size'],
    amplify: ['AMPLIFY', 'count'],
    outline_color: ['OUTLINE', 'background']
  }
};

const BARS_OPTIONS = ['width', 'gap', 'outline', 'amplify', 'colors', 'gradient', 'direction', 'flip'];

// Rejects keys of a mapping that are not in known, naming what is (key is the mapping's full key)
function knownKeys(key, value, known, what) {
  if (!isObject(value)) fail(key, 'a mapping', value);
  for (const name of Object.keys(value)) {
    if (!known.includes(name)) fail(`${key ? `${key}.` : ''}${name}`, `one of the ${what} (${known.join(', ')})`, name);
  }
}

function moduleDefines(module, value, prefix = '') {
  const options = MODULE_OPTIONS[module];
  knownKeys(`${prefix}${module}`, value, Object.keys(options), `${module} options`);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const [define, kind] = options[name];
    const convert = typeof kind === 'function' ? kind : OPTION_KINDS[kind];
    return [define, convert(`${prefix}${module}.${name}`, item)];
  }));
}

// Each module's foreground color: its #define, the typed option that sets it, the color when the option is
// not given (backdrop's for bars, GLava's own for the rest) and the gradient's position variable
const PIPED_COLORS = {
  bars: { define: 'COLOR', option: 'colors', fallback: '#33aacc', position: 'd' },
  graph: { define: 'COLOR', option: 'colors', fallback: ['#802a2a', '#4f4f92'], position: 'pos' },
  radial: { define: 'COLOR', option: 'colors', fallback: ['#cc3333', '#cca0a0'], position: 'd' },
  circle: { define: 'OUTLINE', option: 'color', fallback: '#333333' },
  wave: { define: 'BASE_COLOR', option: 'color', fallback: '#b33373' }
};

function paletteSettings(value, prefix) {
  const key = name => `${prefix}palette.${name}`;
  knownKeys(`${prefix}palette`, value, ['source', 'pick', 'min_contrast'], 'palette settings');
  const minContrast = value.min_contrast ?? 3;
  if (typeof minContrast !== 'number' || !(minContrast >= 1 && minContrast <= 21)) fail(key('min_contrast'), 'a contrast ratio from 1 to 21', minContrast);
  return {
    source: oneOf(key('source'), value.source ?? 'config', PALETTE_SOURCES),
    pick: oneOf(key('pick'), value.pick ?? 'vivid', PALETTE_PICKS),
    minContrast
  };
}

// With palette.source: wallpaper, the module's foreground #define reads its colors from GLava's stdin
// (--pipe): `@fg:` for one color, `mix(@fg:, @fg2:, ...)` for a gradient, so each end can change. Returns
// that #define and the configured colors as #rrggbbaa, which the visualizer sends as soon as it starts:
// GLava draws nothing until every piped value has arrived.
function pipedColors(module, raw, prefix) {
  const { define, option, fallback, position } = PIPED_COLORS[module];
  if (raw.defines?.[define] !== undefined) {
    fail(`${prefix}defines.${define}`, `left out with palette.source: wallpaper (set ${module}.${option} instead)`, raw.defines[define]);
  }
  const value = raw[module]?.[option] ?? fallback;
  const colors = (Array.isArray(value) ? value : [value]).map((item, index) => color(`${prefix}${module}.${option}[${index}]`, item));
  const [from, to] = colors;
  const opaque = item => (item.length === 7 ? `${item}ff` : item);
  return to
    // GLava reads a default up to the next whitespace, so a comma right after one would be taken into it
    ? { define: [define, `mix(@fg:${from} , @fg2:${to} , clamp(${position} / GRADIENT, 0, 1))`], pipe: { fg: opaque(from), fg2: opaque(to) } }
    : { define: [define, `@fg:${from}`], pipe: { fg: opaque(from) } };
}

// Typed options of the bars module as GLava #defines, with backdrop's defaults for the ones not given
function barsDefines(value, prefix = '') {
  const key = name => `${prefix}bars.${name}`;
  knownKeys(`${prefix}bars`, value, BARS_OPTIONS, 'bars options');
  return {
    BAR_WIDTH: integer(key('width'), value.width ?? 20, { min: 1 }),
    BAR_GAP: integer(key('gap'), value.gap ?? 1),
    BAR_OUTLINE_WIDTH: integer(key('outline'), value.outline ?? 0),
    AMPLIFY: integer(key('amplify'), value.amplify ?? 200, { min: 1 }),
    GRADIENT: integer(key('gradient'), value.gradient ?? 80, { min: 1 }),
    COLOR: gradientColor(key('colors'), value.colors ?? '#33aacc', 'd'),
    DIRECTION: DIRECTIONS[oneOf(key('direction'), value.direction ?? 'inward', Object.keys(DIRECTIONS))],
    FLIP: boolean(key('flip'), value.flip ?? false) ? 1 : 0,
    // Needed for "native" transparency to fade the bars
    USE_ALPHA: 1
  };
}

function defines(value, prefix = '') {
  if (!isObject(value)) fail(`${prefix}defines`, 'a mapping of #define names to values', value);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) fail(`${prefix}defines.${name}`, 'an upper-case GLSL name', name);
    if (typeof item === 'boolean') return [name, item ? 1 : 0];
    if (typeof item !== 'number' && (typeof item !== 'string' || /[\n\r]/.test(item))) fail(`${prefix}defines.${name}`, 'a number, string or boolean', item);
    return [name, item];
  }));
}

function stringList(key, value) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && !/[\n\r]/.test(item))) {
    fail(key, 'a list of strings', value);
  }
  return value;
}

// The active module's typed options; the sections of the other modules are checked too, so a mistake shows
// before switching to them
function typedDefines(module, section, prefix) {
  const of = name => (name === 'bars' ? barsDefines(section.bars ?? {}, prefix) : moduleDefines(name, section[name] ?? {}, prefix));
  for (const name of MODULES) if (name !== module && section[name] !== undefined) of(name);
  return of(module);
}

// One visualizer from its merged settings
function instance(raw, prefix) {
  const module = oneOf(`${prefix}module`, raw.module ?? 'bars', MODULES);
  const layout = { placement: placement(`${prefix}placement`, { ...raw.placement }), rect: rect(`${prefix}rect`, raw.rect) };
  const palette = paletteSettings(raw.palette ?? {}, prefix);
  // Typed options first, so raw defines can override them
  const allDefines = { ...typedDefines(module, raw, prefix), ...defines(raw.defines ?? {}, prefix) };
  let pipe = null;
  if (palette.source === 'wallpaper') {
    const piped = pipedColors(module, raw, prefix);
    allDefines[piped.define[0]] = piped.define[1];
    pipe = piped.pipe;
  }
  return {
    name: raw.name,
    module,
    // The window's opacity over the wallpaper, set as _NET_WM_WINDOW_OPACITY for the compositor
    opacity: fraction(`${prefix}opacity`, raw.opacity ?? 0.8),
    layout,
    monitors: monitors(raw.monitors ?? 'all', layout, prefix),
    palette,
    // The values GLava reads from stdin and the configured colors for them ({ fg } or { fg, fg2 }), or null
    pipe,
    defines: allDefines,
    requests: stringList(`${prefix}requests`, raw.requests ?? [])
  };
}

// The section with any preset laid over it, normalized; prefix leads every key in an error
function normalize(raw, prefix) {
  knownKeys(prefix.replace(/\.$/, ''), raw, [...SHARED_KEYS, ...INSTANCE_KEYS.filter(key => key !== 'name')], 'visualizer settings');
  const glava = raw.glava ?? {};
  if (!isObject(glava)) fail(`${prefix}glava`, 'a mapping', glava);
  const settings = {
    enabled: boolean(`${prefix}enabled`, raw.enabled ?? false),
    engine: oneOf(`${prefix}engine`, raw.engine ?? 'glava', ENGINES),
    audio: oneOf(`${prefix}audio`, raw.audio ?? 'pulseaudio', AUDIO_BACKENDS),
    source: text(`${prefix}source`, raw.source ?? 'auto', 'a device, sink or path, or auto'),
    // Run only while the audio source plays, stopping silenceGrace seconds after it goes quiet
    onlyWhilePlaying: boolean(`${prefix}only_while_playing`, raw.only_while_playing ?? false),
    silenceGrace: number(`${prefix}silence_grace`, raw.silence_grace ?? 10, { min: 0 }),
    glava: {
      shaderDir: text(`${prefix}glava.shader_dir`, glava.shader_dir ?? '/etc/xdg/glava', 'a path'),
      args: stringList(`${prefix}glava.args`, glava.args ?? [])
    }
  };
  if (settings.onlyWhilePlaying && settings.audio !== 'pulseaudio') {
    fail(`${prefix}only_while_playing`, 'false with audio: fifo (only PulseAudio or PipeWire output can be watched)', true);
  }

  const defaults = Object.fromEntries(Object.entries(raw).filter(([key]) => INSTANCE_KEYS.includes(key)));
  if (raw.instances === undefined) {
    settings.instances = [instance({ ...defaults, name: 'main' }, prefix)];
    return settings;
  }
  if (!Array.isArray(raw.instances) || !raw.instances.length) fail(`${prefix}instances`, 'a list of visualizers', raw.instances);
  const names = new Set();
  settings.instances = raw.instances.map((item, index) => {
    if (!isObject(item)) fail(`${prefix}instances[${index}]`, 'a mapping', item);
    const name = item.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) fail(`${prefix}instances[${index}].name`, 'a name of letters, digits, - or _', name);
    if (names.has(name)) fail(`${prefix}instances[${index}].name`, 'unique among the instances', name);
    names.add(name);
    const key = `${prefix}instances.${name}.`;
    knownKeys(key.replace(/\.$/, ''), item, INSTANCE_KEYS, 'visualizer instance settings');
    return instance(deepMerge(defaults, item), key);
  });
  return settings;
}

// The section's presets, the built-in ones first so the section's can replace them by name
export function presetsOf(section = {}) {
  const own = section.presets ?? {};
  if (!isObject(own)) fail('presets', 'a mapping of preset names to settings', own);
  return { ...BUILTIN_PRESETS, ...own };
}

// Changes from the visualizer menu ({ instance name: settings }) laid over the section with its preset: over
// the section itself when it has no instances (its one instance is main), else over each named instance
export function applyLive(raw, live) {
  if (!live || !Object.keys(live).length) return raw;
  if (!isObject(live)) fail('live', 'a mapping of instance names to settings', live);
  for (const [name, changes] of Object.entries(live)) {
    if (!isObject(changes)) fail(`live.${name}`, 'a mapping of settings', changes);
    knownKeys(`live.${name}`, changes, INSTANCE_KEYS.filter(key => key !== 'name'), 'visualizer instance settings');
  }
  if (raw.instances === undefined) return live.main ? deepMerge(raw, live.main) : raw;
  if (!Array.isArray(raw.instances)) return raw;
  return { ...raw, instances: raw.instances.map(item => (isObject(item) && live[item.name] ? deepMerge(item, live[item.name]) : item)) };
}

// The section as the active preset and the menu's changes make it, before normalizing
function effectiveRaw(section, { preset, live } = {}) {
  const base = Object.fromEntries(Object.entries(section).filter(([key]) => key !== 'presets' && key !== 'preset'));
  const active = preset !== undefined ? preset : section.preset ?? null;
  const presets = presetsOf(section);
  const raw = active !== null && presets[active] ? deepMerge(base, presets[active]) : base;
  return { raw: applyLive(raw, live), active };
}

// GLava's own amplify for the modules backdrop does not default (bars: backdrop's 200)
const AMPLIFY_DEFAULTS = { bars: 200, graph: 300, radial: 300, circle: 150, wave: 500 };

// What the visualizer menu shows and steps for one instance: { module, opacity, anchor, palette: { source,
// pick, min_contrast }, amplify, colors (the module's color option, as a list) }
export function instanceLook(section = {}, options = {}, name = 'main') {
  const { raw } = effectiveRaw(section, options);
  const defaults = Object.fromEntries(Object.entries(raw).filter(([key]) => INSTANCE_KEYS.includes(key)));
  const item = raw.instances === undefined ? defaults : deepMerge(defaults, (raw.instances ?? []).find(entry => entry?.name === name) ?? {});
  const module = item.module ?? 'bars';
  const { option, fallback } = PIPED_COLORS[module];
  const colors = item[module]?.[option] ?? fallback;
  return {
    module,
    opacity: item.opacity ?? 0.8,
    anchor: item.placement?.anchor ?? 'bottom',
    palette: { source: 'config', pick: 'vivid', min_contrast: 3, ...item.palette },
    amplify: item[module]?.amplify ?? AMPLIFY_DEFAULTS[module],
    colors: Array.isArray(colors) ? colors : [colors],
    colorOption: option
  };
}

// The look of the active preset with the menu's changes, as one preset to save: for a section without
// instances the preset's settings with main's changes, else the instances list with each one's changes
export function lookAsPreset(section = {}, { preset, live } = {}) {
  const active = preset !== undefined ? preset : section.preset ?? null;
  const own = active !== null ? presetsOf(section)[active] ?? {} : {};
  const { raw } = effectiveRaw(section, { preset, live: {} });
  if (raw.instances === undefined) return deepMerge(own, live?.main ?? {});
  return { ...own, instances: applyLive(raw, live).instances };
}

// The visualizer section normalized, with its active preset laid over it: preset (`backdrop visualizer
// preset`) when given, else visualizer.preset, then the visualizer menu's changes (live). Every preset is
// checked, so a mistake in one shows before it is used. Returns { enabled, engine, audio, source,
// onlyWhilePlaying, silenceGrace, glava, instances: [{ name, module, opacity, layout, monitors, palette, pipe,
// defines, requests }], preset, presets }.
export function visualizerSettings(section = {}, { preset, live } = {}) {
  if (!isObject(section)) fail('', 'a mapping', section);
  const base = Object.fromEntries(Object.entries(section).filter(([key]) => key !== 'presets' && key !== 'preset'));
  const presets = presetsOf(section);
  const settings = normalize(base, '');
  for (const [name, value] of Object.entries(presets)) {
    if (!isObject(value)) fail(`presets.${name}`, 'a mapping of visualizer settings', value);
    for (const key of PRESET_EXCLUDED) if (value[key] !== undefined) fail(`presets.${name}.${key}`, 'left out of a preset', value[key]);
    normalize(deepMerge(base, value), `presets.${name}.`);
  }
  const active = preset !== undefined ? preset : section.preset ?? null;
  if (active === null) {
    const current = live && Object.keys(live).length ? normalize(applyLive(base, live), '') : settings;
    return { ...current, preset: null, presets: Object.keys(presets) };
  }
  if (!presets[active]) fail('preset', `one of the presets (${Object.keys(presets).join(', ')})`, active);
  return { ...normalize(applyLive(deepMerge(base, presets[active]), live), `presets.${active}.`), preset: active, presets: Object.keys(presets) };
}

// An instance's layout on a monitor, or null when it does not run there
export function layoutFor(instanceSettings, name) {
  if (instanceSettings.monitors.overrides[name]) return instanceSettings.monitors.overrides[name];
  return instanceSettings.monitors.all ? instanceSettings.layout : null;
}

function resolve(size, total) {
  return size.px !== undefined ? Math.min(size.px, total) : Math.round(total * size.percent / 100);
}

// Absolute root-window geometry { x, y, width, height } for a monitor ({ x, y, width, height })
export function resolveGeometry(monitor, { placement: place, rect: box }) {
  if (box) {
    const width = resolve(box.width, monitor.width);
    const height = resolve(box.height, monitor.height);
    return {
      x: monitor.x + Math.min(resolve(box.x, monitor.width), monitor.width - width),
      y: monitor.y + Math.min(resolve(box.y, monitor.height), monitor.height - height),
      width, height
    };
  }
  // The margin keeps the box off every edge; the anchor then places it inside what is left
  const marginX = Math.min(resolve(place.margin, monitor.width), Math.floor(monitor.width / 2));
  const marginY = Math.min(resolve(place.margin, monitor.height), Math.floor(monitor.height / 2));
  const inner = { x: marginX, y: marginY, width: monitor.width - 2 * marginX, height: monitor.height - 2 * marginY };
  const fill = place.anchor === 'fill';
  const width = fill ? inner.width : resolve(place.width, inner.width);
  const height = fill ? inner.height : resolve(place.height, inner.height);
  const centerX = inner.x + Math.round((inner.width - width) / 2);
  const centerY = inner.y + Math.round((inner.height - height) / 2);
  const position = {
    bottom: [centerX, inner.y + inner.height - height],
    top: [centerX, inner.y],
    left: [inner.x, centerY],
    right: [inner.x + inner.width - width, centerY],
    center: [centerX, centerY],
    fill: [inner.x, inner.y]
  }[place.anchor];
  return { x: monitor.x + position[0], y: monitor.y + position[1], width, height };
}
