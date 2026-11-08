import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Smooth } from '../../src/display/daemon/Smooth.js';
import { bounceUrl } from '../../src/display/bounce.js';
import { smoothWorkPath, smoothedPath, smoothedReversedPath } from '../../src/library/smooth.js';
import { FakeMpvClient, makeConfig, silentLogger } from '../helpers/fakes.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Smooth (daemon)', () => {
  let dir, db, config, daemon, smooth, made, reversed, swapped;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-smoothq-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'paths.smooth': path.join(dir, 'smooth'), 'paths.bounce': path.join(dir, 'bounce'), 'display.smooth': true });
    made = [];
    reversed = [];
    swapped = [];
    daemon = {
      config, database: db, logger: silentLogger, stopping: false, screens: new Map(), monitors: new Map([['DP-1', { name: 'DP-1', width: 1920, height: 1080 }]]),
      load: { level: 'normal' }, now: () => Date.now(),
      enqueue: task => task(),
      bounce: { pending: new Set(), swap: async ids => { swapped.push([...ids]); } },
      smoothVideo: async (media, { dir: out, size, signal }) => {
        made.push({ id: media.id, size });
        if (signal.aborted) return null;
        await fs.outputFile(smoothedPath(media, out), 'smoothed');
        return smoothedPath(media, out);
      },
      reverse: async (copy, { dir: out }) => {
        reversed.push(copy);
        const file = path.join(out, `${copy.id}.mp4`);
        await fs.outputFile(file, 'reversed');
        return file;
      }
    };
    smooth = new Smooth(daemon);
  });

  afterEach(async () => {
    await smooth.stop();
    db.close();
    await fs.remove(dir);
  });

  async function video(n, { speed = 0.5, fps = 30, bounce = false } = {}) {
    const file = path.join(dir, 'media', `${n}.mp4`);
    await fs.outputFile(file, 'video');
    return db.getMedia(db.addMedia({ kind: 'video', source: 'local', source_id: n, path: file, width: 2560, height: 1440, duration: 10, fps, speed, bounce }));
  }

  const settle = async () => {
    for (let i = 0; i < 100 && (smooth.running || smooth.queue.size); i++) await wait(5);
  };

  it('works through the slowed videos, the highest rated first, at the largest monitor\'s size', async () => {
    const low = await video(1);
    const high = await video(2);
    await video(3, { speed: 1 });
    db.addRating(high.id, 3);
    await smooth.begin();
    await settle();
    expect(made.map(item => item.id)).to.deep.equal([high.id, low.id]);
    expect(made[0].size).to.deep.equal({ width: 1920, height: 1080 });
    // Each finished item's entries are swapped for its copy
    expect(swapped.map(ids => ids.at(-1))).to.deep.equal([high.id, low.id]);
  });

  it('starts no job while no monitor is known, so no copy is made at the video\'s own size', async () => {
    const media = await video(1);
    const monitors = daemon.monitors;
    daemon.monitors = new Map();
    smooth.want(media);
    await settle();
    expect(made).to.deep.equal([]);
    expect([...smooth.queue.keys()]).to.deep.equal([media.id]);
    daemon.monitors = monitors;
    smooth.kick();
    await settle();
    expect(made).to.deep.equal([{ id: media.id, size: { width: 1920, height: 1080 } }]);
  });

  it('carries on with an item a stopped job left chunks for before the rest of the backlog', async () => {
    const high = await video(1);
    const started = await video(2);
    db.addRating(high.id, 3);
    await fs.ensureDir(smoothWorkPath(started, config.get().paths.smooth));
    await smooth.begin();
    await settle();
    expect(made.map(item => item.id)).to.deep.equal([started.id, high.id]);
  });

  it('deletes kept work of items that no longer want that copy', async () => {
    const kept = await video(1);
    const respeeded = await video(2);
    const dirSmooth = config.get().paths.smooth;
    for (const media of [kept, respeeded]) await fs.ensureDir(smoothWorkPath(media, dirSmooth));
    await fs.ensureDir(path.join(dirSmooth, '99@0.5.smooth.work'));
    db.updateMedia(respeeded.id, { speed: 0.75 });
    await smooth.prune();
    expect(await fs.readdir(dirSmooth)).to.deep.equal([`${kept.id}@0.5.smooth.work`]);
  });

  it('makes a bouncing video\'s reversed copy from its smoothed one', async () => {
    const media = await video(1, { bounce: true });
    smooth.want(media);
    await settle();
    expect(reversed).to.have.length(1);
    expect(reversed[0]).to.include({ id: `${media.id}@0.5.reversed`, path: smoothedPath(media, config.get().paths.smooth), fps: 120, width: 1920 });
    expect(await fs.pathExists(smoothedReversedPath(media, config.get().paths.smooth))).to.equal(true);
  });

  it('puts the playing and next items first, and blends frames while a slowed one plays without its copy', async () => {
    const backlog = await video(1);
    const playing = await video(2);
    const next = await video(3);
    smooth.want(backlog, { start: false });
    const client = new FakeMpvClient({ playlist: [{ filename: playing.path, current: true }, { filename: next.path }] });
    const screen = { monitor: { name: 'DP-1' }, client };
    daemon.load.level = 'images';
    await smooth.onLoaded(screen, playing, playing.path);
    expect([...smooth.queue.keys()]).to.deep.equal([next.id, playing.id, backlog.id]);
    expect(client.properties).to.include({ 'video-sync': 'display-resample', interpolation: true });

    // Its smoothed copy plays: no blending
    const copyUrl = bounceUrl(smoothedPath(playing, config.get().paths.smooth), null, playing.path);
    await smooth.applyBlend(screen, playing, copyUrl);
    expect(client.properties).to.include({ 'video-sync': 'audio', interpolation: false });
    // An unslowed video: none either, and nothing is sent when nothing changes
    client.commands.length = 0;
    await smooth.applyBlend(screen, await video(4, { speed: 1 }), '/m/4.mp4');
    expect(client.commands).to.deep.equal([]);
  });

  it('waits while the load is up, and starts again on the item it stopped', async () => {
    const media = await video(1);
    let release;
    daemon.smoothVideo = (item, { signal }) => new Promise(resolve => {
      release = resolve;
      signal.addEventListener('abort', () => resolve(null));
    });
    smooth.want(media);
    // As the load shedding does: the level rises, then the job is paused
    daemon.load.level = 'images';
    smooth.pause();
    await settle();
    expect([...smooth.queue.keys()]).to.deep.equal([media.id]);
    expect(release).to.be.a('function');
  });

  it('deletes copies for another speed, of items gone or skipped, and stays out of the way when smoothing is off', async () => {
    const kept = await video(1);
    const respeeded = await video(2);
    const gone = await video(3);
    const dirSmooth = config.get().paths.smooth;
    for (const media of [kept, respeeded, gone]) await fs.outputFile(smoothedPath(media, dirSmooth), 'copy');
    await fs.outputFile(smoothedReversedPath(kept, dirSmooth), 'reversed of an item that does not bounce');
    db.updateMedia(respeeded.id, { speed: 0.75 });
    db.addRating(gone.id, 0);
    expect((await smooth.prune()).sort()).to.deep.equal([kept.id, respeeded.id, gone.id].sort());
    expect(await fs.readdir(dirSmooth)).to.deep.equal([`${kept.id}@0.5.mp4`]);
    expect(swapped).to.have.length(1);

    config.set('display.smooth', false);
    smooth.want(await video(9));
    expect(smooth.queue.size).to.equal(0);
    await smooth.prune();
    expect(await fs.readdir(dirSmooth)).to.deep.equal([]);
  });

  it('makes a new copy after a speed change, first in line', async () => {
    const other = await video(1);
    const media = await video(2);
    await fs.outputFile(smoothedPath(media, config.get().paths.smooth), 'copy for 0.5');
    smooth.want(other, { start: false });
    db.updateMedia(media.id, { speed: 0.75 });
    daemon.load.level = 'images';
    await smooth.changed(media.id);
    expect([...smooth.queue.keys()]).to.deep.equal([media.id, other.id]);
    expect(await fs.pathExists(smoothedPath(media, config.get().paths.smooth))).to.equal(false);
  });

  it('smooths again from the new path when a rating moved the file during the job', async () => {
    const media = await video(1);
    const moved = path.join(dir, 'library', '1.mp4');
    const paths = [];
    daemon.smoothVideo = async item => {
      paths.push(item.path);
      if (paths.length === 1) {
        await fs.move(media.path, moved);
        db.updateMedia(media.id, { path: moved });
        return null;
      }
      return null;
    };
    smooth.want(media);
    await settle();
    expect(paths).to.deep.equal([media.path, moved]);
    // The second failure, with the file where it is, is a real one
    expect([...smooth.failed]).to.deep.equal([media.id]);
  });

  it('marks an item failed when no copy could be made, and does not try it again', async () => {
    daemon.smoothVideo = sinon.stub().resolves(null);
    const media = await video(1);
    smooth.want(media);
    await settle();
    smooth.want(media);
    await settle();
    expect(daemon.smoothVideo.callCount).to.equal(1);
  });
});
