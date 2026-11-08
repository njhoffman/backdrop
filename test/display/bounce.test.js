import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { bounceState, bounces, bounceUrl, entryPath, forwardPath, isBounceUrl, isSmoothedUrl, playsBounce, playUrl } from '../../src/display/bounce.js';
import { mediaJson } from '../../src/utils/mediaView.js';
import { smoothedPath, smoothedReversedPath } from '../../src/library/smooth.js';
import { loadPlaylist, refreshEntries, syncPlaylist, queueMatching } from '../../src/display/Playlist.js';
import { reversedPath } from '../../src/library/reverse.js';
import { FakeMpvClient, makeConfig } from '../helpers/fakes.js';

const MONITOR = { name: 'DP-3', width: 1920, height: 1080, x: 0, y: 0 };

describe('bounce', () => {
  let dir, db, config;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-bounce-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'paths.bounce': path.join(dir, 'bounce'), 'display.video_loop': 'bounce' });
  });

  afterEach(async () => {
    db.close();
    await fs.remove(dir);
  });

  // A downloaded video whose file exists, optionally with a reversed copy made after it
  async function video(id, { reversed = false, kind = 'video' } = {}) {
    const file = path.join(dir, 'media', `${id}.mp4`);
    await fs.outputFile(file, 'video');
    const mediaId = db.addMedia({ kind, source: 'local', source_id: id, width: 1920, height: 1080, duration: 10, path: file });
    const media = db.getMedia(mediaId);
    if (reversed) await fs.outputFile(reversedPath(media, config.get().paths.bounce), 'reversed');
    return media;
  }

  describe('bounces', () => {
    it('follows display.video_loop unless the item sets its own, and never for images', () => {
      expect(bounces({ kind: 'video', bounce: null }, { video_loop: 'bounce' })).to.equal(true);
      expect(bounces({ kind: 'gif', bounce: null }, { video_loop: 'loop' })).to.equal(false);
      expect(bounces({ kind: 'video', bounce: true }, { video_loop: 'loop' })).to.equal(true);
      expect(bounces({ kind: 'video', bounce: false }, { video_loop: 'bounce' })).to.equal(false);
      expect(bounces({ kind: 'image', bounce: true }, { video_loop: 'bounce' })).to.equal(false);
      expect(bounces(null, { video_loop: 'bounce' })).to.equal(false);
    });
  });

  describe('URLs', () => {
    it('counts segment lengths in bytes and reads the library path back from the URL', () => {
      const forward = '/m/café;clip.mp4';
      const url = bounceUrl(forward, '/c/bounce/7.mp4');
      expect(url).to.equal(`edl://%${Buffer.byteLength(forward)}%${forward};%15%/c/bounce/7.mp4`);
      expect(isBounceUrl(url)).to.equal(true);
      expect(entryPath(url)).to.equal(forward);
    });

    it('leaves plain paths and missing names alone', () => {
      expect(entryPath('/m/1.mp4')).to.equal('/m/1.mp4');
      expect(entryPath(null)).to.equal(null);
      expect(isBounceUrl('/m/1.mp4')).to.equal(false);
    });

    it('plays the file until the reversed copy is ready and no older than it', async () => {
      const ready = await video(1, { reversed: true });
      const waiting = await video(2);
      expect(playUrl(ready, config.get())).to.equal(bounceUrl(ready.path, reversedPath(ready, config.get().paths.bounce)));
      expect(playUrl(waiting, config.get())).to.equal(waiting.path);

      // download --upgrade replaced the file after the copy was made
      const later = new Date(Date.now() + 60000);
      await fs.utimes(ready.path, later, later);
      expect(playUrl(ready, config.get())).to.equal(ready.path);
    });

    it('plays the file when the item does not bounce, whatever copy there is', async () => {
      const media = await video(1, { reversed: true });
      config.set('display.video_loop', 'loop');
      expect(playUrl(media, config.get())).to.equal(media.path);
      db.setBounce(media.id, true);
      expect(playUrl(db.getMedia(media.id), config.get())).to.not.equal(media.path);
    });
  });

  describe('bounce state', () => {
    it('is off, reversing until the copy is made, then ready, and shows in the item JSON given a config', async () => {
      const media = await video(1);
      expect(bounceState(media, config.get())).to.equal('reversing');
      expect(mediaJson(db, media, undefined, { config: config.get() }).bounce_state).to.equal('reversing');
      expect(mediaJson(db, media)).to.not.have.property('bounce_state');
      await fs.outputFile(reversedPath(media, config.get().paths.bounce), 'reversed');
      expect(bounceState(media, config.get())).to.equal('ready');
      config.set('display.video_loop', 'loop');
      expect(bounceState(media, config.get())).to.equal('off');
      expect(bounceState(null, config.get())).to.equal('off');
    });
  });

  describe('smoothed copies', () => {
    it('carries the library path as a tag when the first file is a copy, and reads it back', () => {
      const url = bounceUrl('/c/smooth/7@0.5.mp4', '/c/smooth/7@0.5.reversed.mp4', '/m/café.mp4');
      expect(url).to.equal(`edl://!global_tags,backdrop_path=%${Buffer.byteLength('/m/café.mp4')}%/m/café.mp4;%19%/c/smooth/7@0.5.mp4;%28%/c/smooth/7@0.5.reversed.mp4`);
      expect(entryPath(url)).to.equal('/m/café.mp4');
      expect(forwardPath(url)).to.equal('/c/smooth/7@0.5.mp4');
      expect(playsBounce(url)).to.equal(true);
      expect(isSmoothedUrl(url)).to.equal(true);
      const alone = bounceUrl('/c/smooth/7@0.5.mp4', null, '/m/v.mp4');
      expect(playsBounce(alone)).to.equal(false);
      expect(entryPath(alone)).to.equal('/m/v.mp4');
      // A plain bounce carries no tag
      const plain = bounceUrl('/m/v.mp4', '/c/bounce/7.mp4', '/m/v.mp4');
      expect(plain).to.not.include('global_tags');
      expect(isSmoothedUrl(plain)).to.equal(false);
      expect(playsBounce(plain)).to.equal(true);
    });

    it('plays the smoothed copy once it is ready, and bounces it once its reversed copy is', async () => {
      config.set('display.smooth', true);
      config.set('paths.smooth', path.join(dir, 'smooth'));
      const file = path.join(dir, 'media', '5.mp4');
      await fs.outputFile(file, 'video');
      const media = db.getMedia(db.addMedia({ kind: 'video', source: 'local', source_id: 5, path: file, duration: 10, fps: 30, speed: 0.5 }));
      const smooth = config.get().paths.smooth;
      await fs.outputFile(reversedPath(media, config.get().paths.bounce), 'reversed original');
      expect(playUrl(media, config.get())).to.equal(bounceUrl(file, reversedPath(media, config.get().paths.bounce)));
      await fs.outputFile(smoothedPath(media, smooth), 'smoothed');
      expect(playUrl(media, config.get())).to.equal(bounceUrl(smoothedPath(media, smooth), null, file));
      await fs.outputFile(smoothedReversedPath(media, smooth), 'reversed smoothed');
      expect(playUrl(media, config.get())).to.equal(bounceUrl(smoothedPath(media, smooth), smoothedReversedPath(media, smooth), file));
      // Another speed, or smoothing off: back to the plain bounce
      expect(playUrl({ ...media, speed: 0.75 }, config.get())).to.equal(bounceUrl(file, reversedPath(media, config.get().paths.bounce)));
      config.set('display.smooth', false);
      expect(playUrl(media, config.get())).to.equal(bounceUrl(file, reversedPath(media, config.get().paths.bounce)));
    });
  });

  describe('playlists', () => {
    it('loads ready items as bounce URLs', async () => {
      const ready = await video(1, { reversed: true });
      await video(2);
      const client = new FakeMpvClient();
      await loadPlaylist(client, { database: db, config: config.get(), mode: 'video', monitor: MONITOR, lastMediaId: ready.id });
      const loads = client.commands.filter(command => command[0] === 'loadfile').map(command => command[1]);
      expect(loads[0]).to.match(/^edl:\/\//);
      expect(entryPath(loads[0])).to.equal(ready.path);
      expect(loads[1]).to.equal(path.join(dir, 'media', '2.mp4'));
    });

    it('matches bounce entries by their library path when syncing and queueing', async () => {
      const ready = await video(1, { reversed: true });
      const other = await video(2);
      const url = playUrl(ready, config.get());
      const client = new FakeMpvClient({
        playlist: [{ id: 1, filename: other.path, current: true }, { id: 2, filename: url }]
      });
      const result = await syncPlaylist(client, { database: db, config: config.get(), mode: 'video', monitor: MONITOR });
      expect(result).to.include({ removed: 0, added: 0 });

      await queueMatching(client, new Set([ready.path]));
      expect(client.commands).to.deep.include(['playlist-move', 1, 1]);
    });

    it('swaps entries for their bounce URL in place, leaving the playing one for its next play', async () => {
      const playing = await video(1, { reversed: true });
      const ahead = await video(2, { reversed: true });
      const plain = await video(3);
      const client = new FakeMpvClient({
        playlist: [
          { id: 1, filename: playing.path, current: true, playing: true },
          { id: 2, filename: plain.path },
          { id: 3, filename: ahead.path }
        ]
      });
      const { swapped, held } = await refreshEntries(client, { database: db, config: config.get() });
      expect(swapped).to.equal(1);
      expect([...held]).to.deep.equal([playing.id]);
      expect(client.commands.slice(1)).to.deep.equal([
        ['loadfile', playUrl(ahead, config.get()), 'insert-at', 2],
        ['playlist-remove', 3]
      ]);
    });

    it('swaps a bounce entry back to the file once the item stops bouncing, only for the ids asked', async () => {
      const first = await video(1, { reversed: true });
      const second = await video(2, { reversed: true });
      const client = new FakeMpvClient({
        playlist: [
          { id: 1, filename: '/m/other', current: true },
          { id: 2, filename: playUrl(first, config.get()) },
          { id: 3, filename: playUrl(second, config.get()) }
        ]
      });
      db.setBounce(first.id, false);
      db.setBounce(second.id, false);
      const { swapped } = await refreshEntries(client, { database: db, config: config.get(), mediaIds: new Set([first.id]) });
      expect(swapped).to.equal(1);
      expect(client.commands.slice(1)).to.deep.equal([['loadfile', first.path, 'insert-at', 1], ['playlist-remove', 2]]);
    });
  });
});
