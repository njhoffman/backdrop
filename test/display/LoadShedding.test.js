import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Daemon, readState } from '../../src/display/Daemon.js';
import { getMode, getChosenMode, getModeHold, setMode, setModeHold, displayMode } from '../../src/display/Playlist.js';
import { FakeMpvClient, FakeChild, makeConfig, silentLogger, LISTMONITORS_TWO } from '../helpers/fakes.js';
import { notifications } from '../helpers/setup.js';

describe('Load shedding', () => {
  let tempDir, db, config, spawned, clients, replaced, calls, visualizers, load, time, daemon;

  function makeDaemon() {
    return new Daemon({
      config, database: db, logger: silentLogger, visualizers,
      exec: async () => LISTMONITORS_TWO,
      spawn: () => {
        const child = new FakeChild(1000 + spawned.length);
        spawned.push(child);
        return child;
      },
      connect: async socketPath => {
        const client = new FakeMpvClient();
        const send = client.command.bind(client);
        client.command = (...args) => {
          if (args[0] === 'loadfile' && args[2] === 'replace') replaced.push(args[1]);
          return send(...args);
        };
        clients.push({ socketPath, client });
        return client;
      },
      kill: () => {},
      restartDelay: 0, stopGrace: 5,
      importer: { importDirs: async () => ({ imported: [] }) },
      purge: async () => {},
      healthInterval: 0, monitorInterval: 0, purgeInterval: 0, loadInterval: 0,
      readFile: async () => { throw new Error('no /proc in tests'); },
      gpuMemory: async () => null,
      watch: null,
      readStart: pid => `t${pid}`,
      reap: async () => [],
      now: () => time,
      loadavg: () => [load, load, load]
    });
  }

  // The files that replaced a playlist, in order
  const loaded = () => replaced;

  // Readings until the load has been at this value past both waits
  async function settle(value) {
    load = value;
    await daemon.load.check();
    time += 1_000_000;
    await daemon.load.check();
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-load-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({
      'paths.runtime': tempDir, 'display.mpv_args': ['--vo=gpu'],
      load: { enabled: true, window: 1, image_above: 10, off_above: 20, resume_ratio: 0.5, sustain: 60, resume_after: 300 }
    });
    spawned = [];
    clients = [];
    replaced = [];
    calls = [];
    load = 0;
    time = 1_000_000;
    visualizers = {
      override: null, on: false,
      get active() { return this.override ?? this.on; },
      setEnabled: async on => { visualizers.override = on; },
      setSuspended: async on => { calls.push(['suspended', on]); },
      restackAll: async () => { calls.push('restackAll'); },
      configure: async () => {}, sync: async () => {}, restack: () => {}, stop: async () => {},
      describe: () => [],
      summary: () => ({ enabled: false, error: null })
    };
    db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4', width: 4000, height: 4000 });
    db.addMedia({ kind: 'image', source: 'local', source_id: 2, path: '/m/i.png', width: 4000, height: 4000 });
    setMode(db, 'video');
    daemon = makeDaemon();
    notifications.length = 0;
  });

  afterEach(async () => {
    await daemon.stop();
    db.close();
    await fs.remove(tempDir);
  });

  it('changes nothing with the section off, whatever the load', async () => {
    config.get().load.enabled = false;
    load = 99;
    await daemon.start();
    await settle(99);
    expect(getModeHold(db)).to.equal(null);
    expect(daemon.screens.size).to.equal(2);
    expect((await readState(tempDir)).load).to.equal(null);
    expect(notifications).to.have.length(0);
  });

  it('shows images while held and returns to the chosen video', async () => {
    await daemon.start();
    expect(loaded()).to.deep.equal(['/m/v.mp4', '/m/v.mp4']);

    await settle(15);
    expect(getMode(db)).to.equal('image');
    expect(getChosenMode(db)).to.equal('video');
    expect(loaded().slice(2)).to.deep.equal(['/m/i.png', '/m/i.png']);
    expect((await readState(tempDir)).load).to.include({ level: 'image', value: 15 });

    await settle(1);
    expect(getModeHold(db)).to.equal(null);
    expect(loaded().slice(4)).to.deep.equal(['/m/v.mp4', '/m/v.mp4']);
  });

  it('does not reload a playlist when the chosen mode is already images', async () => {
    setMode(db, 'image');
    await daemon.start();
    await settle(15);
    expect(daemon.load.level).to.equal('image');
    expect(loaded()).to.have.length(2);
  });

  it('keeps the video on a monitor with no eligible images', async () => {
    db.db.prepare("DELETE FROM media WHERE kind = 'image'").run();
    await daemon.start();
    await settle(15);
    expect(daemon.load.level).to.equal('image');
    expect(loaded()).to.have.length(2);
    expect(displayMode(db, { width: 100, height: 100 })).to.equal('video');
  });

  it('stops everything at off without stopping the daemon or changing the user\'s choices', async () => {
    await daemon.start();
    await settle(25);
    expect(daemon.screens.size).to.equal(0);
    expect(daemon.wallpaper).to.equal(true);
    expect(daemon.stopping).to.equal(false);
    expect(calls).to.deep.include(['suspended', true]);

    const state = await readState(tempDir);
    expect(state.wallpaper).to.equal(true);
    expect(state.load.level).to.equal('off');
    expect(state.monitors.map(monitor => monitor.socket)).to.deep.equal([null, null]);
  });

  it('a control request during off does not stop the daemon', async () => {
    await daemon.start();
    await settle(25);
    await daemon.applyControl();
    expect(daemon.stopping).to.equal(false);
  });

  it('restarts on recovery, on images first, placing the visualizer above them', async () => {
    await daemon.start();
    await settle(25);
    calls.length = 0;
    await settle(1);
    expect(daemon.load.level).to.equal('image');
    expect(daemon.screens.size).to.equal(2);
    expect(loaded().slice(-2)).to.deep.equal(['/m/i.png', '/m/i.png']);
    expect(calls).to.deep.equal([['suspended', false], 'restackAll']);
  });

  it('leaves a wallpaper turned off by hand off after recovery', async () => {
    await daemon.start();
    visualizers.on = true;
    await daemon.setWallpaper(false);
    await settle(25);
    await settle(1);
    expect(daemon.load.level).to.equal('image');
    expect(daemon.screens.size).to.equal(0);
  });

  it('holds back a wallpaper turned on during off until recovery', async () => {
    await daemon.start();
    visualizers.on = true;
    await daemon.setWallpaper(false);
    await settle(25);
    await daemon.setWallpaper(true);
    expect(daemon.wallpaper).to.equal(true);
    expect(daemon.screens.size).to.equal(0);
    await settle(1);
    expect(daemon.screens.size).to.equal(2);
  });

  it('starts at the level for the load now, and replaces a hold a crash left', async () => {
    load = 25;
    await daemon.start();
    expect(daemon.load.level).to.equal('off');
    expect(spawned).to.have.length(0);
    expect(calls).to.deep.include(['suspended', true]);
    expect((await readState(tempDir)).monitors).to.have.length(2);
    await daemon.stop();
    expect(getModeHold(db)).to.equal(null);

    setModeHold(db, 'image');
    load = 0;
    daemon = makeDaemon();
    await daemon.start();
    expect(getMode(db)).to.equal('video');
    expect(loaded()).to.deep.equal(['/m/v.mp4', '/m/v.mp4']);
  });

  it('does not start a monitor added during off', async () => {
    await daemon.start();
    await settle(25);
    daemon.monitors.clear();
    await daemon.checkMonitors();
    expect(daemon.monitors.size).to.equal(2);
    expect(daemon.screens.size).to.equal(0);
  });

  it('notifies on each change unless notifications are off', async () => {
    await daemon.start();
    await settle(15);
    expect(notifications.at(-1).join(' ')).to.include('Load 15.0: images only');
    config.get().display.notify = 'off';
    const count = notifications.length;
    await settle(1);
    expect(notifications).to.have.length(count);
  });

  it('applies a saved change to the section at once', async () => {
    await daemon.start();
    await settle(15);
    const next = structuredClone(config.get());
    next.load.enabled = false;
    await daemon.applySettings(next);
    expect(daemon.load.level).to.equal('normal');
    expect(getModeHold(db)).to.equal(null);
    expect(loaded().at(-1)).to.equal('/m/v.mp4');

    const on = structuredClone(config.get());
    on.load.enabled = true;
    load = 25;
    await daemon.applySettings(on);
    expect(daemon.load.level).to.equal('off');
    expect(daemon.screens.size).to.equal(0);
  });
});
