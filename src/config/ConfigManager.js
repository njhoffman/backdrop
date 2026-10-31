import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import { closestMatches } from '../utils/closest.js';

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

export class ConfigManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'config.yaml');
    this.config = null;
    this.userConfig = null;
    // True after initialize() wrote a new default file; the CLI reports it
    this.created = false;
    // Keys in the file that no setting uses, most likely typos; the CLI and the daemon report them
    this.warnings = [];
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

  async initialize() {
    try {
      await fs.ensureDir(path.dirname(this.configPath));

      if (await fs.pathExists(this.configPath)) {
        await this.loadConfig();
      } else {
        await this.createDefaultConfig();
      }
    } catch (error) {
      throw new Error(`Failed to initialize config: ${error.message}`);
    }
  }

  async loadConfig() {
    try {
      const configContent = await fs.readFile(this.configPath, 'utf8');
      this.userConfig = YAML.parse(configContent) || {};
      this.warnings = unknownKeys(this.userConfig, this.getDefaultConfig());
      this.config = this.normalize(deepMerge(this.getDefaultConfig(), this.userConfig));
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
    config.library.import_dirs = config.library.import_dirs.map(dir => this.expandPath(dir));

    if (!config.sources.pexels.api_key && process.env.PEXELS_API) {
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
