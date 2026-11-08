import { expect } from 'chai';
import sinon from 'sinon';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Bounce } from '../../src/display/daemon/Bounce.js';
import { bounceUrl, playUrl } from '../../src/display/bounce.js';
import { FakeMpvClient, makeConfig, silentLogger } from '../helpers/fakes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Bounce (daemon)', () => {
  let dir, db, config, daemon, encodes, bounce;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-bounceq-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'paths.bounce': path.join(dir, 'bounce'), 'display.video_loop': 'bounce' });
    encodes = [];
    // Each encode waits for the test: finish(true) writes the copy, finish(false) fails it
    daemon = {
      config, database: db, logger: silentLogger, stopping: false, screens: new Map(), load: { level: 'normal' },
      now: () => Date.now(), videoDuration: () => 600,
      enqueue: task => task(),
      reverse: (media, { signal }) => new Promise(resolve => {
        encodes.push({
          media, signal,
          finish: async ok => {
            if (ok) await fs.outputFile(path.join(dir, 'bounce', `${media.id}.mp4`), 'reversed');
            resolve(ok ? path.join(dir, 'bounce', `${media.id}.mp4`) : null);
          }
        });
        signal.addEventListener('abort', () => resolve(null));
      })
    };
    bounce = new Bounce(daemon);
  });

  afterEach(async () => {
    await bounce.stop();
    db.close();
    await fs.remove(dir);
  });

  async function video(id) {
    const file = path.join(dir, 'media', `${id}.mp4`);
    await fs.outputFile(file, 'video');
    return db.getMedia(db.addMedia({ kind: 'video', source: 'local', source_id: id, duration: 10, path: file }));
  }

  // Videos 1 to count, made one after another so their ids follow
  async function videos(count) {
    const made = [];
    for (let id = 1; id <= count; id++) made.push(await video(id));
    return made;
  }

  // Waits for the background encodes to reach count; the swap and prune before the next encode do real file
  // work, so this waits on time rather than a number of ticks
  async function encodesReach(count) {
    const deadline = Date.now() + 2000;
    while (encodes.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  }

  function screen(playlist) {
    const value = { monitor: { name: 'DP-3' }, client: new FakeMpvClient({ playlist }) };
    daemon.screens.set('DP-3', value);
    return value;
  }

  it('reverses the loaded item, then the next entry, one at a time', async () => {
    const playing = await video(1);
    const next = await video(2);
    const shown = screen([{ id: 1, filename: playing.path, current: true }, { id: 2, filename: next.path }]);

    await bounce.onLoaded(shown, playing);
    expect(encodes.map(encode => encode.media.id)).to.deep.equal([1]);
    await encodes[0].finish(true);
    await encodesReach(2);
    expect(encodes.map(encode => encode.media.id)).to.deep.equal([1, 2]);
    // The playing entry waits for its next play
    expect([...bounce.pending]).to.deep.equal([1]);
  });

  it('does not queue an item again while it is being reversed', async () => {
    const media = await video(1);
    bounce.want(media);
    bounce.want(media);
    await encodes[0].finish(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(encodes).to.have.length(1);
  });

  it('swaps the next entry for its bounce URL when its copy is ready', async () => {
    const playing = await video(1);
    const next = await video(2);
    const shown = screen([{ id: 1, filename: playing.path, current: true }, { id: 2, filename: next.path }]);
    bounce.want(next);
    await encodes[0].finish(true);
    await tick();
    expect(shown.client.commands).to.deep.include(['loadfile', playUrl(next, config.get()), 'insert-at', 1]);
    expect(bounce.pending.size).to.equal(0);
  });

  it('waits while the load is up and starts again from the item it stopped', async () => {
    const media = await video(1);
    bounce.want(media);
    daemon.load.level = 'images';
    bounce.pause();
    await tick();
    await tick();
    expect(encodes[0].signal.aborted).to.equal(true);
    expect([...bounce.queue.keys()]).to.deep.equal([1]);

    daemon.load.level = 'normal';
    bounce.kick();
    expect(encodes).to.have.length(2);
  });

  it('leaves items that failed, or need nothing, out of the queue', async () => {
    const media = await video(1);
    bounce.want(media);
    await encodes[0].finish(false);
    await tick();
    bounce.want(media);
    expect(encodes).to.have.length(1);

    // Turned on again by hand: tried once more
    db.setBounce(media.id, true);
    await bounce.changed(media.id);
    expect(encodes).to.have.length(2);

    const image = db.getMedia(db.addMedia({ kind: 'image', source: 'local', source_id: 9, path: '/m/i.png' }));
    bounce.want(image);
    expect(encodes).to.have.length(2);
  });

  it('reverses again from the new path when a rating moved the file during the encode', async () => {
    const media = await video(1);
    bounce.want(media);
    const moved = path.join(dir, 'library', '1.mp4');
    await fs.move(media.path, moved);
    db.updateMedia(media.id, { path: moved });
    await encodes[0].finish(false);
    await encodesReach(2);
    expect(encodes.map(encode => encode.media.path)).to.deep.equal([media.path, moved]);
    expect(bounce.failed.size).to.equal(0);
  });

  it('looks ahead only when something can bounce', async () => {
    config.set('display.video_loop', 'loop');
    const media = await video(1);
    const shown = screen([{ id: 1, filename: media.path, current: true }]);
    await bounce.onLoaded(shown, media);
    expect(shown.client.commands).to.deep.equal([]);
    expect(encodes).to.have.length(0);

    db.setBounce(media.id, true);
    await bounce.onLoaded(shown, db.getMedia(media.id));
    expect(encodes).to.have.length(1);
  });

  describe('cache limit', () => {
    const MB = 1024 ** 2;

    // A finished copy of size bytes, last played age seconds ago
    async function copy(media, size, age) {
      const file = path.join(dir, 'bounce', `${media.id}.mp4`);
      await fs.outputFile(file, Buffer.alloc(size));
      const when = new Date(Date.now() - age * 1000);
      await fs.utimes(file, when, when);
      return file;
    }
    const left = async () => (await fs.readdir(path.join(dir, 'bounce'))).sort();

    it('deletes the lowest-rated copies first, newest first among equals, never the one playing or just made', async () => {
      config.set('display.bounce_cache_gb', 4 / 1024);
      const [old, newer, playing, newest, rated, made] = await videos(6);
      await copy(old, MB, 900);
      await copy(newer, MB, 300);
      await copy(playing, MB, 100);
      await copy(newest, MB, 50);
      await copy(rated, MB, 10);
      await copy(made, MB, 1);
      db.addRating(rated.id, 3);
      daemon.screens.set('DP-3', { monitor: { name: 'DP-3' }, media: playing, client: null });

      // Six copies with room for four: the newest unrated go first; the oldest unrated, the rated one, the one
      // playing and the one just made stay
      expect(await bounce.prune(new Set([made.id]))).to.deep.equal([newest.id, newer.id]);
      expect(await left()).to.deep.equal(['1.mp4', '3.mp4', '5.mp4', '6.mp4']);
      // 0 is no limit
      config.set('display.bounce_cache_gb', 0);
      expect(await bounce.prune()).to.deep.equal([]);
    });

    it('deletes copies of items gone, skipped or no longer bouncing, and swaps their entries back', async () => {
      const [off, skipped, kept] = await videos(3);
      await copy(off, MB, 10);
      await copy(skipped, MB, 10);
      await copy(kept, MB, 10);
      await fs.outputFile(path.join(dir, 'bounce', '99.mp4'), 'no such item');
      // The copies are dated before their videos, so the URL is built rather than asked of playUrl
      const url = bounceUrl(off.path, path.join(dir, 'bounce', '1.mp4'));
      const shown = screen([{ id: 1, filename: '/m/other', current: true }, { id: 2, filename: url }]);
      db.setBounce(off.id, false);
      db.addRating(skipped.id, 0);

      expect((await bounce.prune()).sort()).to.deep.equal([1, 2, 99]);
      expect(await left()).to.deep.equal(['3.mp4']);
      expect(shown.client.commands).to.deep.include(['loadfile', off.path, 'insert-at', 1]);
    });

    it('counts each encode for doctor', async () => {
      const media = await video(1);
      bounce.want(media);
      await encodes[0].finish(true);
      await encodesReach(1);
      for (let i = 0; i < 50 && !db.getSetting('bounce_encodes'); i++) await tick();
      const days = db.getSetting('bounce_encodes');
      expect(Object.values(days)[0].count).to.equal(1);
    });
  });

  describe('switching at the end of a pass', () => {
    let clock, shown, media, url;

    beforeEach(async () => {
      clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout'] });
      media = await video(1);
      await fs.outputFile(path.join(dir, 'bounce', '1.mp4'), 'reversed');
      url = playUrl(media, config.get());
      shown = screen([{ id: 1, filename: media.path, current: true, playing: true }, { id: 2, filename: '/m/next.mp4' }]);
      shown.media = media;
      shown.loadedAt = Date.now() - 4000;
      shown.client.properties['time-pos'] = 4;
    });

    afterEach(() => clock.restore());

    it('swaps the playing entry for its bounce where it would loop, carrying its play time', async () => {
      await bounce.swap(new Set([1]));
      expect(bounce.switches.get(shown).mediaId).to.equal(1);
      // 6 s left of a 10 s video at speed 1
      shown.client.properties['time-pos'] = 9.95;
      await clock.tickAsync(5900);
      expect(shown.client.commands.slice(-3)).to.deep.equal([
        ['loadfile', url, 'insert-next'], ['playlist-next', 'force'], ['playlist-remove', 0]
      ]);
      expect(bounce.carried(shown, media)).to.equal(shown.loadedAt);
      expect(bounce.carried(shown, media)).to.equal(null);
    });

    it('waits for the next play when the video duration leaves no room for a whole bounce', async () => {
      daemon.videoDuration = () => 20;
      await bounce.swap(new Set([1]));
      expect(bounce.switches.size).to.equal(0);
      expect([...bounce.pending]).to.deep.equal([1]);
    });

    it('plans again when the end moved, and drops the plan when another item loads', async () => {
      await bounce.swap(new Set([1]));
      // Slowed down: still 3 s from the end when the timer fires
      shown.client.properties['time-pos'] = 7;
      await clock.tickAsync(5900);
      expect(shown.client.commands.some(command => command[0] === 'loadfile')).to.equal(false);
      expect(bounce.switches.get(shown).mediaId).to.equal(1);
      // next: the other entry plays
      shown.client.properties.playlist = [{ id: 1, filename: media.path }, { id: 2, filename: '/m/next.mp4', current: true, playing: true }];
      shown.media = null;
      await bounce.onLoaded(shown, null);
      expect(bounce.switches.size).to.equal(0);
    });
  });

  it('removes work an earlier daemon left on start', async () => {
    await fs.outputFile(path.join(dir, 'bounce', '3.99.tmp', 'c00000.mp4'), 'chunk');
    await bounce.begin();
    expect(await fs.readdir(path.join(dir, 'bounce'))).to.deep.equal([]);
  });
});
