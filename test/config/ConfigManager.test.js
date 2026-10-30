import { expect } from 'chai';
import sinon from 'sinon';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import { ConfigManager } from '../../src/config/ConfigManager.js';

const ENV_KEYS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'PEXELS_API'];

describe('ConfigManager', () => {
  let configManager;
  let tempDir;
  let configPath;
  let savedEnv;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backdrop-config-test-'));
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
    process.env.XDG_CACHE_HOME = path.join(tempDir, 'cache');
    process.env.XDG_RUNTIME_DIR = path.join(tempDir, 'run');
    delete process.env.PEXELS_API;

    configPath = path.join(tempDir, 'config', 'config.yaml');
    configManager = new ConfigManager(configPath);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.remove(tempDir);
  });

  async function writeConfig(content) {
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeFile(configPath, YAML.stringify(content));
  }

  describe('default location', () => {
    it('uses $XDG_CONFIG_HOME/backdrop/config.yaml', () => {
      process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
      expect(new ConfigManager().configPath).to.equal(path.join(tempDir, 'xdg-config', 'backdrop', 'config.yaml'));
    });

    it('falls back to ~/.config/backdrop/config.yaml', () => {
      delete process.env.XDG_CONFIG_HOME;
      expect(new ConfigManager().configPath).to.equal(path.join(os.homedir(), '.config', 'backdrop', 'config.yaml'));
    });
  });

  describe('initialization', () => {
    it('creates a default config file when none exists', async () => {
      await configManager.initialize();

      expect(await fs.pathExists(configPath)).to.be.true;
      const config = configManager.get();
      expect(config.sources.pexels.per_page).to.equal(80);
      expect(config.library.default_import_rating).to.equal(2);
      expect(config.library.trash_days).to.equal(30);
      expect(config.display.allow_upscale).to.be.false;
      expect(config.display.xwinwrap_args).to.include.members(['-ni', '-ov', '-b']);
      expect(config.display.mpv_args).to.deep.equal([]);
      expect(config.screensaver.idle_minutes).to.equal(10);
      expect(configManager.created).to.be.true;
    });

    it('creates the file silently and leaves the notice to the CLI', async () => {
      const log = sinon.stub(console, 'log');
      try {
        await configManager.initialize();
      } finally {
        log.restore();
      }
      expect(log.called).to.be.false;
    });

    it('does not write paths into a new config file', async () => {
      await configManager.initialize();

      const written = YAML.parse(await fs.readFile(configPath, 'utf8'));
      expect(written).to.not.have.property('paths');
      expect(written).to.have.property('sources');
    });

    it('treats an empty config file as all defaults', async () => {
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, '');
      await configManager.initialize();

      expect(configManager.get().sources.pexels.per_page).to.equal(80);
    });

    it('throws a descriptive error on invalid YAML', async () => {
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, 'sources: [unclosed');

      try {
        await configManager.initialize();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('Failed to load config');
      }
    });
  });

  describe('paths', () => {
    it('derives defaults from XDG directories', async () => {
      await configManager.initialize();

      const { paths } = configManager.get();
      expect(paths.database).to.equal(path.join(tempDir, 'data', 'backdrop', 'backdrop.db'));
      expect(paths.media).to.equal(path.join(tempDir, 'data', 'backdrop', 'media'));
      expect(paths.trash).to.equal(path.join(tempDir, 'data', 'backdrop', 'trash'));
      expect(paths.inbox).to.equal(path.join(tempDir, 'cache', 'backdrop', 'inbox'));
      expect(paths.runtime).to.equal(path.join(tempDir, 'run', 'backdrop'));
    });

    it('falls back to a per-user temp dir for runtime without XDG_RUNTIME_DIR', async () => {
      delete process.env.XDG_RUNTIME_DIR;
      await configManager.initialize();

      expect(configManager.getPath('runtime')).to.equal(path.join(os.tmpdir(), `backdrop-${os.userInfo().uid}`));
    });

    it('lets the config file override individual paths and expands them', async () => {
      await writeConfig({ paths: { media: '~/wallpapers', trash: '$HOME/.trash' } });
      await configManager.initialize();

      const { paths } = configManager.get();
      expect(paths.media).to.equal(path.join(os.homedir(), 'wallpapers'));
      expect(paths.trash).to.equal(path.join(os.homedir(), '.trash'));
      expect(paths.database).to.equal(path.join(tempDir, 'data', 'backdrop', 'backdrop.db'));
    });

    it('expands import directories', async () => {
      await writeConfig({ library: { import_dirs: ['~/Pictures/walls', '${HOME}/Videos'] } });
      await configManager.initialize();

      expect(configManager.get().library.import_dirs).to.deep.equal([
        path.join(os.homedir(), 'Pictures/walls'),
        path.join(os.homedir(), 'Videos')
      ]);
    });
  });

  describe('merging', () => {
    it('deep merges nested sections with defaults', async () => {
      await writeConfig({ sources: { pexels: { api_key: 'abc' } }, display: { image_duration: 60 } });
      await configManager.initialize();

      const config = configManager.get();
      expect(config.sources.pexels.api_key).to.equal('abc');
      expect(config.sources.pexels.per_page).to.equal(80);
      expect(config.display.image_duration).to.equal(60);
      expect(config.display.monitors).to.equal('auto');
    });

    it('reloads one section from the file, leaving the others as they were', async () => {
      await writeConfig({ display: { image_duration: 60 }, visualizer: { enabled: true } });
      await configManager.initialize();
      await writeConfig({ display: { image_duration: 90 }, visualizer: { module: 'radial' } });
      await configManager.reloadSection('visualizer');
      const config = configManager.get();
      expect(config.display.image_duration).to.equal(60);
      expect(config.visualizer).to.include({ enabled: false, module: 'radial', engine: 'glava' });
      expect(configManager.userConfig.visualizer).to.deep.equal({ module: 'radial' });
    });

    it('replaces arrays instead of merging them', async () => {
      await writeConfig({ screensaver: { sources: ['playlist:night'] } });
      await configManager.initialize();

      expect(configManager.get().screensaver.sources).to.deep.equal(['playlist:night']);
    });

    it('keeps sources the defaults do not know about', async () => {
      await writeConfig({ sources: { unsplash: { access_key: 'xyz' } } });
      await configManager.initialize();

      expect(configManager.getSource('unsplash')).to.deep.equal({ access_key: 'xyz' });
      expect(configManager.getSource('pexels').per_page).to.equal(80);
    });
  });

  describe('environment credentials', () => {
    it('uses PEXELS_API when the config has no key', async () => {
      process.env.PEXELS_API = 'env-key';
      await configManager.initialize();

      expect(configManager.getSource('pexels').api_key).to.equal('env-key');
    });

    it('prefers the config file key over PEXELS_API', async () => {
      process.env.PEXELS_API = 'env-key';
      await writeConfig({ sources: { pexels: { api_key: 'file-key' } } });
      await configManager.initialize();

      expect(configManager.getSource('pexels').api_key).to.equal('file-key');
    });
  });

  describe('set and save', () => {
    beforeEach(async () => {
      await configManager.initialize();
    });

    it('sets nested values', () => {
      configManager.set('display.image_duration', 120);
      expect(configManager.get().display.image_duration).to.equal(120);
    });

    it('creates missing intermediate objects', () => {
      configManager.set('sources.unsplash.access_key', 'k');
      expect(configManager.getSource('unsplash').access_key).to.equal('k');
    });

    it('persists set values', async () => {
      configManager.set('library.trash_days', 7);
      await configManager.save();

      const reloaded = new ConfigManager(configPath);
      await reloaded.initialize();
      expect(reloaded.get().library.trash_days).to.equal(7);
    });

    it('does not save environment credentials or derived paths', async () => {
      process.env.PEXELS_API = 'secret-env-key';
      const manager = new ConfigManager(configPath);
      await manager.initialize();
      manager.set('library.trash_days', 7);
      await manager.save();

      const written = await fs.readFile(configPath, 'utf8');
      expect(written).to.not.include('secret-env-key');
      expect(YAML.parse(written)).to.not.have.property('paths');
    });
  });

  describe('expandPath', () => {
    it('expands a leading ~', () => {
      expect(configManager.expandPath('~/x')).to.equal(path.join(os.homedir(), 'x'));
      expect(configManager.expandPath('~')).to.equal(os.homedir());
    });

    it('does not expand ~ in the middle of a path or ~user', () => {
      expect(configManager.expandPath('/a/~/b')).to.equal('/a/~/b');
      expect(configManager.expandPath('~other/x')).to.equal('~other/x');
    });

    it('expands $VAR and ${VAR}, leaving unknown variables as-is', () => {
      process.env.XDG_CONFIG_HOME = '/cfg';
      expect(configManager.expandPath('$XDG_CONFIG_HOME/a')).to.equal('/cfg/a');
      expect(configManager.expandPath('${XDG_CONFIG_HOME}/a')).to.equal('/cfg/a');
      expect(configManager.expandPath('$BACKDROP_UNSET_VAR/a')).to.equal('$BACKDROP_UNSET_VAR/a');
    });

    it('leaves absolute paths unchanged', () => {
      expect(configManager.expandPath('/absolute/path')).to.equal('/absolute/path');
    });
  });

  describe('before initialization', () => {
    it('throws on get', () => {
      expect(() => new ConfigManager(configPath).get()).to.throw('Config not initialized');
    });

    it('throws on set', () => {
      expect(() => new ConfigManager(configPath).set('a', 1)).to.throw('Config not initialized');
    });
  });
});
