import { expect } from 'chai';
import sinon from 'sinon';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../../src/config/ConfigManager.js';

describe('ConfigManager', () => {
  let configManager;
  let sandbox;
  let tempDir;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pexels-test-'));
    
    // Mock the config path to use temp directory
    configManager = new ConfigManager();
    configManager.configPath = path.join(tempDir, 'pexels.yaml');
  });

  afterEach(async () => {
    sandbox.restore();
    await fs.remove(tempDir);
  });

  describe('initialization', () => {
    it('should create default config when none exists', async () => {
      await configManager.initialize();
      
      const config = configManager.get();
      expect(config).to.be.an('object');
      expect(config.paths).to.be.an('object');
      expect(config.search_images).to.be.an('object');
      expect(config.search_videos).to.be.an('object');
      expect(config.hooks).to.be.an('object');
    });

    it('should load existing config file', async () => {
      const testConfig = {
        api_key: 'test-key',
        paths: {
          logfile: '/custom/log/path'
        }
      };
      
      await fs.writeFile(configManager.configPath, JSON.stringify(testConfig));
      await configManager.initialize();
      
      const config = configManager.get();
      expect(config.api_key).to.equal('test-key');
      expect(config.paths.logfile).to.equal('/custom/log/path');
    });

    it('should merge loaded config with defaults', async () => {
      const partialConfig = {
        api_key: 'test-key'
      };
      
      await fs.writeFile(configManager.configPath, JSON.stringify(partialConfig));
      await configManager.initialize();
      
      const config = configManager.get();
      expect(config.api_key).to.equal('test-key');
      expect(config.paths).to.be.an('object');
      expect(config.search_images.per_page).to.equal(80);
    });
  });

  describe('configuration management', () => {
    beforeEach(async () => {
      await configManager.initialize();
    });

    it('should get configuration values', () => {
      const config = configManager.get();
      expect(config).to.be.an('object');
    });

    it('should set nested configuration values', () => {
      configManager.set('search_images.per_page', 50);
      const config = configManager.get();
      expect(config.search_images.per_page).to.equal(50);
    });

    it('should get specific path values', () => {
      const logPath = configManager.getPath('logfile');
      expect(logPath).to.be.a('string');
      expect(logPath).to.include('.local/share/pexels/wallpaper.log');
    });

    it('should save configuration to file', async () => {
      configManager.set('api_key', 'new-test-key');
      await configManager.save();
      
      // Create new instance to verify save
      const newConfigManager = new ConfigManager();
      newConfigManager.configPath = configManager.configPath;
      await newConfigManager.initialize();
      
      const config = newConfigManager.get();
      expect(config.api_key).to.equal('new-test-key');
    });
  });

  describe('environment variable handling', () => {
    it('should use PEXELS_API environment variable when api_key is not set', async () => {
      process.env.PEXELS_API = 'env-api-key';
      
      await configManager.initialize();
      
      const config = configManager.get();
      expect(config.api_key).to.equal('env-api-key');
      
      delete process.env.PEXELS_API;
    });

    it('should prefer config file over environment variable', async () => {
      process.env.PEXELS_API = 'env-api-key';
      
      const testConfig = {
        api_key: 'config-api-key'
      };
      
      await fs.writeFile(configManager.configPath, JSON.stringify(testConfig));
      await configManager.initialize();
      
      const config = configManager.get();
      expect(config.api_key).to.equal('config-api-key');
      
      delete process.env.PEXELS_API;
    });
  });

  describe('path expansion', () => {
    it('should expand $HOME in paths', () => {
      const expandedPath = configManager.expandPath('$HOME/.local/share/pexels');
      expect(expandedPath).to.equal(path.join(os.homedir(), '.local/share/pexels'));
    });

    it('should leave paths without $HOME unchanged', () => {
      const originalPath = '/absolute/path/to/file';
      const expandedPath = configManager.expandPath(originalPath);
      expect(expandedPath).to.equal(originalPath);
    });
  });

  describe('error handling', () => {
    it('should throw error when getting config before initialization', () => {
      const uninitializedManager = new ConfigManager();
      expect(() => uninitializedManager.get()).to.throw('Config not initialized');
    });

    it('should throw error when setting config before initialization', () => {
      const uninitializedManager = new ConfigManager();
      expect(() => uninitializedManager.set('key', 'value')).to.throw('Config not initialized');
    });
  });
});