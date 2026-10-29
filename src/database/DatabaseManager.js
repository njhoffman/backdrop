import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs-extra';
import { tagsFor } from '../library/tags.js';

export const SCHEMA_VERSION = 9;
export const IMPORT_STATUSES = ['imported', 'duplicate', 'too_small', 'unsupported', 'failed'];
export const MEDIA_KINDS = ['image', 'video', 'gif'];
export const MEDIA_STATUSES = ['new', 'kept', 'skipped'];

// mpv accepts playback speeds in this range
const MIN_SPEED = 0.01;
const MAX_SPEED = 100;

// Columns callers may write through addMedia/updateMedia; id, status and timestamps are managed here
const MEDIA_FIELDS = [
  'kind', 'source', 'source_id', 'path', 'original_name', 'width', 'height', 'duration',
  'sha256', 'speed', 'dim', 'tags', 'variants', 'author', 'page_url', 'duplicate_of', 'fps'
];
// Changing any of these rebuilds an item's derived tags
const TAG_FIELDS = ['source', 'original_name', 'page_url', 'tags'];
const JSON_FIELDS = ['tags', 'variants'];

// MIGRATIONS[n] upgrades a database from schema version n to n + 1: SQL, or a function for data changes
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
`, `
  -- No foreign key on purpose: removing the original must not make its duplicate downloadable again,
  -- and media ids are never reused (AUTOINCREMENT)
  ALTER TABLE media ADD COLUMN duplicate_of INTEGER;
`, database => {
  database.db.exec(`
    ALTER TABLE media ADD COLUMN fps REAL;

    -- Words from file names, page slugs and descriptions; the media.tags column keeps the source's own text
    CREATE TABLE media_tags (
      media_id INTEGER NOT NULL REFERENCES media (id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      origin TEXT NOT NULL,
      PRIMARY KEY (media_id, tag)
    );
    CREATE INDEX idx_media_tags_tag ON media_tags (tag);
  `);
  for (const { id } of database.db.prepare('SELECT id FROM media').all()) database.refreshTags(id);
}, `
  -- What playing an item costs, sampled by the daemon: wall seconds observed and the CPU seconds mpv used
  -- in them, plus the decoder mpv last reported ('no' is software decoding)
  CREATE TABLE playback_stats (
    media_id INTEGER PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
    seconds REAL NOT NULL DEFAULT 0,
    cpu_seconds REAL NOT NULL DEFAULT 0,
    hwdec TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`, `
  -- Final ratings stay in the history but undo skips them: their file was purged, or undo --discard dropped them
  ALTER TABLE ratings ADD COLUMN final INTEGER NOT NULL DEFAULT 0;
  UPDATE ratings SET final = 1 WHERE media_id IN (SELECT id FROM media WHERE path IS NULL AND status = 'skipped');
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
        const step = MIGRATIONS[next];
        if (typeof step === 'function') step(this);
        else this.db.exec(step);
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

    const id = Number(result.lastInsertRowid);
    this.refreshTags(id);
    return id;
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
    if (fields.some(field => TAG_FIELDS.includes(field))) this.refreshTags(id);
  }

  // Rebuilds the tags derived from an item's name, page and description
  refreshTags(id) {
    const media = this.getMedia(id);
    if (!media) return;
    this.transaction(() => {
      this.db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO media_tags (media_id, tag, origin) VALUES (?, ?, ?)');
      for (const { tag, origin } of tagsFor(media)) insert.run(id, tag, origin);
    });
  }

  // Tag words in the order they were derived: file name, then page, then description
  getTags(id) {
    return this.db.prepare('SELECT tag FROM media_tags WHERE media_id = ? ORDER BY rowid').all(id).map(row => row.tag);
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

  // Filters: kind, status, source, minWidth/minHeight (resolution floor), minRating, tags (all must match),
  // queries (a search with any of them returned the item, exact apart from case), keywords,
  // orientation (rated on a monitor of that orientation), downloaded, limit.
  // downloaded: false leaves out items whose download turned out to duplicate another item.
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
      conditions.push(filters.downloaded ? 'm.path IS NOT NULL' : 'm.path IS NULL AND m.duplicate_of IS NULL');
    }
    if (filters.excludeLocal) conditions.push("m.source <> 'local'");
    for (const tag of filters.tags ?? []) {
      conditions.push('EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id = m.id AND t.tag = lower(?))');
      params.push(tag);
    }
    if (filters.queries?.length) {
      conditions.push(`EXISTS (SELECT 1 FROM search_results sr JOIN searches s ON s.id = sr.search_id
        WHERE sr.media_id = m.id AND lower(s.query) IN (${filters.queries.map(() => 'lower(?)').join(', ')}))`);
      params.push(...filters.queries);
    }
    for (const keyword of filters.keywords ?? []) {
      conditions.push(`(instr(lower(COALESCE(m.original_name, '')), lower(?)) > 0
        OR instr(lower(m.tags), lower(?)) > 0 OR EXISTS (
          SELECT 1 FROM media_tags t WHERE t.media_id = m.id AND instr(t.tag, lower(?)) > 0) OR EXISTS (
          SELECT 1 FROM search_results sr JOIN searches s ON s.id = sr.search_id
          WHERE sr.media_id = m.id AND instr(lower(s.query), lower(?)) > 0))`);
      params.push(keyword, keyword, keyword, keyword);
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

  // The latest rating undo can act on; final ratings are skipped
  getLastRating() {
    return this.db.prepare('SELECT * FROM ratings WHERE final = 0 ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  // Takes one rating, or every rating of an item, out of undo's reach without changing the item
  finalizeRating(ratingId) {
    this.db.prepare('UPDATE ratings SET final = 1 WHERE id = ?').run(ratingId);
  }

  finalizeRatings(mediaId) {
    this.db.prepare('UPDATE ratings SET final = 1 WHERE media_id = ?').run(mediaId);
  }

  // After a file is renamed (download --upgrade changing the extension), points recorded rating paths with
  // the old name at the new one, so undo still finds the file and restores it under its current name
  renameRatingPaths(mediaId, oldName, newName) {
    const rename = recorded => (recorded && path.basename(recorded) === oldName ? path.join(path.dirname(recorded), newName) : recorded);
    const update = this.db.prepare('UPDATE ratings SET previous_path = ?, rated_path = ? WHERE id = ?');
    for (const rating of this.db.prepare('SELECT id, previous_path, rated_path FROM ratings WHERE media_id = ?').all(mediaId)) {
      update.run(rename(rating.previous_path), rename(rating.rated_path), rating.id);
    }
  }

  // Removes the most recent rating undo can act on and restores the item's previous status.
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

  // Records that a pending item's download matched an existing item, so it is not fetched again,
  // and moves its search results to that item so the original keeps every query that found it
  markDuplicate(mediaId, originalId) {
    if (mediaId === originalId) throw new Error('An item cannot duplicate itself');
    this.transaction(() => {
      const media = this.getMedia(mediaId);
      if (!media || media.path || !this.getMedia(originalId)) throw new Error('Media changed during download');
      this.updateMedia(mediaId, { duplicate_of: originalId });
      this.db.prepare(`
        INSERT INTO search_results (search_id, media_id, rank)
        SELECT search_id, ?, rank FROM search_results WHERE media_id = ?
        ON CONFLICT (search_id, media_id) DO UPDATE SET rank = MIN(rank, excluded.rank)
      `).run(originalId, mediaId);
      this.db.prepare('DELETE FROM search_results WHERE media_id = ?').run(mediaId);
    });
  }

  // Distinct search queries that returned an item, oldest first
  getQueries(mediaId) {
    return this.db.prepare(`
      SELECT s.query FROM search_results sr JOIN searches s ON s.id = sr.search_id
      WHERE sr.media_id = ?
      GROUP BY lower(s.query)
      ORDER BY MIN(s.id)
    `).all(mediaId).map(row => row.query);
  }

  // Distinct queries of every saved search, oldest first
  getSearchQueries() {
    return this.db.prepare('SELECT query FROM searches GROUP BY lower(query) ORDER BY MIN(id)').all().map(row => row.query);
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
      SELECT kind, status, COUNT(*) AS count FROM media WHERE duplicate_of IS NULL GROUP BY kind, status
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
    const { count: pending } = this.db.prepare(`
      SELECT COUNT(*) AS count FROM media WHERE path IS NULL AND status = 'new' AND duplicate_of IS NULL
    `).get();
    const { count: duplicates } = this.db.prepare('SELECT COUNT(*) AS count FROM media WHERE duplicate_of IS NOT NULL').get();

    return { media, searches, ratings, pending, duplicates };
  }

  // Breakdowns for `backdrop stats`; duplicates are left out everywhere
  getDetailedStats({ since = null, topQueries = 5 } = {}) {
    const all = sql => this.db.prepare(sql).all();
    // Current rating of every rated item: its latest rating row
    const current = `
      SELECT r.* FROM ratings r
      JOIN (SELECT media_id, MAX(id) AS id FROM ratings GROUP BY media_id) latest ON latest.id = r.id`;

    const kinds = all(`
      SELECT kind,
        SUM(path IS NULL AND status = 'new') AS pending,
        SUM(CASE WHEN path IS NOT NULL AND status != 'skipped' THEN COALESCE(duration, 0) ELSE 0 END) AS duration
      FROM media WHERE duplicate_of IS NULL GROUP BY kind`);
    const ratings = all(`
      SELECT c.rating, c.orientation, COUNT(*) AS count FROM (${current}) c
      JOIN media m ON m.id = c.media_id WHERE m.duplicate_of IS NULL
      GROUP BY c.rating, c.orientation`);
    // Short side, so portrait media lands in the same bucket as its landscape equivalent
    const resolutions = all(`
      SELECT CASE
          WHEN MIN(width, height) >= 4320 THEN '8K'
          WHEN MIN(width, height) >= 2160 THEN '4K'
          WHEN MIN(width, height) >= 1440 THEN '1440p'
          WHEN MIN(width, height) >= 1080 THEN '1080p'
          WHEN width IS NULL OR height IS NULL THEN 'unknown'
          ELSE 'smaller' END AS bucket,
        COUNT(*) AS count
      FROM media WHERE path IS NOT NULL AND status != 'skipped' AND duplicate_of IS NULL GROUP BY bucket`);
    const sources = all(`
      SELECT m.source, COUNT(*) AS total,
        SUM(m.path IS NOT NULL) AS downloaded,
        SUM(m.status = 'kept') AS kept,
        SUM(m.status = 'skipped') AS skipped,
        SUM(m.path IS NULL AND m.status = 'new') AS pending,
        AVG(CASE WHEN m.status = 'kept' THEN c.rating END) AS average
      FROM media m LEFT JOIN (${current}) c ON c.media_id = m.id
      WHERE m.duplicate_of IS NULL GROUP BY m.source ORDER BY total DESC, m.source`);
    const queries = this.db.prepare(`
      SELECT MIN(s.query) AS query, COUNT(DISTINCT r.media_id) AS results,
        COUNT(DISTINCT CASE WHEN m.status = 'kept' THEN m.id END) AS kept,
        COUNT(DISTINCT CASE WHEN m.path IS NOT NULL THEN m.id END) AS downloaded
      FROM searches s JOIN search_results r ON r.search_id = s.id JOIN media m ON m.id = r.media_id
      WHERE m.duplicate_of IS NULL
      GROUP BY LOWER(s.query) ORDER BY results DESC, query LIMIT ?`).all(topQueries);
    const recent = since === null ? null : this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media WHERE added_at >= ? AND path IS NOT NULL AND duplicate_of IS NULL) AS added,
        (SELECT COUNT(*) FROM ratings WHERE created_at >= ?) AS ratings,
        (SELECT COUNT(*) FROM searches WHERE created_at >= ?) AS searches`).get(since, since, since);
    const { last: lastRating } = this.db.prepare('SELECT MAX(created_at) AS last FROM ratings').get();

    return { kinds, ratings, resolutions, sources, queries, recent, lastRating };
  }

  // Adds a sampled interval of playback to an item's totals
  addPlaybackSample(mediaId, seconds, cpuSeconds) {
    this.db.prepare(`
      INSERT INTO playback_stats (media_id, seconds, cpu_seconds) VALUES (?, ?, ?)
      ON CONFLICT (media_id) DO UPDATE SET seconds = seconds + excluded.seconds,
        cpu_seconds = cpu_seconds + excluded.cpu_seconds, updated_at = CURRENT_TIMESTAMP
    `).run(mediaId, seconds, cpuSeconds);
  }

  setDecoder(mediaId, hwdec) {
    this.db.prepare(`
      INSERT INTO playback_stats (media_id, hwdec) VALUES (?, ?)
      ON CONFLICT (media_id) DO UPDATE SET hwdec = excluded.hwdec, updated_at = CURRENT_TIMESTAMP
    `).run(mediaId, hwdec);
  }

  getPlaybackStats(mediaId) {
    return this.db.prepare('SELECT * FROM playback_stats WHERE media_id = ?').get(mediaId) ?? null;
  }

  // Playback cost for `backdrop stats`: average CPU by kind, resolution bucket and decoder, the most
  // expensive items with at least minSeconds sampled, and how many items mpv last decoded in software
  getPlaybackCost({ minSeconds = 120, top = 5 } = {}) {
    const groups = this.db.prepare(`
      SELECT m.kind,
        CASE
          WHEN MIN(m.width, m.height) >= 2160 THEN '4K'
          WHEN MIN(m.width, m.height) >= 1440 THEN '1440p'
          WHEN MIN(m.width, m.height) >= 1080 THEN '1080p'
          ELSE 'smaller' END AS bucket,
        CASE WHEN p.hwdec IS NULL THEN 'unknown' WHEN p.hwdec IN ('no', '') THEN 'software' ELSE 'hardware' END AS decoder,
        COUNT(*) AS items, SUM(p.seconds) AS seconds, SUM(p.cpu_seconds) AS cpu_seconds
      FROM playback_stats p JOIN media m ON m.id = p.media_id
      WHERE p.seconds > 0
      GROUP BY m.kind, bucket, decoder
      ORDER BY m.kind, SUM(p.cpu_seconds) / SUM(p.seconds) DESC`).all();
    const expensive = this.db.prepare(`
      SELECT m.*, p.seconds AS sampled_seconds, p.cpu_seconds, p.hwdec
      FROM playback_stats p JOIN media m ON m.id = p.media_id
      WHERE p.seconds >= ?
      ORDER BY p.cpu_seconds / p.seconds DESC LIMIT ?`).all(minSeconds, top).map(parseMedia);
    const { count: software } = this.db.prepare(`
      SELECT COUNT(*) AS count FROM playback_stats WHERE hwdec IN ('no', '')`).get();
    return { groups, expensive, software };
  }

  close() {
    if (this.db?.isOpen) {
      this.db.close();
    }
    this.db = null;
  }
}
