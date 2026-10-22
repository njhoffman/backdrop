import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import {
  MODES, getMode, setMode, otherMode, modeOfKind, lastMediaKey, eligibleMedia, shuffle, orderPlaylist,
  modeProperties, loadPlaylist, appendToPlaylist
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
    expect(modeProperties('video', 300)).to.deep.equal({ 'loop-file': 'inf' });
    expect(modeProperties('image', 60)).to.deep.equal({ 'loop-file': 'no', 'image-display-duration': 60 });
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
      expect(client.commands).to.deep.equal([['loadfile', '/m/1', 'append-play']]);
    });

    it('does nothing for an empty list', async () => {
      const client = new FakeMpvClient();
      add('video', 1);
      expect(await appendToPlaylist(client, { database: db, config, mode: 'video', monitor: MONITOR, mediaIds: [] })).to.equal(0);
      expect(client.commands).to.deep.equal([]);
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
});
