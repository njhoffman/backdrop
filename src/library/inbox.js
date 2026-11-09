import fs from 'fs-extra';
import path from 'path';

// Moves the unrated downloads left in the old inbox (~/.cache/backdrop/inbox, before 2.67.0) to paths.inbox, where a
// cleaner that empties ~/.cache cannot take them. Each item's path follows its file, and rating paths recorded in the
// old folder (where undo puts a file back) point at the new one. A file whose name is taken in the new inbox, and
// files no item points at (a download stopped midway), stay behind and are counted; the old folder goes once empty.
// The caller makes sure no daemon runs: its playlist holds the old paths. Returns { moved, left, ratings }, or null
// when there is nothing to move.
export async function moveLegacyInbox({ legacy, inbox, database, logger }) {
  if (path.resolve(legacy) === path.resolve(inbox) || !await fs.pathExists(legacy)) return null;
  await fs.ensureDir(inbox);
  const result = { moved: 0, left: 0, ratings: 0 };
  for (const media of database.findMediaInFolder(legacy)) {
    const target = path.join(inbox, path.basename(media.path));
    if (!await fs.pathExists(media.path)) continue;
    if (await fs.pathExists(target)) {
      logger?.warn('Inbox file not moved: the name is taken in the new inbox', { mediaId: media.id, path: media.path, target });
      continue;
    }
    await fs.move(media.path, target);
    try {
      database.updateMedia(media.id, { path: target });
    } catch (error) {
      await fs.move(target, media.path).catch(() => {});
      throw error;
    }
    result.moved++;
  }
  result.ratings = database.relocateRatingPaths(legacy, inbox);
  const rest = await fs.readdir(legacy);
  result.left = rest.length;
  if (rest.length) logger?.warn('Files left in the old inbox', { folder: legacy, files: rest.length });
  else await fs.remove(legacy);
  logger?.info('Moved the inbox out of the cache', { from: legacy, to: inbox, ...result });
  return result;
}
