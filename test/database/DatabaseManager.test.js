import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager, SCHEMA_VERSION, orientationOf } from '../../src/database/DatabaseManager.js';

function video(overrides = {}) {
  return {
    kind: 'video',
    source: 'pexels',
    source_id: 123,
    width: 3840,
    height: 2160,
    duration: 30,
    ...overrides
  };
}

describe('DatabaseManager', () => {
  let db;

  beforeEach(() => {
    db = new DatabaseManager();
    db.initialize(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('initialization', () => {
    it('creates the schema and records its version', () => {
      const tables = db.db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `).all().map(t => t.name);

      expect(tables).to.include.members([
        'media', 'ratings', 'searches', 'search_results', 'sequences', 'settings', 'imported_files'
      ]);
      expect(db.db.prepare('PRAGMA user_version').get().user_version).to.equal(SCHEMA_VERSION);
    });

    it('enables foreign keys', () => {
      expect(db.db.prepare('PRAGMA foreign_keys').get().foreign_keys).to.equal(1);
    });

    describe('on disk', () => {
      let tempDir;

      beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backdrop-db-test-'));
      });

      afterEach(async () => {
        await fs.remove(tempDir);
      });

      it('creates missing parent directories and reopens an existing database', () => {
        const dbPath = path.join(tempDir, 'nested', 'backdrop.db');
        const first = new DatabaseManager();
        first.initialize(dbPath);
        first.addMedia(video());
        first.close();

        const second = new DatabaseManager();
        second.initialize(dbPath);
        expect(second.getMediaBySource('pexels', 123)).to.not.be.null;
        second.close();
      });

      it('upgrades a version 1 database in place, keeping its data', () => {
        const dbPath = path.join(tempDir, 'backdrop.db');
        const first = new DatabaseManager();
        first.initialize(dbPath);
        first.addMedia(video());
        first.db.exec('DROP TABLE settings');
        first.db.exec('DROP TABLE imported_files');
        first.db.exec('ALTER TABLE ratings DROP COLUMN previous_path');
        first.db.exec('ALTER TABLE ratings DROP COLUMN rated_path');
        first.db.exec('ALTER TABLE media DROP COLUMN dim');
        first.db.exec('ALTER TABLE media DROP COLUMN duplicate_of');
        first.db.exec('ALTER TABLE media DROP COLUMN fps'); first.db.exec('DROP TABLE media_tags');
        first.db.exec('DROP TABLE playback_stats'); first.db.exec('PRAGMA user_version = 1');
        first.close();

        const second = new DatabaseManager();
        second.initialize(dbPath);
        expect(second.db.prepare('PRAGMA user_version').get().user_version).to.equal(SCHEMA_VERSION);
        expect(second.getMediaBySource('pexels', 123)).to.not.be.null;
        second.setSetting('mode', 'image');
        expect(second.getSetting('mode')).to.equal('image');
        second.close();
      });

      it('upgrades v4 media with an undimmed default and validates dim', () => {
        const dbPath = path.join(tempDir, 'v4.db');
        const first = new DatabaseManager(); first.initialize(dbPath);
        const id = first.addMedia(video());
        first.db.exec('ALTER TABLE media DROP COLUMN dim');
        first.db.exec('ALTER TABLE media DROP COLUMN duplicate_of');
        first.db.exec('ALTER TABLE media DROP COLUMN fps'); first.db.exec('DROP TABLE media_tags');
        first.db.exec('DROP TABLE playback_stats'); first.db.exec('PRAGMA user_version = 4'); first.close();
        const second = new DatabaseManager(); second.initialize(dbPath);
        expect(second.getMedia(id).dim).to.equal(0);
        second.setDim(id, 40);
        expect(second.getMedia(id).dim).to.equal(40);
        for (const bad of [-1, 101, 2.5, '10']) expect(() => second.setDim(id, bad)).to.throw('Dim');
        second.close();
      });

      it('upgrades v6 media with frame rates and tags derived from names, pages and descriptions', () => {
        const dbPath = path.join(tempDir, 'v6.db');
        const first = new DatabaseManager(); first.initialize(dbPath);
        const remote = first.addMedia(video({ page_url: 'https://www.pexels.com/video/aerial-view-of-ocean-waves-1234/',
          tags: ['Waves crashing on rocks'], original_name: 'remote-1.mp4' }));
        const local = first.addMedia({ kind: 'image', source: 'local', source_id: 1, original_name: 'MistyForest_4k-2160p.JPG' });
        first.db.exec('ALTER TABLE media DROP COLUMN fps'); first.db.exec('DROP TABLE media_tags');
        first.db.exec('DROP TABLE playback_stats'); first.db.exec('PRAGMA user_version = 6'); first.close();
        const second = new DatabaseManager(); second.initialize(dbPath);
        expect(second.getMedia(remote).fps).to.be.null;
        expect(second.getTags(remote)).to.deep.equal(['aerial', 'ocean', 'waves', 'crashing', 'rocks']);
        expect(second.getTags(local)).to.deep.equal(['misty', 'forest']);
        expect(second.findMedia({ tags: ['Ocean', 'rocks'] }).map(m => m.id)).to.deep.equal([remote]);
        second.close();
      });

      it('refuses a database from a newer schema version', () => {
        const dbPath = path.join(tempDir, 'backdrop.db');
        const first = new DatabaseManager();
        first.initialize(dbPath);
        first.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        first.close();

        expect(() => new DatabaseManager().initialize(dbPath)).to.throw(/newer than this version/);
      });

      it('upgrades v3 ratings without losing history and stores reversible path changes', () => {
        const dbPath = path.join(tempDir, 'v3.db');
        const first = new DatabaseManager(); first.initialize(dbPath);
        const id = first.addMedia(video()); first.addRating(id, 2, '1920x1080');
        first.db.exec('ALTER TABLE ratings DROP COLUMN previous_path');
        first.db.exec('ALTER TABLE ratings DROP COLUMN rated_path');
        first.db.exec('ALTER TABLE media DROP COLUMN dim');
        first.db.exec('ALTER TABLE media DROP COLUMN duplicate_of');
        first.db.exec('ALTER TABLE media DROP COLUMN fps'); first.db.exec('DROP TABLE media_tags');
        first.db.exec('DROP TABLE playback_stats'); first.db.exec('PRAGMA user_version = 3'); first.close();
        const second = new DatabaseManager(); second.initialize(dbPath);
        expect(second.getLatestRating(id)).to.include({ rating: 2, previous_path: null, rated_path: null });
        second.addRating(id, 0, '1920x1080', { previousPath: '/media/a.mp4', ratedPath: '/trash/a.mp4' });
        expect(second.getLastRating()).to.include({ previous_path: '/media/a.mp4', rated_path: '/trash/a.mp4' });
        expect(second.undoLastRating().media.status).to.equal('kept');
        second.close();
      });
    });
  });

  describe('playback stats', () => {
    it('adds sampled intervals, keeps the last decoder and groups cost by kind, size and decoder', () => {
      const big = db.addMedia({ kind: 'video', source: 'local', source_id: 1, width: 3840, height: 2160 });
      const small = db.addMedia({ kind: 'video', source: 'local', source_id: 2, width: 1920, height: 1080 });
      db.setDecoder(big, 'no');
      db.addPlaybackSample(big, 60, 120);
      db.addPlaybackSample(big, 90, 240);
      db.addPlaybackSample(small, 200, 20);
      db.setDecoder(small, 'vaapi');
      expect(db.getPlaybackStats(big)).to.include({ seconds: 150, cpu_seconds: 360, hwdec: 'no' });

      const cost = db.getPlaybackCost({ minSeconds: 100 });
      expect(cost.groups.map(row => [row.bucket, row.decoder, row.cpu_seconds / row.seconds]))
        .to.deep.equal([['4K', 'software', 2.4], ['1080p', 'hardware', 0.1]]);
      expect(cost.expensive.map(media => media.id)).to.deep.equal([big, small]);
      expect(cost.software).to.equal(1);
      db.deleteMedia(big);
      expect(db.getPlaybackStats(big)).to.be.null;
    });
  });

  describe('tags and frame rate', () => {
    it('derives tags on insert and rebuilds them when the name, page or description changes', () => {
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, original_name: 'red-fox.mp4' });
      expect(db.getTags(id)).to.deep.equal(['red', 'fox']);
      db.updateMedia(id, { original_name: 'grey_wolf.mp4' });
      expect(db.getTags(id)).to.deep.equal(['grey', 'wolf']);
      db.updateMedia(id, { speed: 0.5 });
      expect(db.getTags(id)).to.deep.equal(['grey', 'wolf']);
    });

    it('filters by every given tag and matches tags in keyword searches', () => {
      const fox = db.addMedia({ kind: 'video', source: 'local', source_id: 1, original_name: 'red fox.mp4' });
      db.addMedia({ kind: 'video', source: 'local', source_id: 2, original_name: 'red sunset.mp4' });
      expect(db.findMedia({ tags: ['red', 'fox'] }).map(m => m.id)).to.deep.equal([fox]);
      expect(db.findMedia({ tags: ['red'] })).to.have.length(2);
      expect(db.findMedia({ keywords: ['fox'] }).map(m => m.id)).to.deep.equal([fox]);
    });

    it('stores a frame rate and drops tags with the item', () => {
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, original_name: 'rain.mp4', fps: 29.97 });
      expect(db.getMedia(id).fps).to.equal(29.97);
      db.deleteMedia(id);
      expect(db.getTags(id)).to.deep.equal([]);
    });
  });

  describe('media', () => {
    it('adds media and returns its id', () => {
      const id = db.addMedia(video({ tags: ['ocean'], variants: [{ url: 'u', width: 1920, height: 1080 }] }));
      const media = db.getMedia(id);

      expect(media.kind).to.equal('video');
      expect(media.source_id).to.equal('123');
      expect(media.status).to.equal('new');
      expect(media.speed).to.equal(1);
      expect(media.tags).to.deep.equal(['ocean']);
      expect(media.variants).to.deep.equal([{ url: 'u', width: 1920, height: 1080 }]);
    });

    it('defaults JSON fields to empty arrays', () => {
      const media = db.getMedia(db.addMedia(video()));
      expect(media.tags).to.deep.equal([]);
      expect(media.variants).to.deep.equal([]);
    });

    it('rejects invalid kinds and missing source fields', () => {
      expect(() => db.addMedia(video({ kind: 'audio' }))).to.throw('Invalid media kind');
      expect(() => db.addMedia(video({ source: undefined }))).to.throw('requires source');
      expect(() => db.addMedia(video({ source_id: null }))).to.throw('requires source');
    });

    it('enforces one row per source item', () => {
      db.addMedia(video());
      expect(() => db.addMedia(video())).to.throw(/UNIQUE/);
    });

    it('enforces unique paths and hashes', () => {
      db.addMedia(video({ source_id: 1, path: '/m/a.mp4', sha256: 'h1' }));
      expect(() => db.addMedia(video({ source_id: 2, path: '/m/a.mp4' }))).to.throw(/UNIQUE/);
      expect(() => db.addMedia(video({ source_id: 3, sha256: 'h1' }))).to.throw(/UNIQUE/);
    });

    it('looks media up by source, path and hash', () => {
      const id = db.addMedia(video({ path: '/m/a.mp4', sha256: 'abc' }));

      expect(db.getMediaBySource('pexels', '123').id).to.equal(id);
      expect(db.getMediaByPath('/m/a.mp4').id).to.equal(id);
      expect(db.getMediaBySha256('abc').id).to.equal(id);
      expect(db.getMedia(999)).to.be.null;
      expect(db.getMediaByPath('/nope')).to.be.null;
    });

    it('upserts source metadata without touching local state', () => {
      const id = db.addMedia(video({ path: '/m/a.mp4', speed: 0.5 }));
      db.addRating(id, 2);

      const again = db.upsertMedia(video({ width: 7680, height: 4320, tags: ['new'], path: '/other.mp4', speed: 3 }));
      const media = db.getMedia(again);

      expect(again).to.equal(id);
      expect(media.width).to.equal(3840);
      expect(media.tags).to.deep.equal(['new']);
      expect(media.path).to.equal('/m/a.mp4');
      expect(media.speed).to.equal(0.5);
      expect(media.status).to.equal('kept');
    });

    it('refreshes dimensions from source metadata before download', () => {
      const id = db.addMedia(video());
      db.upsertMedia(video({ width: 7680, height: 4320 }));
      expect(db.getMedia(id)).to.include({ width: 7680, height: 4320 });
    });

    it('upserts new items by inserting them', () => {
      const id = db.upsertMedia(video({ source_id: 'fresh' }));
      expect(db.getMedia(id).source_id).to.equal('fresh');
    });

    it('updates allowed fields and rejects managed ones', () => {
      const id = db.addMedia(video());
      db.updateMedia(id, { path: '/m/b.mp4', sha256: 'x' });

      expect(db.getMedia(id).path).to.equal('/m/b.mp4');
      expect(() => db.updateMedia(id, { status: 'kept' })).to.throw('Cannot update media fields: status');
      expect(() => db.updateMedia(id, { id: 5 })).to.throw('Cannot update');
    });

    it('deletes media together with its ratings and search results', () => {
      const id = db.addMedia(video());
      db.addRating(id, 1);
      db.addSearchResult(db.addSearch('pexels', 'ocean'), id, 1);

      db.deleteMedia(id);

      expect(db.getMedia(id)).to.be.null;
      expect(db.db.prepare('SELECT COUNT(*) AS c FROM ratings').get().c).to.equal(0);
      expect(db.db.prepare('SELECT COUNT(*) AS c FROM search_results').get().c).to.equal(0);
    });
  });

  describe('speed', () => {
    it('stores one speed per media item', () => {
      const id = db.addMedia(video());
      db.setSpeed(id, 0.75);
      expect(db.getMedia(id).speed).to.equal(0.75);
    });

    it('rejects speeds outside the mpv range or non-numbers', () => {
      const id = db.addMedia(video());
      for (const bad of [0, -1, 0.001, 101, NaN, Infinity, '1.5']) {
        expect(() => db.setSpeed(id, bad), String(bad)).to.throw('Speed must be');
      }
      expect(() => db.addMedia(video({ source_id: 9, speed: 0 }))).to.throw('Speed must be');
    });
  });

  describe('sequences', () => {
    it('counts up per name starting at 1', () => {
      expect(db.nextSequence('local')).to.equal(1);
      expect(db.nextSequence('local')).to.equal(2);
      expect(db.nextSequence('other')).to.equal(1);
    });

    it('never reuses a value after the media using it is deleted', () => {
      const n = db.nextSequence('local');
      const id = db.addMedia(video({ source: 'local', source_id: n }));
      db.deleteMedia(id);

      expect(db.nextSequence('local')).to.equal(n + 1);
    });
  });

  describe('ratings', () => {
    let id;

    beforeEach(() => {
      id = db.addMedia(video());
    });

    it('keeps an item on ratings 1-3 and skips it on 0', () => {
      db.addRating(id, 3);
      expect(db.getMedia(id).status).to.equal('kept');

      db.addRating(id, 0);
      expect(db.getMedia(id).status).to.equal('skipped');
    });

    it('records orientation from the monitor resolution', () => {
      db.addRating(id, 2, '1080x1920');
      expect(db.getLatestRating(id)).to.include({ orientation: 'portrait', resolution: '1080x1920' });

      db.addRating(id, 2, '1920x1080');
      expect(db.getLatestRating(id).orientation).to.equal('landscape');
    });

    it('validates the rating and media', () => {
      for (const bad of [-1, 4, 1.5, '2']) {
        expect(() => db.addRating(id, bad), String(bad)).to.throw('Rating must be');
      }
      expect(() => db.addRating(999, 1)).to.throw('Media 999 not found');
    });

    it('undo removes the latest rating and restores the previous status', () => {
      db.addRating(id, 2);
      db.addRating(id, 0);

      const undone = db.undoLastRating();

      expect(undone.rating.rating).to.equal(0);
      expect(undone.media.status).to.equal('kept');
      expect(db.getLatestRating(id).rating).to.equal(2);
    });

    it('undo of the only rating returns the item to new', () => {
      db.addRating(id, 1);
      expect(db.undoLastRating().media.status).to.equal('new');
      expect(db.getLatestRating(id)).to.be.null;
    });

    it('undo applies to the most recent rating across all media', () => {
      const other = db.addMedia(video({ source_id: 456 }));
      db.addRating(id, 1);
      db.addRating(other, 0);

      expect(db.undoLastRating().media.id).to.equal(other);
      expect(db.getMedia(id).status).to.equal('kept');
    });

    it('undo with no ratings returns null', () => {
      expect(db.undoLastRating()).to.be.null;
    });
  });

  describe('findMedia', () => {
    let fourK;
    let hd;
    let image;

    beforeEach(() => {
      fourK = db.addMedia(video({ source_id: 1, width: 3840, height: 2160, path: '/m/1.mp4' }));
      hd = db.addMedia(video({ source_id: 2, width: 1920, height: 1080 }));
      image = db.addMedia({ kind: 'image', source: 'local', source_id: 1, width: 2560, height: 1440, path: '/m/1.jpg' });
    });

    const ids = rows => rows.map(row => row.id);

    it('returns everything without filters', () => {
      expect(ids(db.findMedia())).to.deep.equal([fourK, hd, image]);
    });

    it('filters by kind, source and status (single value or list)', () => {
      db.addRating(hd, 0);

      expect(ids(db.findMedia({ kind: 'image' }))).to.deep.equal([image]);
      expect(ids(db.findMedia({ source: 'pexels' }))).to.deep.equal([fourK, hd]);
      expect(ids(db.findMedia({ status: ['new', 'kept'] }))).to.deep.equal([fourK, image]);
    });

    it('applies a resolution floor so nothing is upscaled', () => {
      expect(ids(db.findMedia({ minWidth: 2560, minHeight: 1440 }))).to.deep.equal([fourK, image]);
      expect(ids(db.findMedia({ minWidth: 3000 }))).to.deep.equal([fourK]);
    });

    it('excludes media with unknown dimensions from a resolution floor', () => {
      const unknown = db.addMedia(video({ source_id: 3, width: undefined, height: undefined }));
      expect(ids(db.findMedia({ minWidth: 1 }))).to.not.include(unknown);
    });

    it('filters by downloaded state', () => {
      expect(ids(db.findMedia({ downloaded: true }))).to.deep.equal([fourK, image]);
      expect(ids(db.findMedia({ downloaded: false }))).to.deep.equal([hd]);
    });

    it('filters by the latest rating and its orientation', () => {
      db.addRating(fourK, 3, '1920x1080');
      db.addRating(hd, 3, '1080x1920');
      db.addRating(hd, 1, '1920x1080');

      expect(ids(db.findMedia({ minRating: 2 }))).to.deep.equal([fourK]);
      expect(ids(db.findMedia({ minRating: 1 }))).to.deep.equal([fourK, hd]);
      expect(ids(db.findMedia({ orientation: 'portrait' }))).to.deep.equal([]);
      expect(ids(db.findMedia({ orientation: 'landscape', minRating: 1 }))).to.deep.equal([fourK, hd]);
    });

    it('limits results', () => {
      expect(ids(db.findMedia({ limit: 2 }))).to.deep.equal([fourK, hd]);
    });
  });

  describe('trash expiry', () => {
    it('returns skipped items with a file older than the retention period', () => {
      const old = db.addMedia(video({ source_id: 1, path: '/trash/1.mp4' }));
      const recent = db.addMedia(video({ source_id: 2, path: '/trash/2.mp4' }));
      const kept = db.addMedia(video({ source_id: 3, path: '/media/3.mp4' }));
      const purged = db.addMedia(video({ source_id: 4 }));
      for (const id of [old, recent, purged]) db.addRating(id, 0);
      db.addRating(kept, 2);
      db.db.prepare(`UPDATE media SET status_changed_at = datetime('now', '-31 days') WHERE id IN (?, ?, ?)`).run(old, kept, purged);

      expect(db.getExpiredTrash(30).map(m => m.id)).to.deep.equal([old]);
      expect(db.getExpiredTrash(0).map(m => m.id)).to.deep.equal([old, recent]);
    });
  });

  describe('searches', () => {
    it('records searches and ranked results', () => {
      const a = db.addMedia(video({ source_id: 1 }));
      const b = db.addMedia(video({ source_id: 2 }));
      const searchId = db.addSearch('pexels', 'ocean', { per_page: 80 });

      db.addSearchResult(searchId, b, 1);
      db.addSearchResult(searchId, a, 2);

      const results = db.getSearchResults(searchId);
      expect(results.map(r => [r.id, r.rank])).to.deep.equal([[b, 1], [a, 2]]);
      expect(JSON.parse(db.db.prepare('SELECT params FROM searches WHERE id = ?').get(searchId).params))
        .to.deep.equal({ per_page: 80 });
    });

    it('updates the rank when the same result is recorded twice', () => {
      const a = db.addMedia(video());
      const searchId = db.addSearch('pexels', 'ocean');
      db.addSearchResult(searchId, a, 5);
      db.addSearchResult(searchId, a, 2);

      expect(db.getSearchResults(searchId)[0].rank).to.equal(2);
    });
  });

  describe('transactions', () => {
    it('commits nested transactions with the outer one', () => {
      db.transaction(() => {
        db.addMedia(video({ source_id: 1 }));
        db.transaction(() => db.addMedia(video({ source_id: 2 })));
      });
      expect(db.findMedia()).to.have.length(2);
    });

    it('rolls back only the inner work when an inner transaction fails and is caught', () => {
      db.transaction(() => {
        db.addMedia(video({ source_id: 1 }));
        expect(() => db.transaction(() => {
          db.addMedia(video({ source_id: 2 }));
          throw new Error('inner');
        })).to.throw('inner');
      });
      expect(db.findMedia().map(m => m.source_id)).to.deep.equal(['1']);
    });

    it('rolls back everything when the outer transaction fails', () => {
      expect(() => db.transaction(() => {
        db.transaction(() => db.addMedia(video({ source_id: 1 })));
        throw new Error('outer');
      })).to.throw('outer');
      expect(db.findMedia()).to.have.length(0);
      expect(db.transactionDepth).to.equal(0);
    });
  });

  describe('imported files', () => {
    it('records and updates the outcome per source path', () => {
      db.recordImportedFile({ source_path: '/src/a.jpg', size: 10, mtime_ms: 1000.7, status: 'too_small', detail: '320x240' });
      expect(db.getImportedFile('/src/a.jpg')).to.include({ size: 10, mtime_ms: 1000, status: 'too_small', detail: '320x240' });

      const id = db.addMedia(video());
      db.recordImportedFile({ source_path: '/src/a.jpg', size: 20, mtime_ms: 2000, sha256: 'h', media_id: id, status: 'imported' });
      expect(db.getImportedFile('/src/a.jpg')).to.include({ size: 20, media_id: id, status: 'imported', detail: null });
      expect(db.getImportedFile('/src/other.jpg')).to.be.null;
    });

    it('rejects unknown statuses', () => {
      expect(() => db.recordImportedFile({ source_path: '/a', size: 1, mtime_ms: 1, status: 'maybe' }))
        .to.throw('Invalid import status');
    });

    it('keeps the record but clears the link when the media is deleted', () => {
      const id = db.addMedia(video());
      db.recordImportedFile({ source_path: '/src/a.mp4', size: 1, mtime_ms: 1, media_id: id, status: 'imported' });
      db.deleteMedia(id);
      expect(db.getImportedFile('/src/a.mp4').media_id).to.be.null;
    });
  });

  describe('settings', () => {
    it('returns the default for missing keys', () => {
      expect(db.getSetting('mode')).to.be.null;
      expect(db.getSetting('mode', 'video')).to.equal('video');
    });

    it('stores and overwrites JSON values', () => {
      db.setSetting('mode', 'image');
      db.setSetting('last', { id: 3 });
      db.setSetting('mode', 'video');

      expect(db.getSetting('mode')).to.equal('video');
      expect(db.getSetting('last')).to.deep.equal({ id: 3 });
    });
  });

  describe('stats', () => {
    it('counts media by kind and status, plus searches and ratings', () => {
      const a = db.addMedia(video({ source_id: 1 }));
      db.addMedia(video({ source_id: 2 }));
      db.addMedia({ kind: 'gif', source: 'local', source_id: 1 });
      db.addRating(a, 2);
      db.addSearch('pexels', 'ocean');

      const stats = db.getStats();
      expect(stats.media.video).to.deep.equal({ new: 1, kept: 1, skipped: 0 });
      expect(stats.media.gif.new).to.equal(1);
      expect(stats.media.image).to.deep.equal({ new: 0, kept: 0, skipped: 0 });
      expect(stats.searches).to.equal(1);
      expect(stats.ratings).to.equal(1);
    });
  });

  describe('duplicates and queries', () => {
    it('lists distinct queries per item, oldest first and case-insensitively', () => {
      const id = db.addMedia(video());
      for (const query of ['ocean', 'night city', 'Ocean']) db.addSearchResult(db.addSearch('pexels', query), id, 1);
      expect(db.getQueries(id)).to.deep.equal(['ocean', 'night city']);
      expect(db.getQueries(id + 1)).to.deep.equal([]);
    });

    it('marks a duplicate, moves its search results to the original and hides it from pending', () => {
      const original = db.addMedia(video({ source_id: 1, path: '/m/a.mp4' }));
      const copy = db.addMedia(video({ source_id: 2 }));
      const shared = db.addSearch('pexels', 'ocean');
      const other = db.addSearch('pexels', 'coast');
      db.addSearchResult(shared, original, 5);
      db.addSearchResult(shared, copy, 2);
      db.addSearchResult(other, copy, 7);

      db.markDuplicate(copy, original);

      expect(db.getMedia(copy).duplicate_of).to.equal(original);
      expect(db.getQueries(original)).to.deep.equal(['ocean', 'coast']);
      expect(db.getSearchResults(shared).map(media => [media.id, media.rank])).to.deep.equal([[original, 2]]);
      expect(db.findMedia({ downloaded: false })).to.deep.equal([]);
      expect(db.getStats()).to.include({ pending: 0, duplicates: 1 });
      expect(db.getStats().media.video.new).to.equal(1);
    });

    it('refuses self-references and items that were downloaded meanwhile', () => {
      const original = db.addMedia(video({ source_id: 1, path: '/m/a.mp4' }));
      const downloaded = db.addMedia(video({ source_id: 2, path: '/m/b.mp4' }));
      expect(() => db.markDuplicate(original, original)).to.throw('itself');
      expect(() => db.markDuplicate(downloaded, original)).to.throw('changed');
      expect(db.getMedia(downloaded).duplicate_of).to.be.null;
    });

    it('keeps a duplicate hidden after its original is deleted', () => {
      const original = db.addMedia(video({ source_id: 1, path: '/m/a.mp4' }));
      const copy = db.addMedia(video({ source_id: 2 }));
      db.markDuplicate(copy, original);
      db.deleteMedia(original);
      expect(db.findMedia({ downloaded: false })).to.deep.equal([]);
    });
  });

  describe('orientationOf', () => {
    it('is portrait only when height exceeds width', () => {
      expect(orientationOf('1080x1920')).to.equal('portrait');
      expect(orientationOf('1920x1080')).to.equal('landscape');
      expect(orientationOf('1000x1000')).to.equal('landscape');
    });

    it('defaults to landscape for missing or malformed input', () => {
      expect(orientationOf(null)).to.equal('landscape');
      expect(orientationOf('wide')).to.equal('landscape');
    });
  });

  describe('close', () => {
    it('is safe to call twice', () => {
      db.close();
      expect(() => db.close()).to.not.throw();
    });
  });
});
