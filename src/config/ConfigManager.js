import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import { closestMatches } from '../utils/closest.js';
import { validateConfig } from './schema.js';
import { visualizerSettings } from '../visualizer/settings.js';

const APP_NAME = 'backdrop';

function xdgDir(envVar, fallback) {
  return path.join(process.env[envVar] || path.join(os.homedir(), fallback), APP_NAME);
}

function runtimeDir() {
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, APP_NAME);
  }
  return path.join(os.tmpdir(), `${APP_NAME}-${os.userInfo().uid}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A null over a mapping or list default is that type left empty, as YAML reads a section or list whose
// entries are all commented out: the mapping keeps its defaults, the list is empty
function emptied(value, base) {
  if (value !== null) return value;
  if (isPlainObject(base)) return {};
  return Array.isArray(base) ? [] : value;
}

// Objects merge recursively; arrays and scalars from the override replace the default
export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, raw] of Object.entries(override || {})) {
    const value = emptied(raw, base[key]);
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

// Sections that check their own keys, more strictly than the defaults could (src/visualizer/settings.js)
const SELF_CHECKED = ['visualizer'];

// Keys in user that the defaults do not have, as warnings naming the closest known key. Mappings are
// followed where both sides have one; lists and values are left to the code that reads them.
export function unknownKeys(user, defaults, prefix = '') {
  const warnings = [];
  for (const [name, value] of Object.entries(user || {})) {
    const key = `${prefix}${name}`;
    if (!Object.hasOwn(defaults, name)) {
      const [closest] = closestMatches(name, Object.keys(defaults), 1);
      warnings.push(`Unknown config key "${key}"${closest ? `; closest: "${prefix}${closest}"` : ''}`);
    } else if (!SELF_CHECKED.includes(key) && isPlainObject(value) && isPlainObject(defaults[name])) {
      warnings.push(...unknownKeys(value, defaults[name], `${key}.`));
    }
  }
  return warnings;
}

const isBlockMap = node => YAML.isMap(node) && !node.flow;

function lineStart(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

// Where an entry's own text ends: its deepest last value. A block collection's range runs on over the
// blank lines and comments after it, up to the next content, which would take those lines into the entry.
function entryEnd(pair) {
  const { value } = pair;
  if (!value) return pair.key.range[1];
  if ((YAML.isMap(value) || YAML.isSeq(value)) && !value.flow && value.items.length) {
    const last = value.items.at(-1);
    return YAML.isPair(last) ? entryEnd(last) : entryEnd({ key: last, value: last });
  }
  return value.range[1];
}

// The end of the line holding offset (its line break's index, or the end of text)
function lineEndAt(text, offset) {
  const end = text.indexOf('\n', offset);
  return end === -1 ? text.length : end;
}

// keys: value in YAML block style, each line indented by indent
function renderBlock(keys, value, indent) {
  const nested = keys.reduceRight((inner, key) => ({ [key]: inner }), value);
  return YAML.stringify(nested, { indent: 2, lineWidth: 0 }).trimEnd().split('\n').map(line => `${' '.repeat(indent)}${line}`).join('\n');
}

// text with keys set to value by replacing or inserting only that entry's lines, found through the parsed
// document's source ranges. The deepest existing block mapping on the path gets the missing rest of it as a
// new last entry, at the indentation of its other keys; an existing entry is replaced in place. The result
// is parsed again and checked, so a layout this cannot edit fails instead of writing a wrong file.
export function spliceYaml(text, keys, value) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`Failed to edit config: ${doc.errors[0].message}`);
  let parent = doc.contents;
  let output;
  if (parent === null || (YAML.isMap(parent) && !parent.items.length)) {
    output = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${renderBlock(keys, value, 0)}\n`;
  } else {
    for (let depth = 0; ; depth++) {
      if (!isBlockMap(parent)) throw new Error(`Failed to edit config: ${keys.slice(0, depth).join('.') || 'the file'} is not a block mapping`);
      const pair = parent.items.find(item => YAML.isScalar(item.key) && item.key.value === keys[depth]);
      const column = parent.items[0].key.range[0] - lineStart(text, parent.items[0].key.range[0]);
      if (pair && depth === keys.length - 1) {
        // The entry's own lines, from its key to the end of its value, trailing comment included
        const start = lineStart(text, pair.key.range[0]);
        const end = lineEndAt(text, Math.max(pair.key.range[1], entryEnd(pair) - 1));
        output = `${text.slice(0, start)}${renderBlock([keys[depth]], value, column)}${text.slice(end)}`;
        break;
      }
      if (pair && isBlockMap(pair.value)) {
        parent = pair.value;
        continue;
      }
      if (pair) throw new Error(`Failed to edit config: ${keys.slice(0, depth + 1).join('.')} is not a block mapping`);
      // After the last entry's lines
      const at = lineEndAt(text, entryEnd(parent.items.at(-1)) - 1);
      output = `${text.slice(0, at)}\n${renderBlock(keys.slice(depth), value, column)}${text.slice(at)}`;
      break;
    }
  }
  const check = YAML.parseDocument(output);
  if (check.errors.length || JSON.stringify(check.getIn(keys)?.toJSON?.() ?? check.getIn(keys)) !== JSON.stringify(value)) {
    throw new Error('Failed to edit config: the edited file would not hold the value');
  }
  return output;
}

// The visualizer section's problem as a message, or null
function visualizerProblem(section) {
  try {
    visualizerSettings(section);
    return null;
  } catch (error) {
    return error.message;
  }
}

export class ConfigManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'config.yaml');
    this.config = null;
    this.userConfig = null;
    // True after initialize() wrote a new default file; the CLI reports it
    this.created = false;
    // Keys in the file that no setting uses, most likely typos; the CLI and the daemon report them
    this.warnings = [];
    // Values that do not check out (schema.js); loading fails on them unless tolerant (backdrop doctor)
    this.errors = [];
    // A visualizer section that does not check out: not fatal, the daemon runs the wallpaper without it
    this.visualizerError = null;
  }

  getDefaultPaths() {
    const dataDir = xdgDir('XDG_DATA_HOME', path.join('.local', 'share'));
    const cacheDir = xdgDir('XDG_CACHE_HOME', '.cache');

    return {
      database: path.join(dataDir, 'backdrop.db'),
      logfile: path.join(dataDir, 'backdrop.log'),
      media: path.join(dataDir, 'media'),
      trash: path.join(dataDir, 'trash'),
      inbox: path.join(cacheDir, 'inbox'),
      thumbnails: path.join(cacheDir, 'thumbnails'),
      runtime: runtimeDir()
    };
  }

  // Settings written to a new config file; paths are left out so XDG locations apply
  getUserDefaults() {
    return {
      sources: {
        pexels: {
          api_key: '',
          per_page: 80,
          image_min_size: 'large'
        }
      },
      library: {
        import_dirs: [],
        default_import_rating: 2,
        min_width: 1024,
        min_height: 768,
        trash_days: 30
      },
      display: {
        monitors: 'auto',
        image_duration: 300,
        video_duration: 600,
        allow_upscale: false,
        order: 'random',
        notify: 'commands',
        xwinwrap_args: ['-b', '-s', '-st', '-sp', '-nf', '-ov', '-fdt', '-ni'],
        mpv_args: []
      },
      menu: {
        style: 'panel',
        rofi_args: [],
        workspace: true
      },
      visualizer: {
        enabled: false,
        engine: 'glava',
        monitors: 'all',
        module: 'bars',
        audio: 'pulseaudio',
        source: 'auto',
        opacity: 0.8,
        placement: { anchor: 'bottom', width: '100%', height: '25%', margin: 0 },
        bars: { width: 20, gap: 1, outline: 0, amplify: 200, colors: ['#000000', '#33aacc'], gradient: 80, direction: 'inward', flip: false },
        defines: {},
        requests: [],
        glava: { shader_dir: '/etc/xdg/glava', args: [] }
      },
      screensaver: {
        idle_minutes: 10,
        sources: ['rated_videos'],
        streams: []
      },
      output: {
        symbols: 'auto',
        progress_gradient: ['#00c8ff', '#a050ff']
      }
    };
  }

  getDefaultConfig() {
    return { ...this.getUserDefaults(), paths: this.getDefaultPaths() };
  }

  // tolerant keeps going on invalid values, leaving them in errors (backdrop doctor reports them)
  async initialize({ tolerant = false } = {}) {
    try {
      await fs.ensureDir(path.dirname(this.configPath));

      if (await fs.pathExists(this.configPath)) {
        await this.loadConfig({ tolerant });
      } else {
        await this.createDefaultConfig();
      }
    } catch (error) {
      throw new Error(`Failed to initialize config: ${error.message}`);
    }
  }

  // Every value is checked (schema.js, converting durations to seconds); one that does not check out fails
  // the load with every problem listed, unless tolerant
  async loadConfig({ tolerant = false } = {}) {
    try {
      const configContent = await fs.readFile(this.configPath, 'utf8');
      this.userConfig = YAML.parse(configContent) || {};
      this.warnings = unknownKeys(this.userConfig, this.getDefaultConfig());
      const merged = deepMerge(this.getDefaultConfig(), this.userConfig);
      this.errors = validateConfig(merged);
      this.visualizerError = visualizerProblem(merged.visualizer);
      if (this.errors.length && !tolerant) throw new Error(`invalid values in ${this.configPath}:\n  ${this.errors.join('\n  ')}`);
      this.config = this.normalize(merged);
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }

  // Re-reads the file and takes only one section from it, so a running daemon can apply that section
  // without its paths or other settings changing underneath it. Warnings follow the whole file.
  async reloadSection(key) {
    const fresh = new ConfigManager(this.configPath);
    await fresh.loadConfig();
    this.config[key] = fresh.config[key];
    this.userConfig[key] = fresh.userConfig[key];
    this.warnings = fresh.warnings;
  }

  async createDefaultConfig() {
    try {
      this.userConfig = this.getUserDefaults();
      await fs.writeFile(this.configPath, YAML.stringify(this.userConfig));
      this.config = this.normalize(this.getDefaultConfig());
      this.created = true;
    } catch (error) {
      throw new Error(`Failed to create default config: ${error.message}`);
    }
  }

  // Expands paths and fills credentials from the environment without writing them back to disk
  normalize(config) {
    for (const key of Object.keys(config.paths)) {
      config.paths[key] = this.expandPath(config.paths[key]);
    }
    // Not a list only in a tolerant load, where the error is already recorded
    if (Array.isArray(config.library?.import_dirs)) config.library.import_dirs = config.library.import_dirs.map(dir => this.expandPath(dir));

    if (config.sources?.pexels && !config.sources.pexels.api_key && process.env.PEXELS_API) {
      config.sources.pexels.api_key = process.env.PEXELS_API;
    }

    return config;
  }

  get() {
    if (!this.config) {
      throw new Error('Config not initialized');
    }
    return this.config;
  }

  // Writes only what the user set, so environment credentials and XDG defaults stay out of the file
  async save() {
    try {
      await fs.writeFile(this.configPath, YAML.stringify(this.userConfig));
    } catch (error) {
      throw new Error(`Failed to save config: ${error.message}`);
    }
  }

  // Sets one value in the file itself (keys: ['visualizer', 'presets', 'calm']), leaving every other byte as
  // it was, comments and their alignment included, unlike save(), which writes the whole file anew (see
  // spliceYaml). Written to a temporary file and renamed, so a watching daemon never reads half of it.
  async setInFile(keys, value) {
    const text = await fs.readFile(this.configPath, 'utf8').catch(error => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, spliceYaml(text, keys, value));
    await fs.rename(temporary, this.configPath);
  }

  // Whether the file itself sets keys (['visualizer', 'presets', 'calm'])
  async fileHas(keys) {
    const text = await fs.readFile(this.configPath, 'utf8').catch(() => '');
    return YAML.parseDocument(text).hasIn(keys);
  }

  set(key, value) {
    if (!this.config) {
      throw new Error('Config not initialized');
    }

    for (const target of [this.config, this.userConfig]) {
      const keys = key.split('.');
      let current = target;

      for (let i = 0; i < keys.length - 1; i++) {
        if (!isPlainObject(current[keys[i]])) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = value;
    }
  }

  getPath(key) {
    return this.get().paths[key];
  }

  getSource(name) {
    return this.get().sources[name];
  }

  expandPath(pathStr) {
    if (typeof pathStr !== 'string') {
      return pathStr;
    }
    return pathStr
      .replace(/^~(?=$|\/)/, os.homedir())
      .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name) => process.env[name] ?? match);
  }
}
