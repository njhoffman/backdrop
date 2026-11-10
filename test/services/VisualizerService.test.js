import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { VisualizerService } from '../../src/services/VisualizerService.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('VisualizerService', () => {
  let dir, state, control, send, sent;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-vis-service-'));
    state = { pid: 1, monitors: [{ name: 'DP-1', visualizers: [{ instance: 'main', colors: { fg: '#112233ff', fg2: '#445566ff' } }] }],
      visualizer: { enabled: true, preset: null, instances: ['main'], live: {} } };
    control = { state: sinon.stub().callsFake(async () => state) };
    sent = [];
    // Answers as the daemon does: a visualizer_set shows up in the state's live changes
    send = sinon.stub().callsFake(async (runtime, current, change) => {
      sent.push(change);
      if (change.visualizer_set) {
        const { instance, changes } = change.visualizer_set;
        state.visualizer.live = { ...state.visualizer.live, [instance]: { ...state.visualizer.live[instance], ...changes } };
      }
      return state;
    });
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  const make = (config = makeConfig({ 'paths.runtime': dir }), options = {}) => new VisualizerService({ config, logger: silentLogger, control, send, ...options });

  it('describes each instance\'s look, the presets and the choices', async () => {
    const view = await make().describe();
    expect(view).to.include({ running: true, enabled: true, preset: null, changed: false, error: null });
    expect(view.instances).to.have.length(1);
    expect(view.instances[0]).to.include({ name: 'main', changed: false });
    expect(view.instances[0].look).to.include({ module: 'bars', opacity: 0.8 });
    expect(view.instances[0].sent).to.deep.equal({ fg: '#112233ff', fg2: '#445566ff' });
    expect(view.presets.find(preset => preset.name === 'ring')).to.deep.equal({ name: 'ring', source: 'built in' });
    expect(view.choices.modules).to.include('radial');
    expect(view.choices.swatches.ocean).to.deep.equal(['#003a5c', '#33aacc']);
  });

  it('describes the config\'s visualizer while the daemon is stopped, and refuses changes then', async () => {
    state = null;
    const view = await make(makeConfig({ 'visualizer.preset': 'ring' })).describe();
    expect(view).to.include({ running: false, enabled: false, preset: 'ring', wallpaper: null });
    let caught;
    try { await make().change('main', { opacity: 0.5 }); } catch (error) { caught = error; }
    expect(caught.message).to.include('The daemon is not running');
  });

  it('checks a change against the section before sending it, and reports one the daemon refused', async () => {
    const service = make();
    await service.change('main', { opacity: 0.5 });
    expect(sent).to.deep.equal([{ visualizer_set: { instance: 'main', changes: { opacity: 0.5 } } }]);
    let caught;
    try { await service.change('main', { opacity: 5 }); } catch (error) { caught = error; }
    expect(caught.message).to.include('opacity');
    expect(sent).to.have.length(1);

    send.callsFake(async () => ({ ...state, visualizer: { ...state.visualizer, live: {} } }));
    try { await service.change('main', { module: 'radial' }); } catch (error) { caught = error; }
    expect(caught.message).to.include('The daemon refused the change');
  });

  it('shows each instance\'s settings and changes as YAML, and applies YAML changes checked like the controls', async () => {
    const service = make(makeConfig({ 'paths.runtime': dir, 'visualizer.placement': { anchor: 'top' } }));
    state.visualizer.live = { main: { opacity: 0.5 } };
    const view = await service.describe();
    // Everything that applies, defaults included; the changes alone apart
    expect(view.instances[0].yaml.live).to.equal('opacity: 0.5\n');
    expect(view.instances[0].yaml.settings).to.include('opacity: 0.5\n').and.include('placement:\n  anchor: top\n');
    await service.changeYaml('main', 'placement: { size: 0.3 }');
    expect(sent.at(-1)).to.deep.equal({ visualizer_set: { instance: 'main', changes: { placement: { size: 0.3 } } } });
    let caught;
    try { await service.changeYaml('main', 'opacity: [1'); } catch (error) { caught = error; }
    expect(caught.message).to.include('not YAML');
    try { await service.changeYaml('main', '- a list'); } catch (error) { caught = error; }
    expect(caught.message).to.include('Give the changes as a mapping');
    try { await service.changeYaml('main', 'opacity: 3'); } catch (error) { caught = error; }
    expect(caught.message).to.include('opacity');
  });

  it('switches presets, checking the name, and resets or turns the visualizer off', async () => {
    const service = make();
    await service.setPreset('ring');
    let caught;
    try { await service.setPreset('nope'); } catch (error) { caught = error; }
    expect(caught.message).to.include('visualizer.preset must be one of the presets');
    await service.reset();
    await service.setEnabled(false);
    expect(sent).to.deep.equal([{ preset: 'ring' }, { visualizer_reset: true }, { visualizer: false }]);
  });

  it('keeps the screensaver\'s preset for the screensaver: left out of the list and refused while it is off', async () => {
    const service = make();
    expect((await service.describe()).presets.map(preset => preset.name)).to.not.include('screensaver');
    const caught = await service.setPreset('screensaver').catch(error => error);
    expect(caught.message).to.include('shows only in it');
    expect(sent).to.deep.equal([]);

    state.screensaver = { active: true };
    expect((await service.describe()).presets.map(preset => preset.name)).to.include('screensaver');
    await service.setPreset('screensaver');
    expect(sent).to.deep.equal([{ preset: 'screensaver' }]);
  });

  describe('saving presets', () => {
    let file, config;

    beforeEach(async () => {
      file = path.join(dir, 'config.yaml');
      await fs.writeFile(file, '# my settings\nvisualizer:\n  enabled: true  # keep this comment\n');
      config = new ConfigManager(file);
      await config.loadConfig();
      config.config.paths.runtime = dir;
      state.visualizer.live = { main: { opacity: 0.4 } };
    });

    it('writes the look with its changes into the file, keeping comments, and switches to it', async () => {
      const saved = await make(config, { reload: true }).savePreset('calm');
      expect(saved).to.deep.equal({ name: 'calm', look: { opacity: 0.4 } });
      const text = await fs.readFile(file, 'utf8');
      expect(text).to.include('# keep this comment');
      expect(text).to.match(/presets:\n\s+calm:\n\s+opacity: 0.4/);
      expect(config.get().visualizer.presets.calm).to.deep.equal({ opacity: 0.4 });
      expect(sent.at(-1)).to.deep.equal({ reload_config: true, visualizer_reset: true, preset: 'calm' });
    });

    it('refuses bad names, and replaces an existing preset only when asked', async () => {
      const service = make(config, { reload: true });
      let caught;
      try { await service.savePreset('no spaces'); } catch (error) { caught = error; }
      expect(caught.message).to.include('letters, digits');
      try { await service.savePreset('ring'); } catch (error) { caught = error; }
      expect(caught).to.include({ status: 409, message: 'A preset named ring exists' });
      await service.savePreset('ring', { replace: true });
      expect(await fs.readFile(file, 'utf8')).to.include('ring:');
    });

    it('deletes a saved preset, refusing built-in ones, unknown ones and the one in use', async () => {
      const service = make(config, { reload: true });
      await fs.appendFile(file, '  presets:\n    dusk:\n      opacity: 0.3\n    ring:\n      opacity: 0.5\n    calm:\n      opacity: 0.4\n');
      expect(await service.deletePreset('dusk')).to.deep.equal({ name: 'dusk', restored: false });
      expect(await fs.readFile(file, 'utf8')).to.not.include('dusk');
      expect(sent.at(-1)).to.deep.equal({ reload_config: true });
      // A config preset over a built-in one: the built-in comes back
      expect(await service.deletePreset('ring')).to.deep.equal({ name: 'ring', restored: true });
      let caught;
      try { await service.deletePreset('wave'); } catch (error) { caught = error; }
      expect(caught).to.include({ status: 409, message: 'wave is built in; only presets saved in the config can be deleted' });
      try { await service.deletePreset('nothing'); } catch (error) { caught = error; }
      expect(caught).to.include({ status: 404 });
      state.visualizer.preset = 'calm';
      try { await service.deletePreset('calm'); } catch (error) { caught = error; }
      expect(caught).to.include({ status: 409, message: 'calm is in use; switch to another preset first' });
      expect(await fs.readFile(file, 'utf8')).to.include('calm:');
    });

    it('reads presets saved by hand since it started when reload is on', async () => {
      const service = make(config, { reload: true });
      await fs.appendFile(file, '  presets:\n    dusk:\n      opacity: 0.3\n');
      const view = await service.describe();
      expect(view.presets.find(preset => preset.name === 'dusk')).to.deep.equal({ name: 'dusk', source: 'config' });
    });
  });
});
