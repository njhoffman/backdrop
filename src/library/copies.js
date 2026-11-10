import { bounces, neededSize } from '../display/bounce.js';
import { listReversed, reversedReady } from './reverse.js';
import { SMOOTH_FPS, covers, listSmoothed, smoothedSize, staleCopy, wantsSmoothing } from './smooth.js';

// What `backdrop copies` reports about each reversed (paths.bounce) and smoothed (paths.smooth) copy, and the daemon
// acts on with `--sync`: { id, copy: reversed | smoothed | smoothed reversed, file, bytes, size?, need?, problem }.
// problem is null for a copy that plays, else
//   unwanted  the item is gone or skipped, no longer bounces, has another speed or is no longer smoothed
//   stale     older than the item's file (download --upgrade replaced it), so it shows what the item no longer is
//   small     a smoothed copy smaller than the monitors need, which plays the original until made again
//   unsized   a smoothed copy with no recorded size (made before 2.69.0), which the daemon probes on start
// monitors are those the copies are checked against (the daemon's, else xrandr's); without them sizes are not checked.
export async function checkCopies({ config, database, monitors = [] }) {
  const { display, paths } = config;
  const checked = [];
  for (const copy of paths.bounce ? await listReversed(paths.bounce) : []) {
    const media = database.getMedia(copy.id);
    let problem = null;
    if (!media?.path || media.status === 'skipped' || !bounces(media, display)) problem = 'unwanted';
    else if (!reversedReady(media, paths.bounce)) problem = 'stale';
    checked.push({ id: copy.id, copy: 'reversed', file: copy.file, bytes: copy.size, problem });
  }
  const target = display.smooth_fps ?? SMOOTH_FPS;
  for (const copy of paths.smooth ? await listSmoothed(paths.smooth) : []) {
    const media = database.getMedia(copy.id);
    const entry = { id: copy.id, copy: copy.reversed ? 'smoothed reversed' : 'smoothed', file: copy.file, bytes: copy.size, problem: null };
    if (!display.smooth || !media?.path || media.status === 'skipped' || media.speed !== copy.speed || !wantsSmoothing(media, target)
      || (copy.reversed && !bounces(media, display))) entry.problem = 'unwanted';
    else if (staleCopy(copy.file, media)) entry.problem = 'stale';
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
  return checked.sort((a, b) => a.id - b.id || a.copy.localeCompare(b.copy));
}
