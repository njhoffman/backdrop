import fs from 'fs-extra';
import path from 'path';

// Validated library.trash_days; 0 disables purging
export function trashDays(config) {
  const days = config.get().library.trash_days;
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`library.trash_days must be a whole number of days, 0 to disable (got ${days})`);
  }
  return days;
}

// Deletes trash files whose skip is older than library.trash_days. The media row and ratings stay,
// with path set to null, so a later search does not offer the item again. Files outside the trash
// folder are left alone, and a failed unlink leaves the row for the next run.
export async function purgeTrash({ config, database, logger, dryRun = false, unlink = file => fs.unlink(file) }) {
  const days = trashDays(config);
  const result = { disabled: days === 0, purged: [], failed: [] };
  if (result.disabled) return result;

  const trash = path.resolve(config.get().paths.trash);
  for (const media of database.getExpiredTrash(days)) {
    if (path.dirname(path.resolve(media.path)) !== trash) {
      logger.warn('Skipped item is not in the trash folder, not purging', { mediaId: media.id, path: media.path });
      result.failed.push(media);
      continue;
    }
    if (dryRun) {
      result.purged.push(media);
      continue;
    }
    try {
      await unlink(media.path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to purge trash file', { mediaId: media.id, path: media.path, error: error.message });
        result.failed.push(media);
        continue;
      }
    }
    // The file is gone for good, so undo must not stop at this item's ratings
    database.transaction(() => {
      database.updateMedia(media.id, { path: null });
      database.finalizeRatings(media.id);
    });
    result.purged.push(media);
  }
  if (result.purged.length && !dryRun) {
    logger.info('Purged trash', { purged: result.purged.length, failed: result.failed.length, days });
  }
  return result;
}
