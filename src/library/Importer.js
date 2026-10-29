import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { pipeline } from 'stream/promises';
import { MEDIA_EXTENSIONS, probeMedia, meetsMinimum } from './probe.js';

export const LOCAL_SOURCE = 'local';

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
  return { scanned: 0, unchanged: 0, imported: [], duplicates: 0, tooSmall: 0, unsupported: 0, failed: 0 };
}

// Copies approved local media into the library as local-<n>.<ext>, kept with the default rating.
// Each source file's size and mtime are recorded, so unchanged files are skipped on later runs.
export class Importer {
  constructor({ config, database, logger, probe = probeMedia }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.probe = probe;
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
  async importDirs(dirs, { resolution = null, shouldStop = () => false, onStart = () => {}, onFile = () => {} } = {}) {
    const summary = emptySummary();
    const files = await this.findFiles(dirs);
    onStart(files.length);

    for (const file of files) {
      if (shouldStop()) {
        break;
      }
      summary.scanned++;
      const outcome = await this.importFile(file, resolution);
      onFile(file, outcome, summary.scanned);

      if (outcome.status === 'unchanged') summary.unchanged++;
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
    const stat = await fs.stat(file);
    const known = this.database.getImportedFile(file);
    if (known && known.size === stat.size && known.mtime_ms === Math.trunc(stat.mtimeMs)) {
      return { status: 'unchanged', mediaId: known.media_id };
    }

    const record = fields => {
      this.database.recordImportedFile({ source_path: file, size: stat.size, mtime_ms: stat.mtimeMs, ...fields });
      return { status: fields.status, mediaId: fields.media_id ?? null, detail: fields.detail ?? null };
    };

    try {
      const sha256 = await hashFile(file);
      const existing = this.database.getMediaBySha256(sha256);
      if (existing) {
        return record({ status: 'duplicate', sha256, media_id: existing.id });
      }

      const info = await this.probe(file).catch(() => null);
      if (!info) {
        return record({ status: 'unsupported', sha256, detail: 'no picture stream' });
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
      this.logger.error('Import failed', { file, error: error.message });
      return record({ status: 'failed', detail: error.message });
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
