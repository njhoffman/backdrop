import fs from 'fs-extra';
import path from 'path';
import { bounces, neededSize } from '../display/bounce.js';
import { listReversed, reversedReady } from './reverse.js';
import { SMOOTH_FPS, covers, listSmoothed, smoothedSize, wantsSmoothing } from './smooth.js';

// What `backdrop copies` reports about each reversed (paths.bounce) and smoothed (paths.smooth) copy, and the daemon
// acts on with `--sync`: { id, sha256, copy: reversed | smoothed | smoothed reversed, file, bytes, size?, need?, problem }.
// Copies are named for their item's sha256, so id is null for a copy whose item is gone (or whose file was replaced).
// problem is null for a copy that plays, else
//   unwanted  the item is gone, replaced or skipped, no longer bounces, has another speed or is no longer smoothed
//   small     a smoothed copy smaller than the monitors need, which plays the original until made again
//   unsized   a smoothed copy with no recorded size (made before 2.69.0), which the daemon probes on start
// monitors are those the copies are checked against (the daemon's, else xrandr's); without them sizes are not checked.
export async function checkCopies({ config, database, monitors = [] }) {
  const { display, paths } = config;
  const checked = [];
  for (const copy of paths.bounce ? await listReversed(paths.bounce) : []) {
    const media = database.getMediaBySha256(copy.sha256);
    const problem = !media?.path || media.status === 'skipped' || !bounces(media, display) || !reversedReady(media, paths.bounce) ? 'unwanted' : null;
    checked.push({ id: media?.id ?? null, sha256: copy.sha256, copy: 'reversed', file: copy.file, bytes: copy.size, problem });
  }
  const target = display.smooth_fps ?? SMOOTH_FPS;
  for (const copy of paths.smooth ? await listSmoothed(paths.smooth) : []) {
    const media = database.getMediaBySha256(copy.sha256);
    const entry = { id: media?.id ?? null, sha256: copy.sha256, copy: copy.reversed ? 'smoothed reversed' : 'smoothed', file: copy.file, bytes: copy.size, problem: null };
    if (!display.smooth || !media?.path || media.status === 'skipped' || media.speed !== copy.speed || !wantsSmoothing(media, target)
      || (copy.reversed && !bounces(media, display))) entry.problem = 'unwanted';
    else if (!copy.reversed) {
      const size = smoothedSize(media, paths.smooth);
      const need = neededSize(media, monitors);
      if (size) entry.size = size;
      if (need) entry.need = need;
      if (!size) entry.problem = 'unsized';
      else if (need && !covers(size, need)) entry.problem = 'small';
    }
    checked.push(entry);
  }
  return checked.sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity) || a.sha256.localeCompare(b.sha256) || a.copy.localeCompare(b.copy));
}

// Copies, size records and work folders named for the item's id (versions before 2.87): "<id>.mp4" and
// "<id>.reverse.work" in paths.bounce, "<id>@<speed>.mp4", ".reversed.mp4", ".json", ".smooth.work" and
// ".reversed.reverse.work" in paths.smooth
// (an id is at most 15 digits, so a sha256 name never matches, even one of digits alone)
const ID_NAME = /^(\d{1,15})((?:@[\d.]+)?(?:\.reversed)?(?:\.mp4|\.json|\.smooth\.work|\.reverse\.work))$/;

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Renames what versions before 2.87 named for the item's id to the item's sha256, once, when the daemon starts. What
// those versions would have deleted goes instead: anything of an item gone or without its file, and a forward copy
// older than the item's file (download --upgrade replaced it; its size record goes with it). A name already taken by
// a copy under the new scheme keeps that one. Returns { renamed, removed }.
export async function renameIdCopies(dir, database, { logger } = {}) {
  const result = { renamed: 0, removed: 0 };
  if (!dir) return result;
  const names = await fs.readdir(dir).catch(() => []);
  // Every decision is made before anything moves, so a size record is judged by its copy under the copy's old name
  const plans = [];
  for (const name of names) {
    const match = ID_NAME.exec(name);
    if (!match) continue;
    const [, id, rest] = match;
    const media = database.getMedia(Number(id));
    const source = media?.path ? mtimeOf(media.path) : null;
    // The forward copy a size record or a bounce copy stands for; a reversed smoothed copy is checked against its
    // forward copy whenever it plays (smoothedReversedReady), so it moves as it is
    const forward = rest.endsWith('.json') ? path.join(dir, `${id}${rest.replace(/\.json$/, '.mp4')}`)
      : /^(@[\d.]+)?\.mp4$/.test(rest) ? path.join(dir, name) : null;
    const stale = Boolean(forward) && source !== null && !(mtimeOf(forward) >= source);
    const keep = Boolean(media?.sha256) && source !== null && !stale;
    plans.push({ from: path.join(dir, name), to: keep ? path.join(dir, `${media.sha256}${rest}`) : null });
  }
  for (const { from, to } of plans) {
    try {
      if (!to || await fs.pathExists(to)) {
        await fs.remove(from);
        result.removed++;
      } else {
        await fs.rename(from, to);
        result.renamed++;
      }
    } catch (error) {
      logger?.warn('Failed to rename a copy', { file: from, error: error.message });
    }
  }
  if (result.renamed || result.removed) logger?.info('Copies renamed for their content', { dir, ...result });
  return result;
}
