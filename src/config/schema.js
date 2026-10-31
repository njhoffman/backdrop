import { SYMBOL_SETS } from '../utils/output.js';

// The checks for every setting outside the visualizer section (which src/visualizer/settings.js checks), run
// on the merged config when it loads, so a mistake stops every command at once with the key named, rather than
// failing somewhere later. Checks also convert: durations accept "90", "90s", "5m" or "1h" like the CLI's
// --image-duration and become seconds. validateConfig returns every problem, not only the first, for
// `backdrop doctor`.

export const ORDERS = ['shuffle', 'random'];
export const NOTIFY_MODES = ['commands', 'all', 'off'];
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

// Key -> check, per section; a check returns the value to keep (converted) or throws Invalid
const SECTIONS = {
  display: {
    monitors: value => (value === 'auto' || (Array.isArray(value) && value.length && value.every(name => typeof name === 'string' && name.trim()))
      ? value
      : fail('auto or a list of output names such as [DP-1, HDMI-1]')),
    image_duration: value => seconds(value),
    video_duration: value => seconds(value, { allowZero: true }),
    allow_upscale: boolean,
    order: oneOf(ORDERS),
    notify: oneOf(NOTIFY_MODES),
    xwinwrap_args: strings,
    mpv_args: strings
  },
  library: {
    import_dirs: strings,
    default_import_rating: integer(1, 3),
    min_width: integer(0),
    min_height: integer(0),
    trash_days: integer(0)
  },
  menu: {
    style: oneOf(MENU_STYLES),
    rofi_args: strings,
    workspace: value => (typeof value === 'boolean' || (typeof value === 'string' && value.trim())
      ? value
      : fail('true, false or a workspace name'))
  },
  screensaver: {
    idle_minutes: positive,
    sources: strings,
    streams: list
  },
  output: {
    symbols: oneOf(SYMBOL_MODES),
    progress_gradient: value => (Array.isArray(value) && value.length >= 2 && value.every(item => color(item))
      ? value
      : fail('a list of at least two colors such as ["#00c8ff", "#a050ff"]'))
  }
};

const SOURCES = {
  pexels: {
    api_key: text,
    per_page: integer(1, 80),
    image_min_size: oneOf(PEXELS_IMAGE_SIZES)
  }
};

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
