import { expect } from 'chai';
import { EventEmitter } from 'events';
import { VisualizerManager } from '../../src/visualizer/VisualizerManager.js';
import { FakeChild, FakeMpvClient, makeConfig, silentLogger } from '../helpers/fakes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('VisualizerManager', () => {
  let config, monitors, screens, spawned, kills, prepared, logs, manager, time, windows, xcalls, above;
  const monitor = (name, x = 0) => ({ name, x, y: 0, width: 2560, height: 1440 });

  function makeManager(overrides = {}) {
    return new VisualizerManager({
      config, logger: { ...silentLogger, error: (message, meta) => logs.push(['error', message, meta]), warn: (message, meta) => logs.push(['warn', message, meta]) },
      monitors, screens,
      exec: async (file, args) => {
        if (file === 'xdotool' && windows.has(args[2])) return `${windows.get(args[2])}\n`;
        throw new Error('exit 1');
      },
      // xwinwrap's window 0x1200001 holds mpv's 0x3600002
      x11: async fn => fn({
        setOpacity: async (id, value) => { xcalls.push(['opacity', id, value]); },
        topLevel: async id => { xcalls.push(['topLevel', id]); return 0x1200001; },
        stackAbove: async (id, sibling) => { xcalls.push(['stackAbove', id, sibling]); },
        isAbove: async () => above.shift() ?? true
      }),
      windowAttempts: 2, windowDelay: 0, settleDelay: 0,
      spawn: (file, args, options) => {
        const child = new FakeChild(2000 + spawned.length);
        child.stderr = new EventEmitter();
        spawned.push({ file, args, options, child });
        return child;
      },
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        const entry = spawned.find(item => item.child.pid === -pid);
        if (entry && entry.child.exitCode === null) setImmediate(() => entry.child.exit(null, signal));
      },
      restartDelay: 0, stopGrace: 20, now: () => time,
      create: (settings, { runtimeDir }) => ({
        settings, runtimeDir,
        prepare: async () => { prepared.push(settings.module); },
        title: target => `backdrop-visualizer-${target.name}`,
        command: (target, geometry) => ({ file: 'glava', args: [target.name, `${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`], env: {} })
      }),
      ...overrides
    });
  }

  beforeEach(() => {
    config = makeConfig({ 'visualizer.enabled': true });
    monitors = new Map([['DP-3', monitor('DP-3')]]);
    screens = new Map([['DP-3', { client: new FakeMpvClient({ 'window-id': 0x3600002 }) }]]);
    windows = new Map([['^backdrop-visualizer-DP-3$', 0x3400002]]);
    xcalls = [];
    above = [];
    spawned = []; kills = []; prepared = []; logs = [];
    time = 0;
    manager = makeManager();
  });

  it('starts nothing while disabled, and keeps the wallpaper running on a bad section', async () => {
    config.set('visualizer.enabled', false);
    await manager.configure();
    await manager.sync();
    expect(spawned).to.have.length(0);
    expect(prepared).to.deep.equal([]);
    expect(manager.summary()).to.deep.equal({ enabled: false, error: null, generation: 1 });

    config.set('visualizer.enabled', true);
    config.set('visualizer.module', 'spiral');
    await manager.configure();
    await manager.sync();
    expect(spawned).to.have.length(0);
    expect(manager.summary().error).to.include('visualizer.module must be');
    expect(logs[0].slice(0, 2)).to.deep.equal(['error', 'Visualizer disabled']);
  });

  it('starts one instance per monitor at its geometry', async () => {
    monitors.set('HDMI-1', monitor('HDMI-1', 2560));
    config.set('visualizer.monitors', ['DP-3']);
    await manager.configure();
    await manager.sync();
    expect(prepared).to.deep.equal(['bars']);
    expect(spawned.map(item => item.args)).to.deep.equal([['DP-3', '2560x360+0+1080']]);
    expect(spawned[0].options).to.include({ detached: true });
    expect(manager.describe('DP-3')).to.deep.equal({ engine: 'glava', module: 'bars', pid: 2000, running: true, geometry: '2560x360+0+1080' });
    expect(manager.describe('HDMI-1')).to.be.null;
  });

  it('gives each instance its opacity and stacks it directly above its wallpaper, checking again after it settles', async () => {
    config.set('visualizer.opacity', 0.6);
    above = [false];
    await manager.configure();
    await manager.sync();
    expect(await manager.entries.get('DP-3').placed).to.be.true;
    expect(xcalls).to.deep.equal([
      ['opacity', 0x3400002, 0.6], ['topLevel', 0x3600002], ['stackAbove', 0x3400002, 0x1200001],
      // GLava lowered itself after the first restack, so it is restacked once more
      ['stackAbove', 0x3400002, 0x1200001]
    ]);
    xcalls = [];
    expect(await manager.restack('DP-3')).to.be.true;
    expect(xcalls.filter(call => call[0] === 'stackAbove')).to.have.length(1);
    expect(await manager.restack('HDMI-1')).to.be.false;
  });

  it('leaves an instance at the bottom without a wallpaper, and warns when its window never shows', async () => {
    screens.clear();
    await manager.configure();
    await manager.sync();
    expect(await manager.entries.get('DP-3').placed).to.be.true;
    expect(xcalls).to.deep.equal([['opacity', 0x3400002, 0.8]]);

    windows.clear();
    await manager.reload();
    expect(await manager.entries.get('DP-3').placed).to.be.false;
    expect(logs.map(log => log[1])).to.include('Visualizer window not found, cannot place it');
  });

  it('follows monitor changes: moves on a new geometry, stops on removal', async () => {
    await manager.configure();
    await manager.sync();
    monitors.set('DP-3', { ...monitor('DP-3'), width: 1920, height: 1080 });
    await manager.sync();
    expect(kills).to.deep.equal([[-2000, 'SIGTERM']]);
    expect(spawned[1].args[1]).to.equal('1920x270+0+810');
    monitors.clear();
    await manager.sync();
    expect(kills.at(-1)).to.deep.equal([-2001, 'SIGTERM']);
    expect(manager.entries.size).to.equal(0);
    // Exits the manager caused are not restarted
    await tick();
    expect(spawned).to.have.length(2);
  });

  it('restarts an instance that exits, and gives up after five exits in a minute until reload', async () => {
    await manager.configure();
    await manager.sync();
    for (let exit = 0; exit < 5; exit++) {
      const { child } = spawned.at(-1);
      child.stderr.emit('data', 'shader error\n');
      child.exit(1);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(spawned).to.have.length(6);
    expect(logs.find(log => log[1] === 'Visualizer exited, restarting')[2]).to.include({ code: 1, output: 'shader error' });
    spawned.at(-1).child.exit(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(spawned).to.have.length(6);
    expect(logs.at(-1)[1]).to.equal('Visualizer keeps exiting, giving up on monitor until reload');
    expect(manager.describe('DP-3').running).to.be.false;

    await manager.reload();
    expect(spawned).to.have.length(7);
    expect(manager.describe('DP-3').running).to.be.true;
    expect(manager.summary().generation).to.equal(2);
  });

  it('switches on and off over visualizer.enabled, and places every instance over new wallpapers', async () => {
    config.set('visualizer.enabled', false);
    await manager.configure();
    await manager.sync();
    expect(manager.active).to.be.false;
    await manager.setEnabled(true);
    expect(prepared).to.deep.equal(['bars']);
    expect(spawned).to.have.length(1);
    expect(manager.summary().enabled).to.be.true;
    xcalls = [];
    await manager.restackAll();
    expect(xcalls.some(call => call[0] === 'stackAbove')).to.be.true;
    expect(spawned).to.have.length(1);
    await manager.setEnabled(false);
    expect(manager.entries.size).to.equal(0);
    expect(manager.summary().enabled).to.be.false;
    // The switch outlasts a reload of the section
    config.set('visualizer.enabled', true);
    await manager.reload();
    expect(spawned).to.have.length(1);
  });

  it('stops every instance on shutdown without restarting them', async () => {
    await manager.configure();
    await manager.sync();
    await manager.stop();
    await tick();
    expect(kills).to.deep.equal([[-2000, 'SIGTERM']]);
    expect(spawned).to.have.length(1);
    await manager.sync();
    expect(spawned).to.have.length(1);
  });
});
