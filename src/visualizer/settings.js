// The visualizer config section, checked and normalized. Errors name the key, since the daemon only logs
// them and `backdrop visualizer reload` prints them.

export const ENGINES = ['glava'];
export const MODULES = ['bars', 'graph', 'radial', 'circle', 'wave'];
export const AUDIO_BACKENDS = ['pulseaudio', 'fifo'];
export const ANCHORS = ['bottom', 'top', 'left', 'right', 'center', 'fill'];
const DIRECTIONS = { inward: 0, outward: 1 };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
function monitors(value, layout) {
  if (value === 'all') return { all: true, overrides: {} };
  if (Array.isArray(value)) {
    if (!value.every(name => typeof name === 'string' && name)) fail('monitors', 'all, a list of names or a mapping', value);
    return { all: false, overrides: Object.fromEntries(value.map(name => [name, layout])) };
  }
  if (!isObject(value)) fail('monitors', 'all, a list of names or a mapping', value);
  const overrides = {};
  for (const [name, entry] of Object.entries(value)) {
    if (entry === false) continue;
    if (entry === true) {
      overrides[name] = layout;
      continue;
    }
    if (!isObject(entry)) fail(`monitors.${name}`, 'true, false or a mapping with placement or rect', entry);
    overrides[name] = {
      placement: entry.placement ? placement(`monitors.${name}.placement`, { ...entry.placement }) : layout.placement,
      rect: entry.rect !== undefined ? rect(`monitors.${name}.rect`, entry.rect) : layout.rect
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

function knownOptions(module, value, known) {
  if (!isObject(value)) fail(module, 'a mapping', value);
  for (const name of Object.keys(value)) {
    if (!known.includes(name)) fail(`${module}.${name}`, `one of the ${module} options (${known.join(', ')})`, name);
  }
}

function moduleDefines(module, value) {
  const options = MODULE_OPTIONS[module];
  knownOptions(module, value, Object.keys(options));
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const [define, kind] = options[name];
    const convert = typeof kind === 'function' ? kind : OPTION_KINDS[kind];
    return [define, convert(`${module}.${name}`, item)];
  }));
}

// Typed options of the bars module as GLava #defines, with backdrop's defaults for the ones not given
function barsDefines(value) {
  knownOptions('bars', value, BARS_OPTIONS);
  return {
    BAR_WIDTH: integer('bars.width', value.width ?? 20, { min: 1 }),
    BAR_GAP: integer('bars.gap', value.gap ?? 1),
    BAR_OUTLINE_WIDTH: integer('bars.outline', value.outline ?? 0),
    AMPLIFY: integer('bars.amplify', value.amplify ?? 200, { min: 1 }),
    GRADIENT: integer('bars.gradient', value.gradient ?? 80, { min: 1 }),
    COLOR: gradientColor('bars.colors', value.colors ?? '#33aacc', 'd'),
    DIRECTION: DIRECTIONS[oneOf('bars.direction', value.direction ?? 'inward', Object.keys(DIRECTIONS))],
    FLIP: boolean('bars.flip', value.flip ?? false) ? 1 : 0,
    // Needed for "native" transparency to fade the bars
    USE_ALPHA: 1
  };
}

function defines(value) {
  if (!isObject(value)) fail('defines', 'a mapping of #define names to values', value);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) fail(`defines.${name}`, 'an upper-case GLSL name', name);
    if (typeof item === 'boolean') return [name, item ? 1 : 0];
    if (typeof item !== 'number' && (typeof item !== 'string' || /[\n\r]/.test(item))) fail(`defines.${name}`, 'a number, string or boolean', item);
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
function typedDefines(module, section) {
  const of = name => (name === 'bars' ? barsDefines(section.bars ?? {}) : moduleDefines(name, section[name] ?? {}));
  for (const name of MODULES) if (name !== module && section[name] !== undefined) of(name);
  return of(module);
}

export function visualizerSettings(section = {}) {
  if (!isObject(section)) fail('', 'a mapping', section);
  const module = oneOf('module', section.module ?? 'bars', MODULES);
  const layout = { placement: placement('placement', { ...section.placement }), rect: rect('rect', section.rect) };
  const glava = section.glava ?? {};
  if (!isObject(glava)) fail('glava', 'a mapping', glava);
  return {
    enabled: boolean('enabled', section.enabled ?? false),
    engine: oneOf('engine', section.engine ?? 'glava', ENGINES),
    module,
    audio: oneOf('audio', section.audio ?? 'pulseaudio', AUDIO_BACKENDS),
    source: text('source', section.source ?? 'auto', 'a device, sink or path, or auto'),
    // The whole window's opacity over the wallpaper, set as _NET_WM_WINDOW_OPACITY for the compositor
    opacity: fraction('opacity', section.opacity ?? 0.8),
    layout,
    monitors: monitors(section.monitors ?? 'all', layout),
    // Typed options first, so raw defines can override them
    defines: { ...typedDefines(module, section), ...defines(section.defines ?? {}) },
    requests: stringList('requests', section.requests ?? []),
    glava: {
      shaderDir: text('glava.shader_dir', glava.shader_dir ?? '/etc/xdg/glava', 'a path'),
      args: stringList('glava.args', glava.args ?? [])
    }
  };
}

// The layout for a monitor, or null when the visualizer does not run there
export function layoutFor(settings, name) {
  if (!settings.enabled) return null;
  if (settings.monitors.overrides[name]) return settings.monitors.overrides[name];
  return settings.monitors.all ? settings.layout : null;
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
