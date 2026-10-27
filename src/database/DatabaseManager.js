import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs-extra';

export const SCHEMA_VERSION = 5;
export const IMPORT_STATUSES = ['imported', 'duplicate', 'too_small', 'unsupported', 'failed'];
export const MEDIA_KINDS = ['image', 'video', 'gif'];
export const MEDIA_STATUSES = ['new', 'kept', 'skipped'];

// mpv accepts playback speeds in this range
const MIN_SPEED = 0.01;
const MAX_SPEED = 100;

// Columns callers may write through addMedia/updateMedia; id, status and timestamps are managed here
const MEDIA_FIELDS = [
  'kind', 'source', 'source_id', 'path', 'original_name', 'width', 'height', 'duration',
  'sha256', 'speed', 'dim', 'tags', 'variants', 'author', 'page_url'
];
const JSON_FIELDS = ['tags', 'variants'];

// MIGRATIONS[n] upgrades a database from schema version n to n + 1
const MIGRATIONS = [`
  CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'gif')),
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    path TEXT UNIQUE,
    original_name TEXT,
    width INTEGER,
    height INTEGER,
    duration REAL,
    sha256 TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'kept', 'skipped')),
    status_changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    speed REAL NOT NULL DEFAULT 1.0,
    tags TEXT NOT NULL DEFAULT '[]',
    variants TEXT NOT NULL DEFAULT '[]',
    author TEXT,
    page_url TEXT,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, source_id)
  );

  CREATE INDEX idx_media_kind_status ON media (kind, status);

  CREATE TABLE ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 3),
    orientation TEXT NOT NULL CHECK (orientation IN ('landscape', 'portrait')),
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_ratings_media ON ratings (media_id, id);

  CREATE TABLE searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    query TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE search_results (
    search_id INTEGER NOT NULL REFERENCES searches (id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    PRIMARY KEY (search_id, media_id)
  );

  CREATE TABLE sequences (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`, `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`, `
  CREATE TABLE imported_files (
    source_path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    sha256 TEXT,
    media_id INTEGER REFERENCES media (id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('imported', 'duplicate', 'too_small', 'unsupported', 'failed')),
    detail TEXT,
    checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`, `
  ALTER TABLE ratings ADD COLUMN previous_path TEXT;
  ALTER TABLE ratings ADD COLUMN rated_path TEXT;
`, `
  ALTER TABLE media ADD COLUMN dim INTEGER NOT NULL DEFAULT 0;
`];

export function orientationOf(resolution) {
  const match = /^(\d+)x(\d+)$/.exec(resolution || '');
  if (!match) {
    return 'landscape';
  }
  return Number(match[2]) > Number(match[1]) ? 'portrait' : 'landscape';
}

function statusForRating(rating) {
  return rating === 0 ? 'skipped' : 'kept';
}

function serialize(field, value) {
  return JSON_FIELDS.includes(field) ? JSON.stringify(value ?? []) : value ?? null;
}

function parseMedia(row) {
  if (!row) {
    return null;
  }
  const media = { ...row };
  for (const field of JSON_FIELDS) {
    media[field] = JSON.parse(media[field]);
  }
  return media;
}

export class DatabaseManager {
  constructor() {
    this.db = null;
    this.dbPath = null;
    this.transactionDepth = 0;
  }

  initialize(dbPath) {
    this.dbPath = dbPath;

    try {
      if (dbPath !== ':memory:') {
        fs.ensureDirSync(path.dirname(dbPath));
      }

      this.db = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (dbPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL');
      }

      this.migrate();
    } catch (error) {
      throw new Error(`Failed to initialize database: ${error.message}`);
    }
  }

  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();

    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema v${version} is newer than this version of backdrop supports (v${SCHEMA_VERSION})`);
    }
    for (let next = version; next < SCHEMA_VERSION; next++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next]);
        this.db.exec(`PRAGMA user_version = ${next + 1}`);
      });
    }
  }

  // Nested calls join the outermost transaction through savepoints
  transaction(fn) {
    const savepoint = `sp${this.transactionDepth}`;
    this.db.exec(this.transactionDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const result = fn();
      this.transactionDepth--;
      this.db.exec(this.transactionDepth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth--;
      this.db.exec(this.transactionDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  // Returns the next value of a named counter; values are never reused, even after rows are deleted
  nextSequence(name) {
    return this.db.prepare(`
      INSERT INTO sequences (name, value) VALUES (?, 1)
      ON CONFLICT (name) DO UPDATE SET value = value + 1
      RETURNING value
    `).get(name).value;
  }

  addMedia(item) {
    if (!MEDIA_KINDS.includes(item.kind)) {
      throw new Error(`Invalid media kind: ${item.kind}`);
    }
    if (!item.source || item.source_id === undefined || item.source_id === null) {
      throw new Error('Media requires source and source_id');
    }
    if (item.speed !== undefined) {
      this.validateSpeed(item.speed);
    }

    const fields = MEDIA_FIELDS.filter(field => item[field] !== undefined);
    const values = fields.map(field => field === 'source_id' ? String(item[field]) : serialize(field, item[field]));

    const result = this.db.prepare(`
      INSERT INTO media (${fields.join(', ')})
      VALUES (${fields.map(() => '?').join(', ')})
    `).run(...values);

    return Number(result.lastInsertRowid);
  }

  // Inserts a media item or refreshes the source metadata of an existing one,
  // leaving local state and measured dimensions of downloaded files untouched
  upsertMedia(item) {
    const existing = this.getMediaBySource(item.source, item.source_id);
    if (!existing) {
      return this.addMedia(item);
    }

    const metadata = {};
    for (const field of ['width', 'height', 'duration', 'tags', 'variants', 'author', 'page_url']) {
      if (existing.path && ['width', 'height', 'duration'].includes(field)) continue;
      if (item[field] !== undefined) {
        metadata[field] = item[field];
      }
    }
    this.updateMedia(existing.id, metadata);
    return existing.id;
  }

  updateMedia(id, changes) {
    const fields = Object.keys(changes);
    const invalid = fields.filter(field => !MEDIA_FIELDS.includes(field));
    if (invalid.length) {
      throw new Error(`Cannot update media fields: ${invalid.join(', ')}`);
    }
    if (changes.speed !== undefined) {
      this.validateSpeed(changes.speed);
    }
    if (changes.dim !== undefined) {
      this.validateDim(changes.dim);
    }
    if (!fields.length) {
      return;
    }

    const assignments = fields.map(field => `${field} = ?`).join(', ');
    const values = fields.map(field => serialize(field, changes[field]));
    this.db.prepare(`
      UPDATE media SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(...values, id);
  }

  getMedia(id) {
    return parseMedia(this.db.prepare('SELECT * FROM media WHERE id = ?').get(id));
  }

  getMediaBySource(source, sourceId) {
    return parseMedia(this.db.prepare('SELECT * FROM media WHERE source = ? AND source_id = ?')
      .get(source, String(sourceId)));
  }

  getMediaByPath(filePath) {
    return parseMedia(this.db.prepare('SELECT * FROM media WHERE path = ?').get(filePath));
  }

  getMediaBySha256(sha256) {
    return parseMedia(this.db.prepare('SELECT * FROM media WHERE sha256 = ?').get(sha256));
  }

  // Filters: kind, status, source, minWidth/minHeight (resolution floor), minRating,
  // orientation (rated on a monitor of that orientation), downloaded, limit
  findMedia(filters = {}) {
    const conditions = [];
    const params = [];

    for (const [filter, column] of [['kind', 'kind'], ['status', 'status'], ['source', 'source']]) {
      if (filters[filter] !== undefined) {
        const values = [].concat(filters[filter]);
        conditions.push(`m.${column} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      }
    }
    if (filters.minWidth) {
      conditions.push('m.width >= ?');
      params.push(filters.minWidth);
    }
    if (filters.minHeight) {
      conditions.push('m.height >= ?');
      params.push(filters.minHeight);
    }
    if (filters.downloaded !== undefined) {
      conditions.push(filters.downloaded ? 'm.path IS NOT NULL' : 'm.path IS NULL');
    }
    if (filters.excludeLocal) conditions.push("m.source <> 'local'");
    for (const keyword of filters.keywords ?? []) {
      conditions.push(`(instr(lower(COALESCE(m.original_name, '')), lower(?)) > 0
        OR instr(lower(m.tags), lower(?)) > 0 OR EXISTS (
          SELECT 1 FROM search_results sr JOIN searches s ON s.id = sr.search_id
          WHERE sr.media_id = m.id AND instr(lower(s.query), lower(?)) > 0))`);
      params.push(keyword, keyword, keyword);
    }
    if (filters.minRating !== undefined || filters.orientation !== undefined) {
      const ratingConditions = ['r.media_id = m.id'];
      if (filters.minRating !== undefined) {
        ratingConditions.push('r.rating >= ?');
        params.push(filters.minRating);
      }
      if (filters.orientation !== undefined) {
        ratingConditions.push('r.orientation = ?');
        params.push(filters.orientation);
      }
      // Only the latest rating counts, so an item re-rated lower drops out of higher filters
      ratingConditions.push('r.id = (SELECT MAX(id) FROM ratings WHERE media_id = m.id)');
      conditions.push(`EXISTS (SELECT 1 FROM ratings r WHERE ${ratingConditions.join(' AND ')})`);
    }

    let query = 'SELECT m.* FROM media m';
    if (conditions.length) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY m.id';
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    return this.db.prepare(query).all(...params).map(parseMedia);
  }

  deleteMedia(id) {
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
  }

  validateSpeed(speed) {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
      throw new Error(`Speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}`);
    }
  }

  setSpeed(id, speed) {
    this.updateMedia(id, { speed });
  }

  // 0 (full brightness) to 100 (black); applied as mpv brightness -dim
  validateDim(dim) {
    if (!Number.isInteger(dim) || dim < 0 || dim > 100) {
      throw new Error('Dim must be a whole number from 0 to 100');
    }
  }

  setDim(id, dim) {
    this.updateMedia(id, { dim });
  }

  // rating 0 skips the item, 1-3 keeps it; status follows the latest rating
  addRating(mediaId, rating, resolution = null, { previousPath = null, ratedPath = null } = {}) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 3) {
      throw new Error('Rating must be an integer from 0 to 3');
    }
    if (!this.getMedia(mediaId)) {
      throw new Error(`Media ${mediaId} not found`);
    }

    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO ratings (media_id, rating, orientation, resolution, previous_path, rated_path)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(mediaId, rating, orientationOf(resolution), resolution, previousPath, ratedPath);

      this.setStatus(mediaId, statusForRating(rating));
      return Number(result.lastInsertRowid);
    });
  }

  getLatestRating(mediaId, beforeId = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT * FROM ratings WHERE media_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(mediaId, beforeId) ?? null;
  }

  getLastRating() {
    return this.db.prepare('SELECT * FROM ratings ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  // Removes the most recent rating across all media and restores the item's previous status.
  // Returns { rating, media } so the caller can move the file back, or null if nothing to undo.
  undoLastRating(expectedId = null) {
    return this.transaction(() => {
      const rating = this.getLastRating();
      if (expectedId !== null && rating?.id !== expectedId) {
        throw new Error('Rating changed while undoing; try again');
      }
      if (!rating) {
        return null;
      }

      this.db.prepare('DELETE FROM ratings WHERE id = ?').run(rating.id);
      const previous = this.getLatestRating(rating.media_id);
      this.setStatus(rating.media_id, previous ? statusForRating(previous.rating) : 'new');

      return { rating: { ...rating }, media: this.getMedia(rating.media_id) };
    });
  }

  setStatus(mediaId, status) {
    if (!MEDIA_STATUSES.includes(status)) {
      throw new Error(`Invalid media status: ${status}`);
    }
    this.db.prepare(`
      UPDATE media
      SET status = ?, status_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, mediaId);
  }

  // Skipped items still holding a file whose status is older than the trash retention period
  getExpiredTrash(days) {
    return this.db.prepare(`
      SELECT * FROM media
      WHERE status = 'skipped' AND path IS NOT NULL AND status_changed_at <= datetime('now', ?)
      ORDER BY id
    `).all(`-${Number(days)} days`).map(parseMedia);
  }

  addSearch(source, query, params = {}) {
    const result = this.db.prepare('INSERT INTO searches (source, query, params) VALUES (?, ?, ?)')
      .run(source, query, JSON.stringify(params));
    return Number(result.lastInsertRowid);
  }

  addSearchResult(searchId, mediaId, rank) {
    this.db.prepare(`
      INSERT INTO search_results (search_id, media_id, rank) VALUES (?, ?, ?)
      ON CONFLICT (search_id, media_id) DO UPDATE SET rank = excluded.rank
    `).run(searchId, mediaId, rank);
  }

  getSearchResults(searchId) {
    return this.db.prepare(`
      SELECT m.*, sr.rank FROM search_results sr
      JOIN media m ON m.id = sr.media_id
      WHERE sr.search_id = ?
      ORDER BY sr.rank
    `).all(searchId).map(parseMedia);
  }

  // Persistent key/value state such as the display mode; values are stored as JSON
  getSetting(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  // Outcome of the last import attempt for a source file, keyed by its path
  getImportedFile(sourcePath) {
    return this.db.prepare('SELECT * FROM imported_files WHERE source_path = ?').get(sourcePath) ?? null;
  }

  recordImportedFile({ source_path, size, mtime_ms, sha256 = null, media_id = null, status, detail = null }) {
    if (!IMPORT_STATUSES.includes(status)) {
      throw new Error(`Invalid import status: ${status}`);
    }
    this.db.prepare(`
      INSERT INTO imported_files (source_path, size, mtime_ms, sha256, media_id, status, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_path) DO UPDATE SET
        size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
        media_id = excluded.media_id, status = excluded.status, detail = excluded.detail,
        checked_at = CURRENT_TIMESTAMP
    `).run(source_path, size, Math.trunc(mtime_ms), sha256, media_id, status, detail);
  }

  getStats() {
    const byKindStatus = this.db.prepare(`
      SELECT kind, status, COUNT(*) AS count FROM media GROUP BY kind, status
    `).all();
    const media = {};
    for (const kind of MEDIA_KINDS) {
      media[kind] = Object.fromEntries(MEDIA_STATUSES.map(status => [status, 0]));
    }
    for (const row of byKindStatus) {
      media[row.kind][row.status] = row.count;
    }

    const { count: searches } = this.db.prepare('SELECT COUNT(*) AS count FROM searches').get();
    const { count: ratings } = this.db.prepare('SELECT COUNT(*) AS count FROM ratings').get();

    return { media, searches, ratings };
  }

  close() {
    if (this.db?.isOpen) {
      this.db.close();
    }
    this.db = null;
  }
}
