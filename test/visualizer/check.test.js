import path from 'path';
import { expect } from 'chai';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import { checkVisualizer, compositorRuns } from '../../src/visualizer/check.js';
import { FakeChild } from '../helpers/fakes.js';

describe('visualizer check', () => {
  let spawned, prepared, kills, written;
  // Children that exit at once with code 1 when their args include "broken", and print a line first
  const spawn = (file, args, options) => {
    const child = new FakeChild(3000 + spawned.length);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: line => { written.push([child.pid, line]); }, on() {} };
    spawned.push({ file, args, options, child });
    if (args.some(arg => String(arg).includes('broken'))) {
      setImmediate(() => {
        child.stderr.emit('data', 'Shader compilation failed\n"1.frag":84(31): error: syntax error\n  \n');
        child.exit(1);
      });
    }
    return child;
  };
  const create = (settings, instance, { runtimeDir }) => ({
    prepare: async () => { prepared.push([instance.name, runtimeDir]); },
    command: (monitor, geometry) => ({ file: 'glava', args: [instance.name, instance.defines.BAR_WIDTH, `${geometry.width}x${geometry.height}`, ...Object.keys(instance.pipe ?? {})], env: {} })
  });
  const kill = (pid, signal) => {
    kills.push([pid, signal]);
    spawned.find(item => item.child.pid === -pid)?.child.exit(null, signal);
  };

  beforeEach(() => { spawned = []; prepared = []; kills = []; written = []; });

  it('stops what it started and removes its directory when killed', async () => {
    const signals = new EventEmitter();
    const killed = [];
    const died = [];
    const spawnOne = () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdin: { write() {}, on() {} }, stdout: new EventEmitter(), stderr: new EventEmitter() });
      return child;
    };
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-check-'));
    const running = checkVisualizer({ enabled: true }, {
      spawn: spawnOne, tmpRoot, runMs: 150, stopGrace: 1, signals,
      create: () => ({ prepare: async () => {}, command: () => ({ file: 'x', args: [] }) }),
      kill: (pid, signal) => killed.push([pid, signal]),
      die: signal => died.push(signal)
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    signals.emit('SIGTERM');
    expect(killed[0]).to.deep.equal([-4242, 'SIGTERM']);
    expect(died).to.deep.equal(['SIGTERM']);
    expect(await fs.readdir(tmpRoot)).to.deep.equal([]);
    expect(signals.listenerCount('SIGTERM')).to.equal(0);
    await running;
    await fs.remove(tmpRoot);
  });

  it('runs every instance of the section and each preset at 1x1, then stops them', async () => {
    const results = await checkVisualizer({ enabled: true }, { spawn, create, kill, hasSleeve: async () => false, runMs: 20, stopGrace: 20 });
    expect(results.map(result => [result.preset, result.instance, result.ok])).to.deep.equal([
      [null, 'main', true], ['subtle', 'main', true], ['ring', 'ring', true], ['wave', 'wave', true], ['party', 'base', true], ['party', 'ring', true]
    ]);
    expect(spawned.every(item => item.args[2] === '1x1' && item.options.detached)).to.equal(true);
    // Each target prepares in its own directory, so instances of the same name do not share one
    expect(new Set(prepared.map(([, dir]) => dir)).size).to.equal(5);
    expect(kills.filter(([, signal]) => signal === 'SIGTERM')).to.have.length(6);
  });

  it('reports instances that exit with their output, and presets that do not check out', async () => {
    const section = {
      presets: { broken: { bars: { width: 7 }, defines: { BAR_WIDTH: 'broken(' } }, bad: { module: 'spiral' } }
    };
    const results = await checkVisualizer(section, { spawn, create, kill, hasSleeve: async () => false, runMs: 20, stopGrace: 20 });
    const broken = results.find(result => result.preset === 'broken');
    expect(broken).to.deep.include({ instance: 'main', ok: false, code: 1, signal: null });
    expect(broken.output).to.deep.equal(['Shader compilation failed', '"1.frag":84(31): error: syntax error']);
    expect(results.find(result => result.preset === 'bad')).to.deep.include({ instance: null, ok: false });
    expect(results.find(result => result.preset === 'bad').error).to.include('visualizer.presets.bad.module must be');
    expect(results.filter(result => result.ok)).to.have.length(6);
  });

  it('sends piped colors, so GLava draws, and cleans up its directory', async () => {
    const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('bd-vcheck-')).length;
    const results = await checkVisualizer({ palette: { source: 'wallpaper' } }, { spawn, create, kill, hasSleeve: async () => false, runMs: 250, stopGrace: 20 });
    expect(results.every(result => result.ok)).to.equal(true);
    expect(written.filter(([pid]) => pid === 3000).map(([, line]) => line)).to.deep.equal(['fg = #33aaccff\n']);
    expect((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('bd-vcheck-')).length).to.equal(before);
  });

  it('reports a missing engine and an X display it cannot reach', async () => {
    const missing = (file, args, options) => {
      const child = spawn(file, args, options);
      setImmediate(() => { child.emit('error', Object.assign(new Error('spawn glava ENOENT'), { code: 'ENOENT' })); child.exit(-2); });
      return child;
    };
    const [first] = await checkVisualizer({}, { spawn: missing, create, kill, runMs: 20, stopGrace: 20 });
    expect(first).to.deep.include({ ok: false, error: 'glava is not installed' });
    expect(await compositorRuns(async () => { throw new Error('no display'); })).to.equal(null);
    expect(await compositorRuns(async fn => fn({ hasCompositor: async () => true }))).to.equal(true);
  });

  it('checks a built-in sleeve preset only with sleeve installed, and always one the section asks for', async () => {
    const options = { spawn, create, kill, runMs: 20, stopGrace: 20 };
    const presets = async (section, hasSleeve) => (await checkVisualizer(section, { ...options, hasSleeve })).map(result => result.preset);
    expect(await presets({ enabled: true }, async () => false)).to.not.include('lyrics');
    expect(await presets({ enabled: true }, async () => true)).to.include('lyrics');
    const own = { presets: { lyrics: { instances: [{ name: 'mine', engine: 'sleeve' }] } } };
    expect(await presets(own, async () => false)).to.include('lyrics');
  });
});
