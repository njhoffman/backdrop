import { expect } from 'chai';
import sinon from 'sinon';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import YAML from 'yaml';
import { ConfigManager, spliceYaml } from '../../src/config/ConfigManager.js';

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

    it('keeps the defaults of a section left empty, for every section', async () => {
      const defaults = new ConfigManager(configPath).getDefaultConfig();
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, `${Object.keys(defaults).filter(key => key !== 'sources').map(key => `${key}:`).join('\n')}\nsources:\n  pexels:\n`);
      await configManager.initialize();
      expect(configManager.get()).to.deep.equal(defaults);
      expect(configManager.warnings).to.deep.equal([]);
    });

    it('reads a list left empty as an empty list, and a nested mapping left empty as its defaults', async () => {
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, [
        'library:', '  import_dirs:', '  #  - ~/Pictures',
        'display:', '  mpv_args:',
        'visualizer:', '  placement:', '  preset:'
      ].join('\n'));
      await configManager.initialize();
      const config = configManager.get();
      expect(config.library.import_dirs).to.deep.equal([]);
      expect(config.library.trash_days).to.equal(30);
      expect(config.display.mpv_args).to.deep.equal([]);
      expect(config.visualizer.placement).to.deep.equal(configManager.getUserDefaults().visualizer.placement);
      // A null over a value stays null: an unset preset is meaningful
      expect(config.visualizer.preset).to.equal(null);
    });

    it('keeps sources the defaults do not know about', async () => {
      await writeConfig({ sources: { unsplash: { access_key: 'xyz' } } });
      await configManager.initialize();

      expect(configManager.getSource('unsplash')).to.deep.equal({ access_key: 'xyz' });
      expect(configManager.getSource('pexels').per_page).to.equal(80);
    });
  });

  describe('editing the file in place', () => {
    const file = [
      '# backdrop config',
      'display:',
      '  image_duration: 300           # aligned comment',
      'visualizer:',
      '  enabled: true',
      '  bars: { colors: [\'#000000\', \'#33aacc\'], amplify: 300 }',
      '  glava:',
      '    args: []                    # last entry',
      '',
      '# ----- reference -----',
      '# visualizer:',
      '#   presets: {}',
      ''
    ].join('\n');

    it('inserts a new entry after the mapping\'s last one, every other byte unchanged', () => {
      const edited = spliceYaml(file, ['visualizer', 'presets', 'calm'], { opacity: 0.4, bars: { colors: ['#112233', '#445566'] } });
      const added = ['  presets:', '    calm:', '      opacity: 0.4', '      bars:', '        colors:', '          - "#112233"', '          - "#445566"'].join('\n');
      expect(edited).to.equal(file.replace('# last entry\n', `# last entry\n${added}\n`));
    });

    it('replaces an existing entry in place, keeping the lines after it', () => {
      const once = spliceYaml(file, ['visualizer', 'presets', 'calm'], { opacity: 0.4 });
      const twice = spliceYaml(once, ['visualizer', 'presets', 'calm'], { opacity: 0.9 });
      expect(twice).to.equal(once.replace('opacity: 0.4', 'opacity: 0.9'));
      const other = spliceYaml(twice, ['visualizer', 'presets', 'wave'], { module: 'wave' });
      expect(other).to.include('    calm:\n      opacity: 0.9\n    wave:\n      module: wave\n\n# ----- reference');
      expect(spliceYaml(file, ['display', 'image_duration'], 60)).to.equal(file.replace('  image_duration: 300           # aligned comment', '  image_duration: 60'));
    });

    it('adds a missing section at the end, and fills an empty file', () => {
      expect(spliceYaml('library:\n  trash_days: 3\n', ['visualizer', 'presets', 'a'], { opacity: 1 }))
        .to.equal('library:\n  trash_days: 3\nvisualizer:\n  presets:\n    a:\n      opacity: 1\n');
      expect(spliceYaml('', ['visualizer', 'presets', 'a'], { opacity: 1 })).to.equal('visualizer:\n  presets:\n    a:\n      opacity: 1\n');
    });

    it('refuses a layout it cannot edit by lines, and a file that does not parse', () => {
      expect(() => spliceYaml('visualizer: {enabled: true}\n', ['visualizer', 'presets', 'a'], {})).to.throw('visualizer is not a block mapping');
      expect(() => spliceYaml('visualizer: [1]\n', ['visualizer', 'presets', 'a'], {})).to.throw('visualizer is not a block mapping');
      expect(() => spliceYaml('a: [\n', ['a'], 1)).to.throw('Failed to edit config');
    });

    it('writes through a temporary file and reports what the file sets', async () => {
      await fs.ensureDir(path.dirname(configPath));
      await fs.writeFile(configPath, file);
      expect(await configManager.fileHas(['visualizer', 'presets', 'calm'])).to.equal(false);
      await configManager.setInFile(['visualizer', 'presets', 'calm'], { opacity: 0.4 });
      expect(await configManager.fileHas(['visualizer', 'presets', 'calm'])).to.equal(true);
      expect(await fs.readdir(path.dirname(configPath))).to.deep.equal(['config.yaml']);
      await configManager.initialize();
      expect(configManager.get().visualizer.presets).to.deep.equal({ calm: { opacity: 0.4 } });
    });
  });

  describe('invalid values', () => {
    it('fails the load listing every invalid value, and converts durations', async () => {
      await writeConfig({ display: { image_duration: '5m', notify: 'loud' }, library: { trash_days: -1 } });
      const error = await configManager.initialize().catch(caught => caught);
      expect(error.message).to.include(`invalid values in ${configPath}:`)
        .and.include('display.notify must be commands, all or off, not "loud"')
        .and.include('library.trash_days must be a whole number from 0, not -1');
      await writeConfig({ display: { image_duration: '5m' } });
      await configManager.initialize();
      expect(configManager.get().display.image_duration).to.equal(300);
      expect(configManager.errors).to.deep.equal([]);
    });

    it('keeps going when tolerant, and leaves a bad visualizer section as a warning', async () => {
      await writeConfig({ display: { notify: 'loud' }, visualizer: { module: 'spiral' } });
      await configManager.initialize({ tolerant: true });
      expect(configManager.errors).to.deep.equal(['display.notify must be commands, all or off, not "loud"']);
      expect(configManager.visualizerError).to.include('visualizer.module must be');
      await writeConfig({ visualizer: { module: 'spiral' } });
      await configManager.initialize();
      expect(configManager.visualizerError).to.include('visualizer.module must be');
    });
  });

  describe('unknown keys', () => {
    it('has no warnings for a config that only uses known keys', async () => {
      await writeConfig({ ...configManager.getUserDefaults(), paths: { media: '~/walls' } });
      await configManager.initialize();
      expect(configManager.warnings).to.deep.equal([]);
    });

    it('warns on an unknown section, naming the closest one, and still loads', async () => {
      await writeConfig({ visualization: { enabled: true }, display: { image_duration: 60 } });
      await configManager.initialize();
      expect(configManager.warnings).to.deep.equal(['Unknown config key "visualization"; closest: "visualizer"']);
      expect(configManager.get().display.image_duration).to.equal(60);
    });

    it('warns on unknown keys inside sections and nested mappings, with their full key', async () => {
      await writeConfig({
        display: { image_durtion: 60 },
        sources: { pexels: { apikey: 'abc' }, unsplash: { access_key: 'xyz' } },
        paths: { medai: '/tmp/media' },
        menu: { zzzzzzzz: 1 }
      });
      await configManager.initialize();
      expect(configManager.warnings).to.deep.equal([
        'Unknown config key "display.image_durtion"; closest: "display.image_duration"',
        'Unknown config key "sources.pexels.apikey"; closest: "sources.pexels.api_key"',
        'Unknown config key "sources.unsplash"',
        'Unknown config key "paths.medai"; closest: "paths.media"',
        'Unknown config key "menu.zzzzzzzz"'
      ]);
    });

    it('leaves the visualizer section, lists and values to their own checks', async () => {
      await writeConfig({
        visualizer: { colour: 'red', glava: { shaders: 'x' } },
        display: { monitors: ['DP-1'], mpv_args: [{ odd: true }] },
        screensaver: { streams: [{ url: 'x' }] },
        menu: 'minimal'
      });
      // Loaded tolerantly: the values themselves are the schema's to report
      await configManager.initialize({ tolerant: true });
      expect(configManager.warnings).to.deep.equal([]);
      expect(configManager.errors).to.deep.equal([
        'display.mpv_args must be a list of strings, not [{"odd":true}]',
        'menu must be a mapping of settings, not "minimal"'
      ]);
      expect(configManager.visualizerError).to.include('visualizer.colour must be one of the visualizer settings');
    });

    it('updates the warnings from the whole file when one section is reloaded', async () => {
      await writeConfig({ display: { image_duration: 60 } });
      await configManager.initialize();
      await writeConfig({ displya: { image_duration: 60 }, visualizer: { module: 'radial' } });
      await configManager.reloadSection('visualizer');
      expect(configManager.warnings).to.deep.equal(['Unknown config key "displya"; closest: "display"']);
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
