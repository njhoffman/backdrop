import { expect } from 'chai';
import { EventEmitter } from 'events';
import { createVisualizer } from '../../src/visualizer/index.js';
import { VisualizerManager } from '../../src/visualizer/VisualizerManager.js';
import { FakeChild, FakeMpvClient, makeConfig, silentLogger } from '../helpers/fakes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('VisualizerManager', () => {
  let config, monitors, screens, spawned, kills, prepared, logs, manager, time, windows, xcalls, above, watchers, compositor;
  let overlayWindows, connections, overlayChanges;
  const monitor = (name, x = 0) => ({ name, x, y: 0, width: 2560, height: 1440 });
  const entry = (monitorName = 'DP-3', instance = 'main') => manager.entries.get(`${monitorName}\t${instance}`);

  // Records what the manager asks of the audio watcher, and lets a test report sound or silence
  class FakeWatcher {
    constructor(options) {
      Object.assign(this, options);
      this.stopped = false;
      watchers.push(this);
    }

    async start() { return this.initial ?? true; }

    stop() { this.stopped = true; }
  }

  function makeManager(overrides = {}) {
    return new VisualizerManager({
      config, logger: { ...silentLogger, info: (message, meta) => logs.push(['info', message, meta]), error: (message, meta) => logs.push(['error', message, meta]), warn: (message, meta) => logs.push(['warn', message, meta]) },
      monitors, screens,
      exec: async (file, args) => {
        if (file === 'xdotool' && windows.has(args[2])) return `${windows.get(args[2])}\n`;
        throw new Error('exit 1');
      },
      // xwinwrap's window 0x1200001 holds mpv's 0x3600002
      x11: async fn => {
        connections++;
        return fn({
          overlays: async () => {
            if (overlayWindows instanceof Error) throw overlayWindows;
            return overlayWindows;
          },
          setOpacity: async (id, value) => { xcalls.push(['opacity', id, value]); },
          topLevel: async id => { xcalls.push(['topLevel', id]); return 0x1200001; },
          stackAbove: async (id, sibling) => { xcalls.push(['stackAbove', id, sibling]); },
          lower: async id => { xcalls.push(['lower', id]); },
          isAbove: async () => above.shift() ?? true,
          hasCompositor: async () => compositor
        });
      },
      onOverlays: name => overlayChanges.push(name),
      audioWatcher: options => new FakeWatcher(options),
      windowAttempts: 2, windowDelay: 0, settleDelay: 0,
      spawn: (file, args, options) => {
        const child = new FakeChild(2000 + spawned.length);
        child.stderr = new EventEmitter();
        spawned.push({ file, args, options, child });
        return child;
      },
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        const item = spawned.find(spawn => spawn.child.pid === -pid);
        if (item && item.child.exitCode === null) setImmediate(() => item.child.exit(null, signal));
      },
      restartDelay: 0, stopGrace: 20, now: () => time,
      create: (settings, instance, { runtimeDir }) => ({
        settings, instance, runtimeDir,
        prepare: async () => { prepared.push(instance.module); },
        title: target => `backdrop-visualizer-${target.name}-${instance.name}`,
        command: (target, geometry) => ({ file: 'glava', args: [target.name, instance.name, `${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`], env: {} })
      }),
      ...overrides
    });
  }

  beforeEach(() => {
    config = makeConfig({ 'visualizer.enabled': true });
    monitors = new Map([['DP-3', monitor('DP-3')]]);
    screens = new Map([['DP-3', { client: new FakeMpvClient({ 'window-id': 0x3600002 }) }]]);
    windows = new Map([['^backdrop-visualizer-DP-3-main$', 0x3400002]]);
    xcalls = [];
    above = [];
    compositor = true;
    overlayWindows = []; connections = 0; overlayChanges = [];
    spawned = []; kills = []; prepared = []; logs = []; watchers = [];
    time = 0;
    manager = makeManager();
  });

  it('starts nothing while disabled, and keeps the wallpaper running on a bad section', async () => {
    config.set('visualizer.enabled', false);
    await manager.configure();
    await manager.sync();
    expect(spawned).to.have.length(0);
    expect(prepared).to.deep.equal([]);
    expect(manager.summary()).to.deep.equal({
      enabled: false, error: null, generation: 1, preset: null, presets: ['subtle', 'ring', 'wave', 'party', 'lyrics'], instances: ['main'], silenced: false, suspended: false, compositor: null, musicDim: 0, live: {}
    });

    config.set('visualizer.enabled', true);
    config.set('visualizer.module', 'spiral');
    await manager.configure();
    await manager.sync();
    expect(spawned).to.have.length(0);
    expect(manager.summary().error).to.include('visualizer.module must be');
    expect(logs.find(log => log[0] === 'error').slice(0, 2)).to.deep.equal(['error', 'Visualizer disabled']);
  });

  it('starts one instance per monitor at its geometry', async () => {
    monitors.set('HDMI-1', monitor('HDMI-1', 2560));
    config.set('visualizer.monitors', ['DP-3']);
    await manager.configure();
    await manager.sync();
    expect(prepared).to.deep.equal(['bars']);
    expect(spawned.map(item => item.args)).to.deep.equal([['DP-3', 'main', '2560x360+0+1080']]);
    expect(spawned[0].options).to.include({ detached: true });
    expect(manager.describe('DP-3')).to.deep.equal([{ instance: 'main', engine: 'glava', module: 'bars', pid: 2000, running: true, geometry: '2560x360+0+1080' }]);
    expect(manager.describe('HDMI-1')).to.deep.equal([]);
  });

  it('gives each instance its opacity and stacks it directly above its wallpaper, checking again after it settles', async () => {
    config.set('visualizer.opacity', 0.6);
    above = [false];
    await manager.configure();
    await manager.sync();
    expect(await entry().placed).to.be.true;
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

  it('runs several instances per monitor, stacked above the wallpaper in the section order', async () => {
    config.set('visualizer.instances', [
      { name: 'base' },
      { name: 'ring', module: 'radial', opacity: 1, placement: { anchor: 'center', width: 400, height: 400 } },
      { name: 'side', monitors: ['HDMI-1'] }
    ]);
    windows = new Map([['^backdrop-visualizer-DP-3-base$', 0x3400002], ['^backdrop-visualizer-DP-3-ring$', 0x3800002]]);
    await manager.configure();
    await manager.sync();
    expect(prepared).to.deep.equal(['bars', 'radial', 'bars']);
    expect(spawned.map(item => item.args)).to.deep.equal([['DP-3', 'base', '2560x360+0+1080'], ['DP-3', 'ring', '400x400+1080+520']]);
    expect(await entry('DP-3', 'ring').placed).to.be.true;
    // The base above the wallpaper, the ring above the base
    expect(xcalls.filter(call => call[0] === 'stackAbove').slice(-2)).to.deep.equal([
      ['stackAbove', 0x3400002, 0x1200001], ['stackAbove', 0x3800002, 0x3400002]
    ]);
    expect(xcalls.filter(call => call[0] === 'opacity').slice(-2)).to.deep.equal([['opacity', 0x3400002, 0.8], ['opacity', 0x3800002, 1]]);
    expect(manager.describe('DP-3').map(item => item.instance)).to.deep.equal(['base', 'ring']);
  });

  it('switches presets until the daemon exits, keeping the switch through a reload', async () => {
    config.set('visualizer.presets', { calm: { opacity: 0.3, module: 'wave' } });
    await manager.configure();
    await manager.sync();
    await manager.setPreset('party');
    expect(manager.summary()).to.include({ preset: 'party' });
    expect(spawned.slice(1).map(item => item.args.slice(0, 2))).to.deep.equal([['DP-3', 'base'], ['DP-3', 'ring']]);
    // The single instance was stopped for the preset's two
    expect(kills).to.deep.equal([[-2000, 'SIGTERM']]);
    await manager.reload();
    expect(manager.summary().preset).to.equal('party');
    await manager.setPreset('calm');
    expect(manager.settings.instances[0]).to.include({ module: 'wave', opacity: 0.3 });
    await manager.setPreset('loud');
    expect(manager.summary().error).to.include('visualizer.preset must be one of the presets');
    expect(manager.entries.size).to.equal(0);
  });

  it('runs only while audio plays, stopping on silence and starting on sound', async () => {
    config.set('visualizer.only_while_playing', true);
    config.set('visualizer.silence_grace', 5);
    await manager.configure();
    await manager.sync();
    expect(watchers).to.have.length(1);
    expect(watchers[0]).to.include({ source: 'auto', grace: 5000 });
    expect(spawned).to.have.length(1);

    await watchers[0].onChange(false);
    expect(manager.summary().silenced).to.be.true;
    expect(manager.entries.size).to.equal(0);
    // Silence is not off: the daemon must not stop for it
    expect(manager.active).to.be.true;
    await watchers[0].onChange(true);
    expect(spawned).to.have.length(2);

    // Turning the visualizer off stops the watching too; a reload with the same source keeps the watcher
    await manager.reload();
    expect(watchers).to.have.length(1);
    await manager.setEnabled(false);
    expect(watchers[0].stopped).to.be.true;
  });

  it('stops the instances while suspended, staying enabled, and starts them again after', async () => {
    const manager = makeManager();
    await manager.configure();
    await manager.sync();
    expect(manager.entries.size).to.equal(1);

    await manager.setSuspended(true);
    expect(manager.entries.size).to.equal(0);
    expect(manager.active).to.equal(true);
    expect(manager.summary()).to.include({ enabled: true, suspended: true });
    await manager.sync();
    expect(manager.entries.size).to.equal(0);

    await manager.setSuspended(false);
    expect(manager.entries.size).to.equal(1);
    await manager.stop();
  });

  describe('sleeve instances', () => {
    let ctl;
    const lyricsWindow = '^backdrop-visualizer-DP-3-main$';

    function sleeveManager(overrides = {}) {
      ctl = [];
      return makeManager({
        create: createVisualizer,
        exec: async (file, args) => {
          if (file === 'xdotool' && windows.has(args[2])) return `${windows.get(args[2])}\n`;
          if (args[0] === 'ctl') { ctl.push(args.slice(2)); return ''; }
          throw new Error('exit 1');
        },
        ...overrides
      });
    }

    beforeEach(() => {
      config = makeConfig({ 'visualizer.enabled': true, 'visualizer.engine': 'sleeve', 'paths.runtime': '/nonexistent' });
    });

    it('starts the shell managed, and forgets what sleeved remembers of the page', async () => {
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await manager.entries.values().next().value.placed;
      expect(spawned[0].file).to.equal('sleeve');
      expect(spawned[0].args.slice(0, 4)).to.deep.equal(['shell', '--managed', '--geometry', '2560x360+0+1080']);
      expect(ctl).to.deep.equal([['--instance', 'DP-3-main', '--reset']]);
      await manager.stop();
    });

    it('sends a new look over sleeve ctl without restarting, and restarts for an option it cannot unset', async () => {
      config.set('visualizer.sleeve', { now: 'full' });
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await manager.setLive({ instance: 'main', changes: { sleeve: { now: 'minimal', lyrics_align: 'right' } } });
      expect(spawned).to.have.length(1);
      expect(ctl.at(-1)).to.deep.equal(['--instance', 'DP-3-main', '--preset', 'minimal', '--align', 'right']);

      // Started with --now; a reset would go back to it, so only a restart can clear it
      expect(manager.runsWith({ ...manager.settings, instances: manager.settings.instances.map(item => ({ ...item, sleeve: { ...item.sleeve, now: null } })) })).to.equal(false);
      await manager.stop();
    });

    it('restarts for what sleeve ctl cannot change', async () => {
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await manager.setLive({ instance: 'main', changes: { sleeve: { no_sandbox: true } } });
      expect(spawned).to.have.length(2);
      expect(spawned[1].args).to.include('--no-sandbox');
      await manager.stop();
    });

    it('hides for silence rather than stopping, and starts hidden during it', async () => {
      config.set('visualizer.only_while_playing', true);
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await watchers[0].onChange(false);
      await new Promise(setImmediate);
      expect(spawned).to.have.length(1);
      expect(spawned[0].child.exitCode).to.equal(null);
      expect(ctl.at(-1)).to.deep.equal(['--instance', 'DP-3-main', '--hide']);
      await watchers[0].onChange(true);
      await new Promise(setImmediate);
      expect(ctl.at(-1)).to.deep.equal(['--instance', 'DP-3-main', '--show']);
      await watchers[0].onChange(false);
      await manager.stop();

      const silent = sleeveManager();
      watchers.length = 0;
      await silent.configure();
      silent.audio.playing = false;
      await silent.sync();
      await new Promise(setImmediate);
      expect(ctl[0]).to.deep.equal(['--instance', 'DP-3-main', '--reset', '--hide']);
      await silent.stop();
    });

    it('stops while the load has everything off', async () => {
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await manager.setSuspended(true);
      expect(manager.entries.size).to.equal(0);
      await manager.stop();
    });

    it('sends colors as one JSON line, unpaced, and nothing before they are known', async () => {
      config.set('visualizer.palette', { source: 'wallpaper' });
      const colors = { background: '#102030', main: [{ color: '#aabbcc', share: 0.6 }] };
      let known = null;
      const written = [];
      const manager = sleeveManager({ colorsFor: () => known, pipeGap: 60_000 });
      await manager.configure();
      const spawnStub = manager.spawn;
      manager.spawn = (...args) => {
        const child = spawnStub(...args);
        child.stdin = { write: line => written.push(line), on() {}, destroyed: false };
        return child;
      };
      await manager.sync();
      await manager.entries.values().next().value.writing;
      expect(spawned[0].options.stdio[0]).to.equal('pipe');
      expect(written).to.deep.equal([]);

      known = colors;
      await manager.recolor('DP-3');
      expect(written).to.deep.equal([`${JSON.stringify(colors)}\n`]);
      await manager.stop();
    });

    it('stacks from the bottom with no wallpaper, since it does not lower itself', async () => {
      windows.set(lyricsWindow, 0x3400002);
      screens.clear();
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await manager.entries.values().next().value.placed;
      expect(xcalls).to.deep.include(['lower', 0x3400002]);
      await manager.stop();
    });

    it('does not lower it under a wallpaper whose window is not found', async () => {
      windows.set(lyricsWindow, 0x3400002);
      screens.set('DP-3', { client: new FakeMpvClient() });
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      await manager.entries.values().next().value.placed;
      expect(xcalls.filter(call => call[0] === 'lower')).to.deep.equal([]);
      await manager.stop();
    });

    it('leaves GLava to lower itself with no wallpaper', async () => {
      config = makeConfig({ 'visualizer.enabled': true });
      screens.clear();
      const manager = makeManager();
      await manager.configure();
      await manager.sync();
      await manager.entries.values().next().value.placed;
      expect(xcalls.filter(call => call[0] === 'lower')).to.deep.equal([]);
      await manager.stop();
    });

    it('gives up at once on status 2, which sleeve means as no use retrying', async () => {
      const manager = sleeveManager();
      await manager.configure();
      await manager.sync();
      const entry = manager.entries.values().next().value;
      entry.output.push('run just shell-install');
      spawned[0].child.exit(2, null);
      await entry.exited;
      expect(spawned).to.have.length(1);
      expect(entry.failed).to.equal(true);
      expect(logs.some(([level, message]) => level === 'error' && message.includes('sleeve cannot start'))).to.equal(true);
      await manager.stop();
    });

    it('carries on when sleeved is not running', async () => {
      const failing = Object.assign(new Error('exit 2'), { code: 2 });
      const manager = sleeveManager({ exec: async file => { if (file === 'sleeve') throw failing; throw new Error('exit 1'); } });
      await manager.configure();
      await manager.sync();
      await new Promise(setImmediate);
      expect(manager.entries.size).to.equal(1);
      await manager.stop();
    });
  });

  describe('wallpaper dim while music plays', () => {
    let dims;
    beforeEach(() => {
      dims = [];
      manager = makeManager({ onMusicDim: dim => dims.push(dim) });
    });

    it('watches the audio without only_while_playing and reports the dim, keeping the instances on silence', async () => {
      config.set('visualizer.wallpaper_dim', 30);
      await manager.configure();
      await manager.sync();
      expect(watchers).to.have.length(1);
      expect(manager.musicDim).to.equal(30);
      expect(dims).to.deep.equal([30]);

      await watchers[0].onChange(false);
      expect(dims).to.deep.equal([30, 0]);
      expect(manager.entries.size).to.equal(1);
      expect(manager.summary()).to.include({ silenced: false, musicDim: 0 });
      await watchers[0].onChange(true);
      expect(dims).to.deep.equal([30, 0, 30]);
      expect(spawned).to.have.length(1);
    });

    it('restores the wallpaper when the visualizer turns off or the daemon stops', async () => {
      config.set('visualizer.wallpaper_dim', 30);
      await manager.configure();
      await manager.sync();
      await manager.setEnabled(false);
      expect(dims).to.deep.equal([30, 0]);
      await manager.setEnabled(true);
      expect(dims).to.deep.equal([30, 0, 30]);
      await manager.stop();
      expect(dims).to.deep.equal([30, 0, 30, 0]);
    });

    it('takes a saved wallpaper_dim without restarting GLava, and stops watching when it goes back to 0', async () => {
      await manager.configure();
      await manager.sync();
      expect(watchers).to.have.length(0);
      config.set('visualizer.wallpaper_dim', 25);
      await manager.refresh();
      expect(spawned).to.have.length(1);
      expect(watchers).to.have.length(1);
      expect(dims).to.deep.equal([25]);
      config.set('visualizer.wallpaper_dim', 0);
      await manager.refresh();
      expect(watchers[0].stopped).to.be.true;
      expect(dims).to.deep.equal([25, 0]);
    });
  });

  it('waits for sound before starting when the source is silent at start', async () => {
    config.set('visualizer.only_while_playing', true);
    manager = makeManager({ audioWatcher: options => Object.assign(new FakeWatcher(options), { initial: false }) });
    await manager.configure();
    await manager.sync();
    expect(spawned).to.have.length(0);
    expect(logs.map(log => log[1])).to.include('Audio is silent, visualizer waits for it');
    await watchers[0].onChange(true);
    expect(spawned).to.have.length(1);
  });

  it('leaves an instance at the bottom without a wallpaper, and warns when its window never shows', async () => {
    screens.clear();
    await manager.configure();
    await manager.sync();
    expect(await entry().placed).to.be.true;
    expect(xcalls).to.deep.equal([['opacity', 0x3400002, 0.8]]);

    windows.clear();
    await manager.reload();
    expect(await entry().placed).to.be.false;
    expect(logs.map(log => log[1])).to.include('Visualizer window not found, cannot place it');
  });

  it('follows monitor changes: moves on a new geometry, stops on removal', async () => {
    await manager.configure();
    await manager.sync();
    monitors.set('DP-3', { ...monitor('DP-3'), width: 1920, height: 1080 });
    await manager.sync();
    expect(kills).to.deep.equal([[-2000, 'SIGTERM']]);
    expect(spawned[1].args[2]).to.equal('1920x270+0+810');
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
      await pause(5);
    }
    expect(spawned).to.have.length(6);
    expect(logs.find(log => log[1] === 'Visualizer exited, restarting')[2]).to.include({ code: 1, output: 'shader error', instance: 'main' });
    spawned.at(-1).child.exit(1);
    await pause(5);
    expect(spawned).to.have.length(6);
    expect(logs.filter(log => log[0] !== 'info').at(-1)[1]).to.equal('Visualizer keeps exiting, giving up on it until reload');
    expect(manager.describe('DP-3')[0].running).to.be.false;

    await manager.reload();
    expect(spawned).to.have.length(7);
    expect(manager.describe('DP-3')[0].running).to.be.true;
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

  describe('colors from the wallpaper', () => {
    let writes, colors;
    // Children with a stdin that records each write, and the time it came at
    const pipedManager = () => makeManager({
      pipeGap: 15,
      colorsFor: (target, instance, geometry) => colors?.(target, instance, geometry) ?? null,
      spawn: (file, args, options) => {
        const child = new FakeChild(2000 + spawned.length);
        child.stderr = new EventEmitter();
        child.stdin = Object.assign(new EventEmitter(), { destroyed: false, write: line => { writes.push([Date.now(), line]); } });
        spawned.push({ file, args, options, child });
        return child;
      }
    });

    beforeEach(() => {
      writes = [];
      colors = null;
      config.set('visualizer.palette', { source: 'wallpaper' });
      config.set('visualizer.bars', { colors: ['#000000', '#33aacc'] });
      manager = pipedManager();
    });

    it('opens stdin and sends the configured colors at once, one line at a time', async () => {
      await manager.configure();
      await manager.sync();
      expect(spawned[0].options.stdio[0]).to.equal('pipe');
      await entry().writing;
      expect(writes.map(([, line]) => line)).to.deep.equal(['fg = #000000ff\n', 'fg2 = #33aaccff\n']);
      // Apart, so GLava reads each on its own
      expect(writes[1][0] - writes[0][0]).to.be.at.least(10);
      expect(manager.describe('DP-3')[0].colors).to.deep.equal({ fg: '#000000ff', fg2: '#33aaccff' });
      expect(manager.wantsWallpaperColors('DP-3')).to.equal(true);
      expect(manager.wantsWallpaperColors('HDMI-1')).to.equal(false);
    });

    it('starts with the wallpaper\'s colors when known, and recolors only what changed', async () => {
      const asked = [];
      colors = (target, instance, geometry) => { asked.push([target.name, instance.name, geometry.height]); return { fg: '#111111ff', fg2: '#222222ff' }; };
      await manager.configure();
      await manager.sync();
      await entry().writing;
      expect(asked).to.deep.equal([['DP-3', 'main', 360]]);
      expect(writes.map(([, line]) => line)).to.deep.equal(['fg = #111111ff\n', 'fg2 = #222222ff\n']);

      await manager.recolor('DP-3');
      expect(writes).to.have.length(2);
      colors = () => ({ fg: '#333333ff', fg2: '#444444ff' });
      await manager.recolor('DP-3');
      expect(writes.slice(2).map(([, line]) => line)).to.deep.equal(['fg = #333333ff\n', 'fg2 = #444444ff\n']);
      expect(logs.some(log => log[1] === 'Visualizer colors from the wallpaper')).to.equal(true);

      // Unknown again (wallpaper off): back to the configured colors
      colors = null;
      await manager.recolor('DP-3');
      expect(writes.slice(4).map(([, line]) => line)).to.deep.equal(['fg = #000000ff\n', 'fg2 = #33aaccff\n']);
    });

    it('drops colors superseded before they are written, and sends them again after a restart', async () => {
      await manager.configure();
      await manager.sync();
      colors = () => ({ fg: '#555555ff', fg2: '#666666ff' });
      await manager.recolor('DP-3');
      // The configured fg went out, then the newer colors replaced the rest of that write
      expect(writes.map(([, line]) => line)).to.deep.equal(['fg = #000000ff\n', 'fg = #555555ff\n', 'fg2 = #666666ff\n']);

      spawned[0].child.exit(1);
      await pause(30);
      await entry().writing;
      expect(spawned).to.have.length(2);
      expect(writes.slice(3).map(([, line]) => line)).to.deep.equal(['fg = #555555ff\n', 'fg2 = #666666ff\n']);
    });

    it('leaves stdin closed and colors out of the description with palette.source: config', async () => {
      config.set('visualizer.palette', { source: 'config' });
      await manager.configure();
      await manager.sync();
      expect(spawned[0].options.stdio[0]).to.equal('ignore');
      expect(manager.describe('DP-3')[0]).to.not.have.property('colors');
      expect(manager.wantsWallpaperColors('DP-3')).to.equal(false);
      await manager.recolor('DP-3');
      expect(writes).to.deep.equal([]);
    });
  });

  describe('menu changes', () => {
    it('merges each instance\'s changes, restarts with the ones GLava reads at start, and drops them on reset', async () => {
      await manager.configure();
      await manager.sync();
      await entry().placed;
      await manager.setLive({ instance: 'main', changes: { opacity: 0.5 } });
      await manager.setLive({ instance: 'main', changes: { bars: { amplify: 120 } } });
      expect(manager.summary().live).to.deep.equal({ main: { opacity: 0.5, bars: { amplify: 120 } } });
      expect(manager.settings.instances[0]).to.include({ opacity: 0.5 });
      expect(manager.settings.instances[0].defines.AMPLIFY).to.equal(120);
      // Opacity applied to the running window; amplify restarted it
      expect(spawned).to.have.length(2);
      expect(xcalls).to.deep.include(['opacity', 0x3400002, 0.5]);

      await manager.setLive(null);
      expect(manager.summary().live).to.deep.equal({});
      expect(manager.settings.instances[0]).to.include({ opacity: 0.8 });
      expect(spawned).to.have.length(3);
    });

    it('sets opacity on the running window without a restart', async () => {
      await manager.configure();
      await manager.sync();
      await entry().placed;
      xcalls.length = 0;
      await manager.setLive({ instance: 'main', changes: { opacity: 0.3 } });
      expect(spawned).to.have.length(1);
      expect(kills).to.deep.equal([]);
      expect(xcalls).to.deep.equal([['opacity', 0x3400002, 0.3]]);
      expect(entry().instance.opacity).to.equal(0.3);
      // A restart after a crash keeps the new opacity
      expect(entry().adapter.instance.opacity).to.equal(0.3);
    });

    it('picks wallpaper colors again without a restart, and restarts when the color source changes', async () => {
      const picks = [];
      manager = makeManager({ colorsFor: (target, instance) => { picks.push(instance.palette.pick); return { fg: '#112233ff', fg2: '#445566ff' }; }, pipeGap: 0 });
      config.set('visualizer.palette', { source: 'wallpaper', pick: 'vivid' });
      await manager.configure();
      await manager.sync();
      spawned[0].child.stdin = { write: () => {}, on: () => {}, destroyed: false };
      await manager.setLive({ instance: 'main', changes: { palette: { pick: 'complement' } } });
      expect(spawned).to.have.length(1);
      expect(picks.at(-1)).to.equal('complement');

      await manager.setLive({ instance: 'main', changes: { palette: { source: 'config' } } });
      expect(spawned).to.have.length(2);
    });

    it('takes a saved config change live when it can, else reloads', async () => {
      await manager.configure();
      await manager.sync();
      await entry().placed;
      const generation = manager.summary().generation;
      config.set('visualizer.opacity', 0.6);
      await manager.refresh();
      expect(spawned).to.have.length(1);
      expect(manager.summary().generation).to.equal(generation + 1);
      expect(xcalls).to.deep.include(['opacity', 0x3400002, 0.6]);

      config.set('visualizer.module', 'radial');
      await manager.refresh();
      expect(spawned).to.have.length(2);

      config.set('visualizer.module', 'spiral');
      await manager.refresh();
      expect(manager.summary().error).to.include('visualizer.module must be');
    });

    it('refuses a change that does not check out, leaving the visualizer as it was', async () => {
      await manager.configure();
      await manager.sync();
      const error = await manager.setLive({ instance: 'main', changes: { module: 'spiral' } }).catch(caught => caught);
      expect(error.message).to.include('visualizer.module must be');
      expect(manager.summary()).to.include({ error: null });
      expect(manager.summary().live).to.deep.equal({});
      expect(spawned).to.have.length(1);
    });

    it('keeps the changes over a preset switched later, and records without reloading when asked', async () => {
      await manager.configure();
      await manager.setLive({ instance: 'main', changes: { opacity: 0.3 } }, { reload: false });
      expect(manager.settings.instances[0]).to.include({ opacity: 0.8 });
      await manager.setPreset('subtle');
      expect(manager.settings.instances[0]).to.include({ opacity: 0.3 });
    });
  });

  it('checks for a compositor on every placement, logging only when it goes or comes back', async () => {
    compositor = false;
    await manager.configure();
    await manager.sync();
    await entry().placed;
    expect(manager.summary().compositor).to.equal(false);
    await manager.restack('DP-3');
    const warnings = () => logs.filter(log => log[0] === 'warn' && log[1].startsWith('No compositor'));
    expect(warnings()).to.have.length(1);
    compositor = true;
    await manager.restack('DP-3');
    expect(manager.summary().compositor).to.equal(true);
    expect(logs.some(log => log[1] === 'A compositor runs again')).to.equal(true);
  });
  describe('overlays', () => {
    const full = { x: 0, y: 0, width: 2560, height: 1440 };
    const stacked = () => xcalls.filter(call => call[0] === 'stackAbove').map(call => call.slice(1));

    it('stacks overlays marked below under the instances and those marked above over them, on their own monitor only', async () => {
      monitors.set('HDMI-1', monitor('HDMI-1', 2560));
      config.set('visualizer.monitors', ['DP-3']);
      overlayWindows = [
        { window: 0x5000001, name: 'lyrics', position: 'above', geometry: full },
        { window: 0x5000002, name: 'clock', position: 'below', geometry: { x: 100, y: 100, width: 400, height: 200 } },
        // Its center is on HDMI-1
        { window: 0x5000003, name: 'other', position: 'above', geometry: { ...full, x: 2560 } }
      ];
      await manager.configure();
      await manager.sync();
      expect(await entry().placed).to.be.true;
      expect(stacked()).to.deep.equal([[0x5000002, 0x1200001], [0x3400002, 0x5000002], [0x5000001, 0x3400002]]);
      expect(manager.overlaysOn('DP-3').map(overlay => overlay.window)).to.deep.equal([0x5000001, 0x5000002]);
      expect(overlayChanges).to.deep.equal(['DP-3']);
      expect(manager.wantsWallpaperColors('DP-3')).to.be.true;
      expect(logs.find(log => log[1] === 'Overlays found')[2].overlays).to.deep.equal([
        { window: 0x5000001, name: 'lyrics', position: 'above' }, { window: 0x5000002, name: 'clock', position: 'below' }
      ]);

      // Moved from above to below: the next placement swaps it under the instance
      overlayWindows = [{ ...overlayWindows[0], position: 'below' }];
      xcalls = [];
      expect(await manager.restack('DP-3')).to.be.true;
      expect(stacked()).to.deep.equal([[0x5000001, 0x1200001], [0x3400002, 0x5000001]]);
      expect(overlayChanges).to.deep.equal(['DP-3', 'DP-3']);
    });

    it('without instances, looks for overlays only when asked or when it found some at the last look', async () => {
      config.set('visualizer.enabled', false);
      await manager.configure();
      await manager.sync();
      overlayWindows = [{ window: 0x5000001, name: 'lyrics', position: 'above', geometry: full }];
      expect(await manager.restack('DP-3')).to.be.false;
      await manager.restackAll();
      expect(connections).to.equal(0);

      await manager.restackAll({ scan: true });
      expect(connections).to.equal(1);
      expect(stacked()).to.deep.equal([[0x5000001, 0x1200001]]);
      expect(manager.wantsWallpaperColors('DP-3')).to.be.true;

      // Known overlays keep the monitor looked at, until a look finds them gone
      overlayWindows = [];
      expect(await manager.restack('DP-3')).to.be.false;
      expect(connections).to.equal(2);
      expect(logs.some(log => log[1] === 'Overlays gone')).to.be.true;
      expect(await manager.restack('DP-3')).to.be.false;
      expect(connections).to.equal(2);
      expect(manager.wantsWallpaperColors('DP-3')).to.be.false;
    });

    it('still places the instances when looking for overlays fails', async () => {
      overlayWindows = new Error('BadWindow');
      await manager.configure();
      await manager.sync();
      expect(await entry().placed).to.be.true;
      expect(stacked()).to.deep.equal([[0x3400002, 0x1200001]]);
      expect(logs.find(log => log[1] === 'Failed to look for overlay windows')[2]).to.deep.equal({ monitor: 'DP-3', error: 'BadWindow' });
    });
  });
});
