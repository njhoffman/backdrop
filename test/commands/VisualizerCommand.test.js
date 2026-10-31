import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { VisualizerCommand } from '../../src/commands/VisualizerCommand.js';
import { controlPath, statePath } from '../../src/display/Daemon.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('VisualizerCommand', () => {
  let dir, config, lines, signals, answer;
  const state = (visualizer, extra = {}) => fs.writeJson(statePath(dir), {
    pid: process.pid, version: '2.20.0', visualizer,
    monitors: [{ name: 'DP-3', visualizer: { module: 'bars', geometry: '2560x360+0+1080' } }, { name: 'HDMI-1', visualizer: null }],
    ...extra
  });
  const command = () => new VisualizerCommand(config, null, silentLogger, {
    kill: (pid, signal) => { signals.push([pid, signal]); return answer?.(); }, timeout: 200, pollInterval: 5
  });
  const fails = async () => {
    try { await command().run('reload'); } catch (error) { return error.message; }
    return null;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-vis-'));
    config = makeConfig({ 'paths.runtime': dir, 'visualizer.enabled': true });
    lines = [];
    signals = [];
    answer = null;
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
  });
  afterEach(async () => {
    sinon.restore();
    await fs.remove(dir);
  });

  it('signals the daemon and reports each monitor once the reload shows in its state', async () => {
    await state({ enabled: true, error: null, generation: 1 });
    answer = () => setTimeout(() => state({ enabled: true, error: null, generation: 2 }), 20);
    await command().run('reload');
    expect(signals).to.deep.equal([[process.pid, 'SIGHUP']]);
    expect(lines[0]).to.equal('Reloaded the visualizer');
    expect(lines.slice(1)).to.deep.equal(['  DP-3 main: bars at 2560x360+0+1080', '  HDMI-1 no visualizer']);
  });

  it('reports the error the daemon found, or that it is off', async () => {
    await state({ enabled: false, error: null, generation: 1 });
    answer = () => state({ enabled: false, error: 'GLava shaders not found in /x (no bars.glsl); set visualizer.glava.shader_dir', generation: 2 });
    expect(await fails()).to.equal('Visualizer off: GLava shaders not found in /x (no bars.glsl); set visualizer.glava.shader_dir');
    answer = () => state({ enabled: false, error: null, generation: 3 });
    await command().run('reload');
    expect(lines.at(-1)).to.include('Visualizer off (visualizer.enabled is false)');
  });

  it('checks the section first, and does not signal a stopped, old or silent daemon', async () => {
    config.set('visualizer.module', 'spiral');
    expect(await fails()).to.include('visualizer.module must be');
    config.set('visualizer.module', 'bars');

    await command().run('reload');
    expect(lines[0]).to.include('Daemon not running');

    await state(undefined, { version: undefined });
    expect(await fails()).to.include('cannot reload the visualizer; restart it');
    expect(signals).to.deep.equal([]);

    await state({ enabled: true, error: null, generation: 4 });
    expect(await fails()).to.include('The daemon did not reload the visualizer');
    expect(await command().run('restart').catch(error => error.message)).to.equal('Unknown action restart; use reload, preset, check');
  });

  describe('preset', () => {
    // A daemon that answers a control request by applying the preset it names to its state
    const running = (visualizer = {}) => state({ enabled: true, error: null, generation: 1, preset: null, ...visualizer }, {
      control: 0,
      monitors: [{ name: 'DP-3', visualizers: [{ instance: 'main', module: 'bars', geometry: '2560x360+0+1080' }] }]
    });
    const answering = () => async () => {
      const { preset } = await fs.readJson(controlPath(dir));
      setTimeout(() => state({ enabled: true, error: null, generation: 2, preset }, {
        control: signals.length,
        monitors: [{ name: 'DP-3', visualizers: [{ instance: 'base', module: 'bars', geometry: '2560x360+0+1080' }, { instance: 'ring', module: 'radial', geometry: '1024x864+768+288' }] }]
      }), 5);
    };

    it('lists the presets with the active one marked', async () => {
      config.set('visualizer.presets', { calm: { opacity: 0.3 } });
      await running({ preset: 'ring' });
      await command().run('preset');
      expect(lines.slice(0, 5)).to.deep.equal(['  subtle', '* ring', '  wave', '  party', '  calm']);
    });

    it('switches the running daemon to a named, next or configured preset', async () => {
      await running();
      answer = answering();
      await command().run('preset', 'party');
      expect(signals).to.deep.equal([[process.pid, 'SIGUSR1']]);
      expect(lines[0]).to.include('Preset party');
      expect(lines.slice(1)).to.deep.equal(['  DP-3 base: bars at 2560x360+0+1080', '  DP-3 ring: radial at 1024x864+768+288']);

      // party is active now; --next wraps around to the first
      await command().run('preset', undefined, { next: true });
      expect(await fs.readJson(controlPath(dir))).to.deep.equal({ pid: process.pid, preset: 'subtle' });
      await command().run('preset', undefined, { clear: true });
      expect(await fs.readJson(controlPath(dir))).to.deep.equal({ pid: process.pid, preset: null });
      expect(lines.at(-3)).to.include('Preset cleared');
    });

    it('rejects an unknown preset before signalling, and only advises when the daemon is stopped', async () => {
      await running();
      expect(await command().run('preset', 'loud').catch(error => error.message)).to.include('visualizer.preset must be one of the presets');
      expect(signals).to.deep.equal([]);
      await fs.remove(statePath(dir));
      await command().run('preset', 'wave');
      expect(lines.at(-1)).to.include('Daemon not running; set visualizer.preset');
    });
  });

  describe('check', () => {
    const results = [
      { preset: null, instance: 'main', ok: true },
      { preset: 'broken', instance: 'main', ok: false, code: 1, signal: null, output: ['Shader compilation failed'] },
      { preset: 'bad', instance: null, ok: false, error: 'visualizer.presets.bad.module must be bars' }
    ];
    const checking = (found, compositor = true) => new VisualizerCommand(config, null, silentLogger, {
      kill: (pid, signal) => { signals.push([pid, signal]); return answer?.(); }, timeout: 200, pollInterval: 5,
      check: async () => found, compositor: async () => compositor
    });
    let errors;
    beforeEach(() => {
      errors = [];
      sinon.stub(console, 'error').callsFake(line => errors.push(line));
      process.exitCode = undefined;
    });
    afterEach(() => { process.exitCode = undefined; });

    it('lists each instance with its result and output, and fails the command on any failure', async () => {
      expect(await checking(results, false).run('check')).to.equal(false);
      expect(lines).to.include.members(['  ok      (no preset)  main', '  failed  broken  main: exited with code 1',
        '  failed  bad: visualizer.presets.bad.module must be bars', '  Shader compilation failed']);
      expect(errors.join('\n')).to.include('No compositor runs').and.include('2 of 3 failed');
      expect(process.exitCode).to.equal(1);
    });

    it('passes when all run', async () => {
      expect(await checking([results[0]]).run('check')).to.equal(true);
      expect(lines.at(-1)).to.equal('All 1 ran');
      expect(process.exitCode).to.equal(undefined);
    });

    it('reload --check reloads only when every instance runs', async () => {
      await state({ enabled: true, error: null, generation: 1 });
      const error = await checking(results).run('reload', undefined, { check: true }).catch(caught => caught);
      expect(error.message).to.equal('Not reloaded: fix the visualizers that exited first');
      expect(signals).to.deep.equal([]);

      answer = () => setTimeout(() => state({ enabled: true, error: null, generation: 2 }), 20);
      await checking([results[0]]).run('reload', undefined, { check: true });
      expect(signals).to.deep.equal([[process.pid, 'SIGHUP']]);
    });
  });
});
