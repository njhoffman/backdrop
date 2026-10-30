import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { VisualizerCommand } from '../../src/commands/VisualizerCommand.js';
import { statePath } from '../../src/display/Daemon.js';
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
    expect(lines[0]).to.include('Reloaded the visualizer (glava bars)');
    expect(lines.slice(1)).to.deep.equal(['  DP-3 bars at 2560x360+0+1080', '  HDMI-1 no visualizer']);
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
    expect(await command().run('restart').catch(error => error.message)).to.equal('Unknown action restart; use reload');
  });
});
