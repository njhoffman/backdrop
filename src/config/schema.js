import { SYMBOL_SETS } from '../utils/output.js';

// The checks for every setting outside the visualizer section (which src/visualizer/settings.js checks), run
// on the merged config when it loads, so a mistake stops every command at once with the key named, rather than
// failing somewhere later. Checks also convert: durations accept "90", "90s", "5m" or "1h" like the CLI's
// --image-duration and become seconds. validateConfig returns every problem, not only the first, for
// `backdrop doctor`.

export const ORDERS = ['shuffle', 'random'];
export const NOTIFY_MODES = ['commands', 'all', 'off'];
// How a video repeats: from the start again, or played backwards to the start and forwards again
export const VIDEO_LOOPS = ['loop', 'bounce'];
export const MENU_STYLES = ['panel', 'minimal'];
export const SYMBOL_MODES = ['auto', ...Object.keys(SYMBOL_SETS)];
export const PEXELS_IMAGE_SIZES = ['large', 'medium', 'small'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class Invalid extends Error {}

const fail = expected => { throw new Invalid(expected); };

// Seconds from 90, "90s", "1.5m" or "2h"; more than 0 unless allowZero
export function seconds(value, { allowZero = false } = {}) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(value).trim());
  const result = match && (typeof value === 'number' || typeof value === 'string')
    ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] ?? 's']
    : NaN;
  if (!(result > 0 || (allowZero && result === 0))) {
    fail(`a time such as 90, 90s, 5m or 1h${allowZero ? ' (0 loops videos forever)' : ''}`);
  }
  return result;
}

// "a, b or c"
const choices = allowed => (allowed.length > 1 ? `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}` : allowed[0]);
const oneOf = allowed => value => (allowed.includes(value) ? value : fail(choices(allowed)));
const boolean = value => (typeof value === 'boolean' ? value : fail('true or false'));
const text = value => (typeof value === 'string' ? value : fail('a string'));
const integer = (min, max = Infinity) => value => (Number.isInteger(value) && value >= min && value <= max
  ? value
  : fail(max === Infinity ? `a whole number from ${min}` : `a whole number from ${min} to ${max}`));
const positive = value => (typeof value === 'number' && value > 0 ? value : fail('a number above 0'));
const strings = value => (Array.isArray(value) && value.every(item => typeof item === 'string')
  ? value
  : fail('a list of strings'));
const list = value => (Array.isArray(value) ? value : fail('a list'));
const color = value => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fail('a color such as "#33aacc"'));

const threshold = value => (value === null || (typeof value === 'number' && value > 0) ? value : fail('a load above 0, or null for none'));
const waitTime = value => (value === 0 || value === '0' ? 0 : seconds(value));

// A check with what a form needs to know about its setting (src/services/ConfigService.js, the web Config page):
// kind (boolean, choice, integer, number, duration, strings, text, monitors, workspace, colors, list, secret),
// choices, min and max, nullable (null allowed, an empty field), allowZero (for durations) and help text
const field = (check, info) => Object.assign(value => check(value), { info });

// Key -> check, per section; a check returns the value to keep (converted) or throws Invalid
const SECTIONS = {
  display: {
    monitors: field(value => (value === 'auto' || (Array.isArray(value) && value.length && value.every(name => typeof name === 'string' && name.trim()))
      ? value
      : fail('auto or a list of output names such as [DP-1, HDMI-1]')),
    { kind: 'monitors', help: 'auto (every active output, from xrandr) or the outputs to use, such as DP-1' }),
    image_duration: field(value => seconds(value), { kind: 'duration', help: 'How long each image shows' }),
    video_duration: field(value => seconds(value, { allowZero: true }), {
      kind: 'duration', allowZero: true, help: 'Wall time per video before the next; shorter videos loop whole times that fit, 0 loops each forever'
    }),
    video_loop: field(oneOf(VIDEO_LOOPS), { kind: 'choice', choices: VIDEO_LOOPS, help: 'loop from the start, or bounce: backwards to the start, then forwards' }),
    bounce_cache_gb: field(value => (typeof value === 'number' && value >= 0 ? value : fail('a number of gigabytes, 0 for no limit')), {
      kind: 'number', min: 0, step: 1, help: 'Room for reversed copies of bouncing videos, in GB; 0 for no limit'
    }),
    smooth: field(boolean, { kind: 'boolean', help: 'Make smooth_fps copies of slowed videos with RIFE in the background, so they play without stutter' }),
    smooth_fps: field(integer(24, 240), { kind: 'integer', min: 24, max: 240, help: 'Frames a second a slowed video shows once smoothed' }),
    smooth_below: field(integer(1, 240), { kind: 'integer', min: 1, max: 240, help: 'Smooth only slowed videos that show fewer frames a second than this; copies made before stay' }),
    smooth_blend: field(boolean, { kind: 'boolean', help: 'Blend frames (mpv interpolation) while a slowed video has no smoothed copy yet' }),
    smooth_rife: field(text, { kind: 'text', help: 'The rife-ncnn-vulkan binary; its rife-v4.6 model folder sits beside it' }),
    smooth_cache_gb: field(value => (typeof value === 'number' && value >= 0 ? value : fail('a number of gigabytes, 0 for no limit')), {
      kind: 'number', min: 0, step: 1, help: 'Room for smoothed copies of slowed videos, in GB; 0 for no limit'
    }),
    allow_upscale: field(boolean, { kind: 'boolean', help: 'Show media smaller than the monitor' }),
    order: field(oneOf(ORDERS), { kind: 'choice', choices: ORDERS, help: 'How next with filters picks a match: random (any still ahead) or shuffle (the next in order)' }),
    notify: field(oneOf(NOTIFY_MODES), { kind: 'choice', choices: NOTIFY_MODES, help: 'Desktop notifications: on commands, on every load, or off' }),
    xwinwrap_args: field(strings, { kind: 'strings', help: 'xwinwrap arguments, one per line; -g geometry is added per monitor' }),
    mpv_args: field(strings, { kind: 'strings', help: 'Extra mpv options, one per line; mpv runs with --no-config' })
  },
  library: {
    import_dirs: field(strings, { kind: 'strings', help: 'Folders imported into the library, one per line' }),
    watch_imports: field(boolean, { kind: 'boolean', help: 'Import new files in those folders as they appear' }),
    default_import_rating: field(integer(1, 3), { kind: 'integer', min: 1, max: 3, help: 'Rating imported files are kept at' }),
    min_width: field(integer(0), { kind: 'integer', min: 0, help: 'Narrowest media kept, in pixels (either orientation)' }),
    min_height: field(integer(0), { kind: 'integer', min: 0, help: 'Lowest media kept, in pixels (either orientation)' }),
    trash_days: field(integer(0), { kind: 'integer', min: 0, help: 'Days skipped files stay in the trash; 0 keeps them' }),
    min_duration: field(value => seconds(value, { allowZero: true }), {
      kind: 'duration', allowZero: true, help: 'Shortest video searches save and downloads fetch; 0 for any length. Imports are not checked'
    })
  },
  menu: {
    style: field(oneOf(MENU_STYLES), { kind: 'choice', choices: MENU_STYLES, help: 'panel (preview, details, buttons) or minimal' }),
    rofi_args: field(strings, { kind: 'strings', help: 'Extra rofi arguments, one per line' }),
    workspace: field(value => (typeof value === 'boolean' || (typeof value === 'string' && value.trim())
      ? value
      : fail('true, false or a workspace name')), { kind: 'workspace', help: 'i3: an empty workspace while the menu is open (true: "backdrop", or a name); false to stay' })
  },
  web: {
    port: field(integer(1, 65535), { kind: 'integer', min: 1, max: 65535, help: 'Port `backdrop web` listens on; a taken one falls back to a free port' })
  },
  load: {
    enabled: field(boolean, { kind: 'boolean', help: 'Lighten the display while the system load is high' }),
    window: field(oneOf([1, 5, 15]), { kind: 'choice', choices: [1, 5, 15], help: 'Load average read: over 1, 5 or 15 minutes' }),
    image_above: field(threshold, { kind: 'number', min: 0, nullable: true, help: 'Load above which videos give way to images; empty for none' }),
    off_above: field(threshold, { kind: 'number', min: 0, nullable: true, help: 'Load above which the wallpaper and visualizer stop; above image_above; empty for none' }),
    resume_ratio: field(value => (typeof value === 'number' && value > 0 && value <= 1 ? value : fail('a number above 0, up to 1')), {
      kind: 'number', min: 0, max: 1, step: 0.05, help: 'A level ends once the load falls below this share of its threshold'
    }),
    sustain: field(waitTime, { kind: 'duration', allowZero: true, help: 'How long the load must stay above a threshold first' }),
    resume_after: field(waitTime, { kind: 'duration', allowZero: true, help: 'How long it must stay below before a level ends' })
  },
  screensaver: {
    idle: field(boolean, { kind: 'boolean', help: 'Start the screensaver when the desktop has been idle' }),
    idle_minutes: field(positive, { kind: 'number', min: 0, step: 1, help: 'Idle minutes before it starts' }),
    max_load: field(value => (value === null || (typeof value === 'number' && value > 0) ? value : fail('a number above 0, or null for no limit')), {
      kind: 'number', min: 0, nullable: true, help: 'No idle start above this load; empty for no limit'
    }),
    preset: field(value => (value === null || (typeof value === 'string' && value.trim()) ? value : fail('a preset name, or null to keep the running one')), {
      kind: 'text', nullable: true, help: 'Visualizer preset while it runs; empty keeps the running one'
    }),
    workspace: field(value => (typeof value === 'string' && value.trim() ? value : fail('a workspace name')), { kind: 'text', help: 'i3 workspace it shows on' }),
    on_enter: field(strings, { kind: 'strings', help: 'Command run on entering, one argument per line' }),
    on_leave: field(strings, { kind: 'strings', help: 'Command run on leaving, one argument per line' }),
    sources: field(strings, { kind: 'strings', help: 'Not read yet' }),
    streams: field(list, { kind: 'list', help: 'Not read yet; a YAML list, such as - { url: https://..., title: rain }' })
  },
  output: {
    symbols: field(oneOf(SYMBOL_MODES), { kind: 'choice', choices: SYMBOL_MODES, help: 'Symbols in the CLI\'s output: auto picks by terminal' }),
    progress_gradient: field(value => (Array.isArray(value) && value.length >= 2 && value.every(item => color(item))
      ? value
      : fail('a list of at least two colors such as ["#00c8ff", "#a050ff"]')), { kind: 'colors', help: 'Progress bar colors, at least two' })
  }
};

const SOURCES = {
  pexels: {
    api_key: field(text, { kind: 'secret', help: 'Pexels API key (PEXELS_API in the environment also works); never shown' }),
    per_page: field(integer(1, 80), { kind: 'integer', min: 1, max: 80, help: 'Results asked for per search page' }),
    image_min_size: field(oneOf(PEXELS_IMAGE_SIZES), { kind: 'choice', choices: PEXELS_IMAGE_SIZES, help: 'Smallest image variant considered' })
  }
};

// Every setting the checks know, with its info, as [{ key: 'display.order', keys: ['display', 'order'], kind, ... }],
// sources under sources.<name>
export function configFields() {
  const fields = [];
  for (const [section, checks] of Object.entries(SECTIONS)) {
    for (const [name, check] of Object.entries(checks)) fields.push({ key: `${section}.${name}`, keys: [section, name], ...check.info });
  }
  for (const [source, checks] of Object.entries(SOURCES)) {
    for (const [name, check] of Object.entries(checks)) fields.push({ key: `sources.${source}.${name}`, keys: ['sources', source, name], ...check.info });
  }
  return fields;
}

// A setting checked by its full key ('sources.pexels.per_page' too), throwing with the key named; returns the
// converted value
export function checkField(key, value) {
  const keys = key.split('.');
  const check = keys[0] === 'sources' ? SOURCES[keys[1]]?.[keys[2]] : SECTIONS[keys[0]]?.[keys[1]];
  if (!check || keys.length !== (keys[0] === 'sources' ? 3 : 2)) throw new Error(`Unknown setting: ${key}`);
  try {
    return check(value);
  } catch (error) {
    if (!(error instanceof Invalid)) throw error;
    throw new Error(`${key} must be ${error.message}, not ${describe(value)}`);
  }
}

const describe = value => (typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value));

// Checks one mapping against its checks, converting values in place; unknown keys are left to the
// unknown-key warnings
function checkSection(prefix, section, checks, errors) {
  if (!isObject(section)) {
    errors.push(`${prefix} must be a mapping of settings, not ${describe(section)}`);
    return;
  }
  for (const [key, check] of Object.entries(checks)) {
    if (section[key] === undefined) continue;
    try {
      section[key] = check(section[key]);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      errors.push(`${prefix}.${key} must be ${error.message}, not ${describe(section[key])}`);
    }
  }
}

// Checks the merged config (defaults with the file over them), converting values in place. Returns the
// problems as messages naming the key, e.g. 'display.image_duration must be a time such as 90, 90s, 5m or
// 1h, not "5 minutes"'.
export function validateConfig(config) {
  const errors = [];
  for (const [name, checks] of Object.entries(SECTIONS)) checkSection(name, config[name], checks, errors);
  const { image_above: imageAbove, off_above: offAbove } = isObject(config.load) ? config.load : {};
  if (typeof imageAbove === 'number' && typeof offAbove === 'number' && offAbove <= imageAbove) {
    errors.push(`load.off_above must be above load.image_above, not ${offAbove} with ${imageAbove}`);
  }
  if (!isObject(config.sources)) {
    errors.push(`sources must be a mapping of sources, not ${describe(config.sources)}`);
  } else {
    for (const [name, checks] of Object.entries(SOURCES)) {
      if (config.sources[name] !== undefined) checkSection(`sources.${name}`, config.sources[name], checks, errors);
    }
  }
  if (!isObject(config.paths)) errors.push(`paths must be a mapping of paths, not ${describe(config.paths)}`);
  else checkSection('paths', config.paths, Object.fromEntries(Object.keys(config.paths).map(key => [key, text])), errors);
  return errors;
}

// A single setting checked as validateConfig would ('display.notify', value), throwing with the key named;
// for code that takes a value from somewhere other than the loaded config
export function checkSetting(key, value) {
  const [section, name] = key.split('.');
  const check = SECTIONS[section]?.[name];
  if (!check) return value;
  try {
    return check(value);
  } catch (error) {
    if (!(error instanceof Invalid)) throw error;
    throw new Error(`${key} must be ${error.message}, not ${describe(value)}`);
  }
}
