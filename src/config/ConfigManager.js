import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';

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

// Objects merge recursively; arrays and scalars from the override replace the default
function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

export class ConfigManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'config.yaml');
    this.config = null;
    this.userConfig = null;
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
        trash_days: 30
      },
      display: {
        monitors: 'auto',
        image_duration: 300,
        allow_upscale: false,
        xwinwrap_args: ['-b', '-s', '-st', '-sp', '-nf', '-ov', '-fdt', '-ni'],
        mpv_args: []
      },
      screensaver: {
        idle_minutes: 10,
        sources: ['rated_videos'],
        streams: []
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
      this.config = this.normalize(deepMerge(this.getDefaultConfig(), this.userConfig));
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }

  async createDefaultConfig() {
    try {
      this.userConfig = this.getUserDefaults();
      await fs.writeFile(this.configPath, YAML.stringify(this.userConfig));
      this.config = this.normalize(this.getDefaultConfig());

      console.log(`Created default config file at: ${this.configPath}`);
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
