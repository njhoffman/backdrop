import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import { closestMatches } from '../utils/closest.js';
import { LOAD_PER_CPU_KEYS, MAX_LOAD_PER_CPU, validateConfig } from './schema.js';
import { visualizerSettings } from '../visualizer/settings.js';

const APP_NAME = 'backdrop';

function xdgDir(envVar, fallback) {
  return path.join(process.env[envVar] || path.join(os.homedir(), fallback), APP_NAME);
}

// Where the inbox was before 2.67.0; moveLegacyInbox (src/library/inbox.js) moves what is left there
export function legacyInboxPath() {
  return path.join(xdgDir('XDG_CACHE_HOME', '.cache'), 'inbox');
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

// The file's per-machine section: { <hostname>: { section: { key: value } } }, each laid over the rest of the file on
// the machine of that name, so one tracked file can hold, say, smooth_gpu for the desktop and offload.hosts for the laptop
export const HOSTS_KEY = 'hosts';

// The key of hosts that names this machine: its hostname, else its short name (minerva for minerva.lan); null for none
export function hostKey(hosts, hostname) {
  if (!isPlainObject(hosts) || !hostname) return null;
  if (Object.hasOwn(hosts, hostname)) return hostname;
  const short = hostname.split('.')[0];
  return Object.hasOwn(hosts, short) ? short : null;
}

// The file split into the settings every machine shares and the per-machine sections, with what is wrong in the latter
export function splitHosts(file) {
  const { [HOSTS_KEY]: hosts = null, ...shared } = isPlainObject(file) ? file : {};
  const errors = [];
  const sections = {};
  if (hosts !== null && !isPlainObject(hosts)) {
    errors.push(`${HOSTS_KEY} must be a mapping of hostnames to settings`);
  } else {
    for (const [name, section] of Object.entries(hosts ?? {})) {
      if (section === null) continue;
      if (!isPlainObject(section)) errors.push(`${HOSTS_KEY}.${name} must be a mapping of settings`);
      else if (Object.hasOwn(section, HOSTS_KEY)) errors.push(`${HOSTS_KEY}.${name} cannot hold ${HOSTS_KEY} itself`);
      else sections[name] = section;
    }
  }
  return { shared, sections, errors };
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

// text without keys, by cutting that entry's own lines (its trailing comment too) and nothing else. A mapping the
// removal would leave empty goes with it, up to the top, since an empty `display:` reads as null, not as the defaults.
// A key the file does not set leaves it as it is. Checked like spliceYaml's edits.
export function removeYaml(text, keys) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`Failed to edit config: ${doc.errors[0].message}`);
  if (!doc.hasIn(keys)) return text;
  let depth = keys.length;
  while (depth > 1) {
    const parent = doc.getIn(keys.slice(0, depth - 1), true);
    if (!YAML.isMap(parent) || parent.items.length !== 1) break;
    depth--;
  }
  let parent = doc.contents;
  let pair;
  for (let index = 0; index < depth; index++) {
    if (!isBlockMap(parent)) throw new Error(`Failed to edit config: ${keys.slice(0, index).join('.') || 'the file'} is not a block mapping`);
    pair = parent.items.find(item => YAML.isScalar(item.key) && item.key.value === keys[index]);
    parent = pair.value;
  }
  const start = lineStart(text, pair.key.range[0]);
  const end = lineEndAt(text, Math.max(pair.key.range[1], entryEnd(pair) - 1));
  const output = `${text.slice(0, start)}${text.slice(Math.min(end + 1, text.length))}`;
  const check = YAML.parseDocument(output);
  if (check.errors.length || check.hasIn(keys)) throw new Error('Failed to edit config: the edited file would still hold the key');
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
    // The CPU count loads are divided by (convertAbsoluteLoads); tests replace it
    this.cpus = () => os.availableParallelism();
    // This machine's name, matched against the file's hosts section (hostKey); tests replace it
    this.hostname = () => os.hostname();
    this.config = null;
    // What the file sets for this machine: its shared settings with this machine's hosts section laid over them
    this.userConfig = null;
    // The hosts key the file has for this machine, or null (hostKey)
    this.host = null;
    // What this machine's hosts section sets, or null
    this.hostSection = null;
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
      // Unrated downloads: data, not cache, since a cleaner that empties ~/.cache would lose them (once there, see
      // legacyInboxPath)
      inbox: path.join(dataDir, 'inbox'),
      thumbnails: path.join(cacheDir, 'thumbnails'),
      // Reversed copies of videos that bounce (display.video_loop, `backdrop bounce`)
      bounce: path.join(cacheDir, 'bounce'),
      // Smoothed (smooth_fps) copies of slowed videos (display.smooth), and their reversed copies for bounce
      smooth: path.join(cacheDir, 'smooth'),
      // Sources and copies of the jobs `backdrop worker` makes for other machines
      worker: path.join(cacheDir, 'worker'),
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
          max_pages: 0,
          image_min_size: 'large'
        }
      },
      library: {
        import_dirs: [],
        watch_imports: true,
        default_import_rating: 2,
        min_width: 1024,
        min_height: 768,
        trash_days: 30,
        min_duration: 5
      },
      display: {
        monitors: 'auto',
        image_duration: 300,
        video_duration: 120,
        video_loop: 'loop',
        bounce_cache_gb: 10,
        bounce_idle_load: null,
        bounce_idle_minutes: 10,
        bounce_stop_load: 0.75,
        smooth: false,
        smooth_fps: 30,
        smooth_below: 20,
        smooth_blend: true,
        smooth_rife: 'rife-ncnn-vulkan',
        smooth_gpu: -1,
        smooth_idle_load: 0.25,
        smooth_idle_minutes: 10,
        smooth_stop_load: 0.75,
        smooth_cache_gb: 10,
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
      // Encodes made on another machine (src/offload/RemoteEncoder.js, `backdrop worker` there)
      offload: {
        hosts: [],
        worker_command: 'backdrop worker',
        memory_max: '4G'
      },
      // `backdrop web` (docs/specs/web.md); a taken port falls back to a free one
      web: {
        port: 7737
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
        glava: { shader_dir: 'auto', args: [] }
      },
      load: {
        enabled: false,
        window: 1,
        image_above: 1.5,
        off_above: 3,
        resume_ratio: 0.75,
        sustain: 60,
        resume_after: 300
      },
      screensaver: {
        idle: false,
        idle_minutes: 10,
        max_load: null,
        preset: 'screensaver',
        preset_without_lyrics: 'screensaver-instrumental',
        next_on_song: true,
        hide_pointer: true,
        hint: true,
        workspace: 'backdrop',
        on_enter: ['polybar-msg cmd hide'],
        on_leave: ['polybar-msg cmd show'],
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
      const { shared, sections, errors: hostErrors } = splitHosts(YAML.parse(configContent) || {});
      this.host = hostKey(sections, this.hostname());
      this.hostSection = this.host ? sections[this.host] : null;
      this.userConfig = this.host ? deepMerge(shared, sections[this.host]) : shared;
      const converted = await this.convertAbsoluteLoads();
      const defaults = this.getDefaultConfig();
      this.warnings = [
        ...unknownKeys(shared, defaults),
        ...Object.entries(sections).flatMap(([name, section]) => unknownKeys(section, defaults, `${HOSTS_KEY}.${name}.`)),
        ...converted
      ];
      const merged = deepMerge(defaults, this.userConfig);
      this.errors = [...hostErrors, ...validateConfig(merged)];
      // Another machine's section is checked as that machine would load it, but only warned about here
      for (const [name, section] of Object.entries(sections)) {
        if (name === this.host) continue;
        for (const problem of validateConfig(deepMerge(defaults, deepMerge(shared, section)))) {
          if (!this.errors.includes(problem)) this.warnings.push(`On ${name} (${HOSTS_KEY}.${name}): ${problem}`);
        }
      }
      this.visualizerError = visualizerProblem(merged.visualizer);
      if (this.errors.length && !tolerant) throw new Error(`invalid values in ${this.configPath}:\n  ${this.errors.join('\n  ')}`);
      this.config = this.normalize(merged);
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }

  // Before 3.0.0 the load thresholds were absolute load averages, and every config file backdrop wrote spelled out
  // 12 and 24. One over the per-CPU limit can only be such a value: it is divided by this machine's CPU count, which
  // keeps its meaning here, and written back into the file (setInFile keeps the rest). Returns a note for each.
  async convertAbsoluteLoads() {
    const notes = [];
    for (const keys of LOAD_PER_CPU_KEYS) {
      const section = this.userConfig?.[keys[0]];
      const value = section?.[keys[1]];
      if (typeof value !== 'number' || value <= MAX_LOAD_PER_CPU) continue;
      const cpus = Math.max(1, this.cpus());
      const perCpu = Math.round((value / cpus) * 100) / 100;
      section[keys[1]] = perCpu;
      const written = await this.setInFile(keys, perCpu).then(() => true, () => false);
      notes.push(`${keys.join('.')} was the load ${value}; it is now a load per CPU, ${perCpu} on these ${cpus} CPUs${written ? ' (written to the config file)' : ''}`);
    }
    return notes;
  }

  // Re-reads the file and takes only one section from it, so a running daemon can apply that section
  // without its paths or other settings changing underneath it. Warnings follow the whole file.
  async reloadSection(key) {
    const fresh = new ConfigManager(this.configPath);
    fresh.hostname = this.hostname;
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

  // Sets one value in the file itself (keys: ['visualizer', 'presets', 'calm']), leaving every other byte as
  // it was, comments and their alignment included (see spliceYaml); the only way backdrop writes an existing
  // config, so a hand-kept file never loses its comments or layout. Written to a temporary file and renamed, so a watching daemon never reads half of it.
  // A value this machine's hosts section sets is written there, so the change applies here and nowhere else; any
  // other goes to the shared settings.
  async setInFile(keys, value) {
    const text = await this.readFile();
    await this.writeFile(spliceYaml(text, this.writeKeys(text, keys), value));
  }

  // Drops keys from the file itself, so their defaults apply again: from the shared settings and from this machine's
  // hosts section; the rest of the file stays as it was (see removeYaml)
  async removeInFile(keys) {
    const text = await this.readFile();
    let output = removeYaml(text, keys);
    const own = this.ownKeys(output);
    if (own && YAML.parseDocument(output).hasIn([...own, ...keys])) output = removeYaml(output, [...own, ...keys]);
    if (output !== text) await this.writeFile(output);
  }

  // Whether the file itself sets keys (['visualizer', 'presets', 'calm']) for this machine: in the shared settings or
  // in its hosts section
  async fileHas(keys) {
    const text = await this.readFile().catch(() => '');
    const document = YAML.parseDocument(text);
    const own = this.ownKeys(text);
    return document.hasIn(keys) || Boolean(own && document.hasIn([...own, ...keys]));
  }

  // The path of this machine's hosts section in the file as it is now (['hosts', 'minerva']), or null
  ownKeys(text) {
    const { sections } = splitHosts(YAML.parse(text) || {});
    const host = hostKey(sections, this.hostname());
    return host ? [HOSTS_KEY, host] : null;
  }

  // Where a change of keys goes: under this machine's hosts section when that sets keys or replaces a mapping above them
  // (a list or value there), else keys themselves
  writeKeys(text, keys) {
    const own = this.ownKeys(text);
    if (!own) return keys;
    const document = YAML.parseDocument(text);
    for (let depth = 1; depth <= keys.length; depth++) {
      const node = document.getIn([...own, ...keys.slice(0, depth)], true);
      if (node === undefined) return keys;
      if (depth === keys.length || !YAML.isMap(node)) return [...own, ...keys];
    }
    return keys;
  }

  async readFile() {
    return fs.readFile(this.configPath, 'utf8').catch(error => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  }

  // Written to a temporary file and renamed, so a watching daemon never reads half of it
  async writeFile(text) {
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, this.configPath);
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
