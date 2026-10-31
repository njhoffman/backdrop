import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { pipeline } from 'stream/promises';
import { MEDIA_EXTENSIONS, probeMedia, meetsMinimum, UnsupportedMedia } from './probe.js';
import { inOrder } from '../utils/pool.js';
import { ImportLock, importLockPath } from './importLock.js';

export const LOCAL_SOURCE = 'local';

// Files hashed and probed at once; ffprobe spends most of its ~0.2s per file starting up
export const IMPORT_CONCURRENCY = 4;

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function isInside(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function emptySummary() {
  return { locked: false, scanned: 0, unchanged: 0, recent: 0, imported: [], duplicates: 0, tooSmall: 0, unsupported: 0, failed: 0 };
}

// Copies approved local media into the library as local-<n>.<ext>, kept with the default rating.
// Each source file's size and mtime are recorded, so unchanged files are skipped on later runs.
export class Importer {
  constructor({ config, database, logger, probe = probeMedia, lock }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.probe = probe;
    this.lock = lock ?? new ImportLock(importLockPath(config));
  }

  async findFiles(dirs) {
    const { media, trash } = this.config.get().paths;
    const files = [];

    for (const dir of dirs) {
      if (!await fs.pathExists(dir)) {
        this.logger.warn('Import directory does not exist', { dir });
        continue;
      }
      const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        const file = path.join(entry.parentPath, entry.name);
        const hidden = path.relative(dir, file).split(path.sep).some(part => part.startsWith('.'));
        if (entry.isFile() && !hidden
          && MEDIA_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
          && !isInside(file, media) && !isInside(file, trash)) {
          files.push(file);
        }
      }
    }
    return [...new Set(files)].sort();
  }

  // resolution: the monitor the default rating is recorded against (e.g. '2304x1296'), or null.
  // shouldStop: checked between files so a stopping daemon does not wait for a long import.
  // onStart(total) runs once the file list is known; onFile(file, outcome, done) after each file.
  // concurrency: files hashed and probed at once. They are added to the library one at a time in path
  // order, so local-<n> numbers follow the file names and duplicates within a run are caught.
  // settle: files changed less than this many ms ago are left alone (status 'recent', not recorded), so a
  // watched folder does not import a file that is still being copied in.
  // Only one import runs at a time: whenLocked 'wait' waits for another process's import to finish
  // (calling onWait(holder) once), 'skip' returns at once with summary.locked set.
  async importDirs(dirs, { whenLocked = 'wait', onWait = () => {}, ...options } = {}) {
    const acquired = whenLocked === 'skip'
      ? this.lock.tryAcquire()
      : await this.lock.acquire({ onWait, shouldStop: options.shouldStop });
    if (!acquired) {
      this.logger.info('Import skipped: another import is running', { holder: this.lock.holder()?.pid ?? null });
      return { ...emptySummary(), locked: true };
    }
    try {
      return await this.importLocked(dirs, options);
    } finally {
      this.lock.release();
    }
  }

  async importLocked(dirs, { resolution = null, shouldStop = () => false, onStart = () => {}, onFile = () => {}, concurrency = IMPORT_CONCURRENCY, settle = 0 } = {}) {
    const summary = emptySummary();
    const files = await this.findFiles(dirs);
    onStart(files.length);

    for await (const { item: file, result, error } of inOrder(files, file => this.prepare(file, { settle }), { concurrency, shouldStop })) {
      if (shouldStop()) {
        break;
      }
      summary.scanned++;
      const outcome = await (error ? this.fail(file, null, error) : this.commit(file, result, resolution));
      onFile(file, outcome, summary.scanned);

      if (outcome.status === 'unchanged') summary.unchanged++;
      else if (outcome.status === 'recent') summary.recent++;
      else if (outcome.status === 'imported') summary.imported.push(outcome.mediaId);
      else if (outcome.status === 'duplicate') summary.duplicates++;
      else if (outcome.status === 'too_small') summary.tooSmall++;
      else if (outcome.status === 'unsupported') summary.unsupported++;
      else summary.failed++;
    }

    this.logger.info('Import finished', { ...summary, imported: summary.imported.length });
    return summary;
  }

  async importFile(file, resolution = null) {
    let prepared;
    try {
      prepared = await this.prepare(file);
    } catch (error) {
      return this.fail(file, null, error);
    }
    return this.commit(file, prepared, resolution);
  }

  // The part that can run for several files at once: reads only, writes nothing
  async prepare(file, { settle = 0 } = {}) {
    const stat = await fs.stat(file);
    const known = this.database.getImportedFile(file);
    if (known && known.size === stat.size && known.mtime_ms === Math.trunc(stat.mtimeMs)) {
      return { stat, unchanged: known };
    }
    // ctime also moves when a copy that keeps the original mtime (cp -p) sets it at the end
    if (settle && Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < settle) {
      return { stat, recent: true };
    }
    const sha256 = await hashFile(file);
    let reason = null;
    const info = await this.probe(file).catch(error => {
      if (error instanceof UnsupportedMedia) reason = error.message;
      return null;
    });
    return { stat, sha256, info, reason };
  }

  record(file, stat, fields) {
    this.database.recordImportedFile({ source_path: file, size: stat.size, mtime_ms: stat.mtimeMs, ...fields });
    return { status: fields.status, mediaId: fields.media_id ?? null, detail: fields.detail ?? null };
  }

  async fail(file, stat, error) {
    this.logger.error('Import failed', { file, error: error.message });
    // A file that vanished before it could be read has nothing to record against
    const known = stat ?? await fs.stat(file).catch(() => null);
    if (!known) return { status: 'failed', mediaId: null, detail: error.message };
    return this.record(file, known, { status: 'failed', detail: error.message });
  }

  // One file at a time, in order: duplicate check, minimum size and the library insert
  async commit(file, { stat, unchanged, recent, sha256, info, reason }, resolution) {
    if (unchanged) {
      return { status: 'unchanged', mediaId: unchanged.media_id };
    }
    if (recent) {
      return { status: 'recent', mediaId: null, detail: 'still changing' };
    }
    const record = fields => this.record(file, stat, fields);

    try {
      const existing = this.database.getMediaBySha256(sha256);
      if (existing) {
        return record({ status: 'duplicate', sha256, media_id: existing.id });
      }
      if (!info) {
        return record({ status: 'unsupported', sha256, detail: reason ?? 'no picture stream' });
      }

      const { min_width: minWidth, min_height: minHeight } = this.config.get().library;
      if (!meetsMinimum(info, minWidth, minHeight)) {
        return record({ status: 'too_small', sha256, detail: `${info.width}x${info.height}` });
      }

      const mediaId = await this.addToLibrary(file, sha256, info, resolution);
      return record({ status: 'imported', sha256, media_id: mediaId });
    } catch (error) {
      if (error.duplicate) {
        return record({ status: 'duplicate', sha256: error.sha256, media_id: error.mediaId });
      }
      return this.fail(file, stat, error);
    }
  }

  async addToLibrary(file, sha256, info, resolution) {
    const { paths, library } = this.config.get();
    const number = this.database.nextSequence(LOCAL_SOURCE);
    const extension = path.extname(file).toLowerCase();
    const target = path.join(paths.media, `${LOCAL_SOURCE}-${number}${extension}`);
    const partial = `${target}.partial`;

    await fs.ensureDir(paths.media);
    await fs.copy(file, partial, { preserveTimestamps: true });
    await fs.rename(partial, target);

    try {
      return this.database.transaction(() => {
        const mediaId = this.database.addMedia({
          kind: info.kind,
          source: LOCAL_SOURCE,
          source_id: number,
          path: target,
          original_name: path.basename(file),
          width: info.width,
          height: info.height,
          duration: info.duration,
          fps: info.fps ?? null,
          sha256
        });
        this.database.addRating(mediaId, library.default_import_rating, resolution);
        return mediaId;
      });
    } catch (error) {
      await fs.remove(target);
      // Another import (daemon or CLI) added the same content first
      const winner = this.database.getMediaBySha256(sha256);
      if (winner) {
        throw Object.assign(new Error('duplicate'), { duplicate: true, mediaId: winner.id, sha256 });
      }
      throw error;
    }
  }
}
