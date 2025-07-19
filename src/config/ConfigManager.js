import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';

export class ConfigManager {
  constructor() {
    this.configPath = path.join(os.homedir(), '.config', 'pexels.yaml');
    this.config = null;
  }

  getDefaultConfig() {
    const homeDir = os.homedir();
    
    return {
      api_key: process.env.PEXELS_API || '',
      paths: {
        logfile: path.join(homeDir, '.local', 'share', 'pexels', 'pexels.log'),
        database: path.join(homeDir, '.local', 'share', 'pexels', 'pexels.db'),
        videos_new: path.join(homeDir, '.cache', 'pexels', 'videos'),
        images_new: path.join(homeDir, '.cache', 'pexels', 'images'),
        videos_kept: path.join(homeDir, '.local', 'share', 'pexels', 'videos'),
        images_kept: path.join(homeDir, '.local', 'share', 'pexels', 'images'),
        videos_local: path.join(homeDir, '.local', 'share', 'pexels', 'videos_local'),
        images_local: path.join(homeDir, '.local', 'share', 'pexels', 'images_local'),
        playlists: path.join(homeDir, '.local', 'share', 'pexels', 'playlists')
      },
      search_images: {
        query: '',
        per_page: 80,
        orientation: '',
        min_size: 'large',
        color: ''
      },
      search_videos: {
        query: '',
        min_size: '',
        per_page: 80
      },
      hooks: {
        'get-name': '',
        'play-prev': '',
        'play-next': ''
      }
    };
  }

  async initialize() {
    try {
      // Ensure config directory exists
      await fs.ensureDir(path.dirname(this.configPath));
      
      if (await fs.pathExists(this.configPath)) {
        await this.loadConfig();
      } else {
        await this.createDefaultConfig();
      }
      
      // Ensure log and database directories exist
      const config = this.get();
      await fs.ensureDir(path.dirname(config.paths.logfile));
      await fs.ensureDir(path.dirname(config.paths.database));
      
    } catch (error) {
      throw new Error(`Failed to initialize config: ${error.message}`);
    }
  }

  async loadConfig() {
    try {
      const configContent = await fs.readFile(this.configPath, 'utf8');
      const loadedConfig = YAML.parse(configContent);
      
      // Merge with defaults to ensure all required fields exist
      this.config = this.mergeWithDefaults(loadedConfig);
      
      // Update API key from environment if not set in config
      if (!this.config.api_key && process.env.PEXELS_API) {
        this.config.api_key = process.env.PEXELS_API;
      }
      
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }

  async createDefaultConfig() {
    try {
      this.config = this.getDefaultConfig();
      const yamlContent = YAML.stringify(this.config);
      await fs.writeFile(this.configPath, yamlContent);
      
      console.log(`Created default config file at: ${this.configPath}`);
      console.log('Please edit the config file to set your API key and hooks.');
      
    } catch (error) {
      throw new Error(`Failed to create default config: ${error.message}`);
    }
  }

  mergeWithDefaults(loadedConfig) {
    const defaults = this.getDefaultConfig();
    
    return {
      ...defaults,
      ...loadedConfig,
      paths: { ...defaults.paths, ...loadedConfig.paths },
      search_images: { ...defaults.search_images, ...loadedConfig.search_images },
      search_videos: { ...defaults.search_videos, ...loadedConfig.search_videos },
      hooks: { ...defaults.hooks, ...loadedConfig.hooks }
    };
  }

  get() {
    if (!this.config) {
      throw new Error('Config not initialized');
    }
    return this.config;
  }

  async save() {
    try {
      const yamlContent = YAML.stringify(this.config);
      await fs.writeFile(this.configPath, yamlContent);
    } catch (error) {
      throw new Error(`Failed to save config: ${error.message}`);
    }
  }

  set(key, value) {
    if (!this.config) {
      throw new Error('Config not initialized');
    }
    
    const keys = key.split('.');
    let current = this.config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in current)) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
  }

  getPath(key) {
    const paths = this.get().paths;
    return paths[key];
  }

  expandPath(pathStr) {
    return pathStr.replace(/^\$HOME/, os.homedir());
  }
}