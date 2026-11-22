import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { PresetShots, presetShot, presetShotPath } from '../../src/visualizer/PresetShots.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('PresetShots', () => {
  let dir, time, manager, execs, areas, shots, failGrab;
  const monitor = (name, x = 0) => ({ name, x, y: 0, width: 1920, height: 1080 });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-shots-'));
    time = 0;
    execs = [];
    failGrab = false;
    // What uncoveredArea answers per monitor: an area, or null while covered
    areas = { 'DP-1': null, 'DP-2': { x: 1920, y: 20, width: 1920, height: 1060 } };
    const entries = new Map([
      ['DP-1\tmain', { monitor: monitor('DP-1'), window: 0x100 }],
      ['DP-2\tmain', { monitor: monitor('DP-2', 1920), window: 0x200 }]
    ]);
    manager = {
      config: makeConfig({ 'paths.thumbnails': dir }),
      settings: { screenshots: true, preset: 'ring', audio: 'pulseaudio' },
      active: true, stopping: false, suspended: false, live: {},
      audio: { playing: true },
      entries,
      monitors: new Map([['DP-1', monitor('DP-1')], ['DP-2', monitor('DP-2', 1920)]]),
      current: () => true,
      monitorEntries: name => [...entries.values()].filter(entry => entry.monitor.name === name),
      overlaysOn: () => [{ window: 0x900 }],
      wallpaperWindow: async name => (name === 'DP-1' ? 0x10 : 0x20),
      x11: async fn => fn({
        topLevel: async id => id + 1,
        uncoveredArea: async (target, own) => {
          execs.push(['look', target.name, [...own]]);
          return areas[target.name];
        }
      })
    };
    shots = new PresetShots({
      manager, logger: silentLogger, now: () => time, display: ':5',
      exec: async (file, args) => {
        execs.push([file, args]);
        if (failGrab) throw new Error('x11grab failed');
        await fs.writeFile(args.at(-1), 'jpeg');
      }
    });
  });

  afterEach(async () => {
    shots.stop();
    await fs.remove(dir);
  });

  const grabs = () => execs.filter(([file]) => file === 'nice');

  it('takes one screenshot once the preset has been in force for 30 s, of a monitor nothing covers', async () => {
    expect(await shots.check()).to.equal(false);
    time = 29999;
    expect(await shots.check()).to.equal(false);
    expect(execs).to.deep.equal([]);
    time = 30000;
    expect(await shots.check()).to.equal(true);
    // DP-1 is covered, DP-2 shows only the wallpaper, its instance and the overlay (dock cropped off)
    expect(execs[0]).to.deep.equal(['look', 'DP-1', [0x10, 0x101, 0x900]]);
    expect(execs[1]).to.deep.equal(['look', 'DP-2', [0x20, 0x201, 0x900]]);
    const [, args] = grabs()[0];
    expect(args.slice(0, 3)).to.deep.equal(['-n', '19', 'ffmpeg']);
    expect(args).to.include.members(['x11grab', '1920x1060', ':5+1920,20']);
    expect((await presetShot(dir, 'ring')).path).to.equal(presetShotPath(dir, 'ring'));
    // Once per switch
    time = 90000;
    expect(await shots.check()).to.equal(false);
    expect(grabs()).to.have.length(1);
  });

  it('looks again every 30 s while every monitor is covered', async () => {
    areas['DP-2'] = null;
    await shots.check();
    time = 30000;
    expect(await shots.check()).to.equal(false);
    time = 45000;
    expect(await shots.check()).to.equal(false);
    expect(execs.filter(([kind]) => kind === 'look')).to.have.length(2);
    areas['DP-1'] = { x: 0, y: 0, width: 1920, height: 1080 };
    time = 60000;
    expect(await shots.check()).to.equal(true);
    expect(grabs()[0][1]).to.include(':5+0,0');
  });

  it('starts the 30 s again after silence, menu changes or the load stopping it, and waits for sound', async () => {
    await shots.check();
    time = 20000;
    manager.audio.playing = false;
    await shots.check();
    time = 25000;
    manager.audio.playing = true;
    await shots.check();
    time = 50000;
    expect(await shots.check()).to.equal(false);
    time = 55000;
    manager.live = { main: { opacity: 0.2 } };
    expect(await shots.check()).to.equal(false);
    manager.live = {};
    manager.suspended = true;
    time = 100000;
    expect(await shots.check()).to.equal(false);
    manager.suspended = false;
    await shots.check();
    time = 130000;
    expect(await shots.check()).to.equal(true);
  });

  it('takes the same preset again only after a switch away, not after a pause', async () => {
    await shots.check();
    time = 30000;
    await shots.check();
    manager.audio.playing = false;
    await shots.check();
    manager.audio.playing = true;
    await shots.check();
    time = 70000;
    expect(await shots.check()).to.equal(false);
    manager.settings = { ...manager.settings, preset: 'wave' };
    await shots.check();
    time = 100000;
    expect(await shots.check()).to.equal(true);
    manager.settings = { ...manager.settings, preset: 'ring' };
    await shots.check();
    time = 130000;
    expect(await shots.check()).to.equal(true);
    expect(grabs()).to.have.length(3);
  });

  it('takes none without a preset, with screenshots off, or with no instance window found', async () => {
    const tryAt = async () => {
      await shots.check();
      time += 30000;
      return shots.check();
    };
    manager.settings = { ...manager.settings, preset: null };
    expect(await tryAt()).to.equal(false);
    manager.settings = { ...manager.settings, preset: 'ring', screenshots: false };
    expect(await tryAt()).to.equal(false);
    manager.settings = { ...manager.settings, screenshots: true };
    for (const entry of manager.entries.values()) entry.window = null;
    expect(await tryAt()).to.equal(false);
    expect(execs).to.deep.equal([]);
  });

  it('counts unknown sound as playing with audio: fifo, which cannot be watched', async () => {
    manager.settings = { ...manager.settings, audio: 'fifo' };
    manager.audio.playing = null;
    await shots.check();
    time = 30000;
    expect(await shots.check()).to.equal(true);
  });

  it('leaves no partial file when the grab fails, and tries again later', async () => {
    failGrab = true;
    await shots.check();
    time = 30000;
    expect(await shots.check()).to.equal(false);
    expect(await fs.readdir(dir)).to.deep.equal([]);
    failGrab = false;
    time = 60000;
    expect(await shots.check()).to.equal(true);
  });

  it('ticks only while the settings want screenshots', () => {
    shots.update();
    expect(shots.timer).to.not.equal(null);
    manager.settings = { ...manager.settings, preset: null };
    shots.update();
    expect(shots.timer).to.equal(null);
  });
});
