import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import {
  MODES, getMode, setMode, otherMode, modeOfKind, lastMediaKey, eligibleMedia, shuffle, orderPlaylist,
  modeProperties, loadPlaylist, appendToPlaylist, queueRandom, queueMatching, reshuffleOnWrap, randomOrder,
  playbackLimits, validVideoDuration
} from '../../src/display/Playlist.js';
import { FakeMpvClient, makeConfig } from '../helpers/fakes.js';

const MONITOR = { name: 'DP-3', width: 2304, height: 1296, x: 0, y: 0 };

// Deterministic "random" that always picks index 0, so shuffle reverses rotation predictably
const firstPick = () => 0;

describe('Playlist', () => {
  let db;

  beforeEach(() => {
    db = new DatabaseManager();
    db.initialize(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function add(kind, id, { width = 2560, height = 1440, downloaded = true } = {}) {
    return db.addMedia({ kind, source: 'local', source_id: id, width, height, path: downloaded ? `/m/${id}` : undefined });
  }

  describe('mode', () => {
    it('defaults to video and persists changes', () => {
      expect(getMode(db)).to.equal('video');
      setMode(db, 'image');
      expect(getMode(db)).to.equal('image');
    });

    it('rejects unknown modes and ignores corrupt stored values', () => {
      expect(() => setMode(db, 'slideshow')).to.throw('Unknown mode');
      db.setSetting('mode', 'slideshow');
      expect(getMode(db)).to.equal('video');
    });

    it('toggles and maps kinds to modes', () => {
      expect(MODES).to.deep.equal(['video', 'image']);
      expect(otherMode('video')).to.equal('image');
      expect(otherMode('image')).to.equal('video');
      expect(modeOfKind('gif')).to.equal('video');
      expect(modeOfKind('image')).to.equal('image');
    });

    it('keys the last item by mode and monitor', () => {
      expect(lastMediaKey('video', 'DP-3')).to.equal('last_media:video:DP-3');
    });
  });

  describe('eligibleMedia', () => {
    it('keeps modes separate, with GIFs in video mode', () => {
      const video = add('video', 1);
      const gif = add('gif', 2);
      const image = add('image', 3);

      expect(eligibleMedia(db, 'video', MONITOR).map(m => m.id)).to.deep.equal([video, gif]);
      expect(eligibleMedia(db, 'image', MONITOR).map(m => m.id)).to.deep.equal([image]);
    });

    it('excludes media smaller than the monitor in either dimension', () => {
      const big = add('video', 1);
      add('video', 2, { width: 1920, height: 1080 });
      add('video', 3, { width: 4000, height: 1080 });
      const exact = add('video', 4, { width: 2304, height: 1296 });

      expect(eligibleMedia(db, 'video', MONITOR).map(m => m.id)).to.deep.equal([big, exact]);
    });

    it('includes smaller media when upscaling is allowed', () => {
      add('video', 1, { width: 1280, height: 720 });
      expect(eligibleMedia(db, 'video', MONITOR, { allowUpscale: true })).to.have.length(1);
    });

    it('shows new and kept items but not skipped or undownloaded ones', () => {
      const fresh = add('video', 1);
      const kept = add('video', 2);
      const skipped = add('video', 3);
      add('video', 4, { downloaded: false });
      db.addRating(kept, 2);
      db.addRating(skipped, 0);

      expect(eligibleMedia(db, 'video', MONITOR).map(m => m.id)).to.deep.equal([fresh, kept]);
    });
  });

  describe('ordering', () => {
    it('shuffles without losing or duplicating items', () => {
      const items = [1, 2, 3, 4, 5];
      const shuffled = shuffle(items);
      expect([...shuffled].sort()).to.deep.equal(items);
      expect(items).to.deep.equal([1, 2, 3, 4, 5]);
    });

    it('puts the last played item first', () => {
      const media = [{ id: 1 }, { id: 2 }, { id: 3 }];
      expect(orderPlaylist(media, 2, firstPick)[0].id).to.equal(2);
      expect(orderPlaylist(media, 3, Math.random)[0].id).to.equal(3);
    });

    it('keeps the shuffle when the last item is missing or unset', () => {
      const media = [{ id: 1 }, { id: 2 }, { id: 3 }];
      expect(orderPlaylist(media, 99, firstPick)).to.deep.equal(shuffle(media, firstPick));
      expect(orderPlaylist(media, null, firstPick)).to.have.length(3);
    });
  });

  it('sets per-mode mpv properties', () => {
    expect(modeProperties('video', 300)).to.deep.equal({ 'loop-file': 'inf', end: 'none' });
    expect(modeProperties('image', 60)).to.deep.equal({ 'loop-file': 'no', end: 'none', 'image-display-duration': 60 });
  });

  describe('playbackLimits', () => {
    const video = (duration, speed = 1, kind = 'video') => ({ kind, duration, speed });

    it('loops short videos as many whole times as fit in the timeout', () => {
      expect(playbackLimits(video(18), 600)).to.deep.equal({ 'loop-file': 32, end: 'none' });
      expect(playbackLimits(video(2, 1, 'gif'), 10)).to.deep.equal({ 'loop-file': 4, end: 'none' });
      expect(playbackLimits(video(400), 600)).to.deep.equal({ 'loop-file': 'no', end: 'none' });
      expect(playbackLimits(video(600), 600)).to.deep.equal({ 'loop-file': 'no', end: 'none' });
    });

    it('asks only for the loops still due after the current one when the timeout changes mid-play', () => {
      // 18s clip, 50s into a new 120s limit: 4s left of this play, then 3 more fit in the remaining 66s
      expect(playbackLimits(video(18), 120, 50)).to.deep.equal({ 'loop-file': 3, end: 'none' });
      // Past the new limit already: this play is the last
      expect(playbackLimits(video(18), 60, 70)).to.deep.equal({ 'loop-file': 'no', end: 'none' });
      // A long video keeps its end in media time; mpv stops it at once when that has passed
      expect(playbackLimits(video(1800), 60, 300)).to.deep.equal({ 'loop-file': 'no', end: '60' });
    });

    it('counts playback speed, so a slowed video loops fewer times', () => {
      expect(playbackLimits(video(20, 0.5), 600)).to.deep.equal({ 'loop-file': 14, end: 'none' });
    });

    it('stops videos longer than the timeout at the timeout, in media time', () => {
      expect(playbackLimits(video(1800), 600)).to.deep.equal({ 'loop-file': 'no', end: '600' });
      expect(playbackLimits(video(1800, 0.5), 600)).to.deep.equal({ 'loop-file': 'no', end: '300' });
    });

    it('loops forever with no timeout or an unknown duration, and only clears end for images', () => {
      expect(playbackLimits(video(18), 0)).to.deep.equal({ 'loop-file': 'inf', end: 'none' });
      expect(playbackLimits(video(null), 600)).to.deep.equal({ 'loop-file': 'inf', end: 'none' });
      expect(playbackLimits({ kind: 'image', duration: null, speed: 1 }, 600)).to.deep.equal({ end: 'none' });
      expect(playbackLimits(null, 600)).to.deep.equal({ end: 'none' });
    });

    it('rejects a negative or non-numeric video_duration', () => {
      expect(validVideoDuration(0)).to.equal(0);
      expect(() => validVideoDuration(-1)).to.throw('display.video_duration');
      expect(() => validVideoDuration('10m')).to.throw('display.video_duration');
    });
  });

  describe('appendToPlaylist', () => {
    const config = makeConfig().get();

    it('appends only the given items that fit the mode and monitor', async () => {
      const client = new FakeMpvClient();
      const fits = add('video', 1);
      add('video', 2);
      const small = add('video', 3, { width: 640, height: 480 });
      const image = add('image', 4);

      const added = await appendToPlaylist(client, {
        database: db, config, mode: 'video', monitor: MONITOR, mediaIds: [fits, small, image]
      });

      expect(added).to.equal(1);
      expect(client.commands).to.deep.equal([['get_property', 'playlist'], ['loadfile', '/m/1', 'append-play']]);
    });

    it('does nothing for an empty list', async () => {
      const client = new FakeMpvClient();
      add('video', 1);
      expect(await appendToPlaylist(client, { database: db, config, mode: 'video', monitor: MONITOR, mediaIds: [] })).to.equal(0);
      expect(client.commands).to.deep.equal([]);
    });

    it('does not duplicate media already in the playlist when a rating changes', async () => {
      const client = new FakeMpvClient({ playlist: [{ filename: '/m/1' }] });
      const id = add('video', 1);
      expect(await appendToPlaylist(client, { database: db, config, mode: 'video', monitor: MONITOR, mediaIds: [id] })).to.equal(0);
      expect(client.commands.some(cmd => cmd[0] === 'loadfile')).to.be.false;
    });
  });

  describe('loadPlaylist', () => {
    let tempDir;
    let client;
    const config = makeConfig({ 'display.image_duration': 45 }).get();

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-playlist-'));
      client = new FakeMpvClient();
    });

    afterEach(async () => {
      await fs.remove(tempDir);
    });

    const load = mode => loadPlaylist(client, { database: db, config, mode, monitor: MONITOR, runtimeDir: tempDir });

    it('writes an m3u with the last item first and loads it', async () => {
      add('image', 1);
      const last = add('image', 2);
      db.setSetting(lastMediaKey('image', 'DP-3'), last);

      expect(await load('image')).to.equal(2);

      const playlistPath = path.join(tempDir, 'DP-3.m3u');
      const lines = (await fs.readFile(playlistPath, 'utf8')).trim().split('\n');
      expect(lines[0]).to.equal('/m/2');
      expect(lines).to.have.members(['/m/1', '/m/2']);
      expect(client.commands).to.deep.equal([
        ['set_property', 'loop-file', 'no'],
        ['set_property', 'end', 'none'],
        ['set_property', 'image-display-duration', 45],
        ['loadlist', playlistPath, 'replace']
      ]);
    });

    it('ignores the other mode\'s last item', async () => {
      add('video', 1);
      db.setSetting(lastMediaKey('image', 'DP-3'), 1);
      await load('video');
      expect(client.commands[0]).to.deep.equal(['set_property', 'loop-file', 'inf']);
    });

    it('clears and stops mpv when nothing is eligible', async () => {
      add('video', 1, { width: 640, height: 480 });

      expect(await load('video')).to.equal(0);
      expect(client.commands.slice(-2)).to.deep.equal([['playlist-clear'], ['stop']]);
      expect(await fs.pathExists(path.join(tempDir, 'DP-3.m3u'))).to.be.false;
    });
  });

  describe('random order', () => {
    it('uses --random or display.order and rejects unknown orders', () => {
      expect(randomOrder({ order: 'shuffle' })).to.be.false;
      expect(randomOrder({ order: 'shuffle' }, true)).to.be.true;
      expect(randomOrder({ order: 'random' })).to.be.true;
      expect(randomOrder({})).to.be.true;
      expect(randomOrder({ order: 'random' }, false)).to.be.false;
      expect(() => randomOrder({ order: 'sorted' })).to.throw('display.order must be shuffle or random, not sorted');
    });

    it('moves a picked entry right after the current one, skipping copies of the current file', async () => {
      const client = new FakeMpvClient({ playlist: [
        { filename: '/m/a' }, { filename: '/m/b', current: true }, { filename: '/m/b' }, { filename: '/m/c' }
      ] });

      expect(await queueRandom(client, () => 0)).to.deep.equal({ filename: '/m/a' });
      expect(await queueRandom(client, () => 0.99)).to.deep.equal({ filename: '/m/c' });
      expect(client.commands.filter(cmd => cmd[0] === 'playlist-move')).to.deep.equal([
        ['playlist-move', 0, 2], ['playlist-move', 3, 2]
      ]);
    });

    it('does nothing when every entry is the current file', async () => {
      const client = new FakeMpvClient({ playlist: [{ filename: '/m/a', current: true }, { filename: '/m/a' }] });
      expect(await queueRandom(client)).to.be.null;
      expect(client.commands.some(cmd => cmd[0] === 'playlist-move')).to.be.false;
    });
  });

  describe('queueMatching', () => {
    const playlist = () => [
      { filename: '/m/a' }, { filename: '/m/b' }, { filename: '/m/c', current: true }, { filename: '/m/d' }, { filename: '/m/e' }
    ];

    it('queues the first matching entry after the current one, wrapping to the start', async () => {
      const client = new FakeMpvClient({ playlist: playlist() });
      expect(await queueMatching(client, new Set(['/m/b', '/m/e']))).to.deep.equal({ filename: '/m/e' });
      expect(await queueMatching(client, new Set(['/m/a', '/m/b', '/m/c']))).to.deep.equal({ filename: '/m/a' });
      expect(client.commands.filter(cmd => cmd[0] === 'playlist-move')).to.deep.equal([
        ['playlist-move', 4, 3], ['playlist-move', 0, 3]
      ]);
    });

    it('picks any matching entry with random', async () => {
      const client = new FakeMpvClient({ playlist: playlist() });
      const paths = new Set(['/m/a', '/m/d']);
      expect(await queueMatching(client, paths, { random: true, rng: () => 0 })).to.deep.equal({ filename: '/m/a' });
      expect(await queueMatching(client, paths, { random: true, rng: () => 0.99 })).to.deep.equal({ filename: '/m/d' });
    });

    it('does nothing when only the playing file or no entry matches', async () => {
      const client = new FakeMpvClient({ playlist: playlist() });
      expect(await queueMatching(client, new Set(['/m/c']))).to.be.null;
      expect(await queueMatching(client, new Set(['/m/z']), { random: true })).to.be.null;
      expect(client.commands.some(cmd => cmd[0] === 'playlist-move')).to.be.false;
    });
  });

  describe('reshuffleOnWrap', () => {
    // Entries with mpv ids; current marks the one playing
    const entries = (ids, current) => ids.map(id => ({ id, filename: `/m/${id}`, ...(id === current ? { current: true } : {}) }));

    it('reshuffles when playback wraps from the last entry, keeping the playing one first', async () => {
      const client = new FakeMpvClient({ playlist: entries([5, 6, 7, 8], 5) });
      client.command = async function (...args) {
        if (args[0] === 'playlist-shuffle') this.properties.playlist = entries([7, 6, 5, 8], 5);
        return FakeMpvClient.prototype.command.apply(this, args);
      };

      expect(await reshuffleOnWrap(client, 8)).to.equal(5);
      expect(client.commands.filter(cmd => !cmd[0].startsWith('get_'))).to.deep.equal([
        ['playlist-shuffle'], ['playlist-move', 2, 0]
      ]);
    });

    it('leaves the order alone for other moves, first loads and short playlists', async () => {
      for (const [playlist, previous, playing] of [
        [entries([5, 6, 7, 8], 7), 6, 7],
        [entries([5, 6, 7, 8], 5), 6, 5],
        [entries([5, 6, 7, 8], 5), undefined, 5],
        [entries([5, 6], 5), 6, 5]
      ]) {
        const client = new FakeMpvClient({ playlist });
        expect(await reshuffleOnWrap(client, previous)).to.equal(playing);
        expect(client.commands.every(cmd => cmd[0] === 'get_property')).to.be.true;
      }
    });

    it('is not fooled by positions that shifted since the last load', async () => {
      // The previous item was at the last position when it loaded, but an append moved it to the middle:
      // the first entry playing next is an ordinary advance after a jump, not a wrap
      const client = new FakeMpvClient({ playlist: entries([5, 6, 7, 8, 9], 5) });
      expect(await reshuffleOnWrap(client, 8)).to.equal(5);
      expect(client.commands.every(cmd => cmd[0] === 'get_property')).to.be.true;
      // A removal before the playing entry shifts it to the front without a wrap either
      const removed = new FakeMpvClient({ playlist: entries([6, 7, 8], 6) });
      expect(await reshuffleOnWrap(removed, 5)).to.equal(6);
      expect(removed.commands.every(cmd => cmd[0] === 'get_property')).to.be.true;
    });
  });
});
