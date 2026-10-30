import fs from 'fs-extra';
import { nextFiltersPath, readState } from './Daemon.js';
import { sendControl } from './control.js';

// --query/--tag/--keywords, --random/--no-random and --image-duration/--video-duration given to next or
// menu stay in effect until next --clear or the daemon restarts: the filters and order for every later
// next and the advances after keep and skip, the durations for every item the daemon loads. They live in
// the runtime dir tagged with the daemon's pid, so a file a crashed daemon left behind is ignored; the
// daemon is told when the durations change, since it applies them itself.
const FILTER_KEYS = ['query', 'tag', 'keywords'];
// Stored key and command-line option of each duration
const DURATIONS = { image_duration: 'imageDuration', video_duration: 'videoDuration' };

// The stored { query, tag, keywords, random, image_duration, video_duration } for the running daemon, or
// {} when none apply
export async function readNextFilters(runtimeDir) {
  const state = await readState(runtimeDir);
  if (!state) return {};
  try {
    const { pid, ...stored } = await fs.readJson(nextFiltersPath(runtimeDir));
    return pid === state.pid ? stored : {};
  } catch {
    return {};
  }
}

export async function clearNextFilters(runtimeDir) {
  await fs.remove(nextFiltersPath(runtimeDir));
}

export function hasNextFilters(stored) {
  return FILTER_KEYS.some(key => stored[key]?.length) || stored.random !== undefined
    || Object.keys(DURATIONS).some(key => stored[key] !== undefined);
}

// Seconds from "90", "90s", "1.5m" or "2h"; images need more than 0, videos take 0 to loop forever
export function parseDuration(option, text, { allowZero = false } = {}) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(text).trim());
  const seconds = match ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] ?? 's'] : NaN;
  if (!(seconds > 0 || (allowZero && seconds === 0))) {
    throw new Error(`${option} must be a time such as 90, 90s, 5m or 1h${allowZero ? ' (0 loops videos forever)' : ''}, not ${text}`);
  }
  return seconds;
}

// options with the stored values filling in what the command line left out. With persist (next and
// menu), --clear drops the stored values first, filters given replace the stored filters as a set,
// --random/--no-random replace the stored order and each duration given replaces its stored one; the
// result is written for the running daemon, which applies changed durations at once (kill and timeout
// are passed to sendControl).
export async function resolveNextFilters(runtimeDir, options = {}, { persist = false, ...control } = {}) {
  const durations = {};
  if (options.imageDuration !== undefined) durations.image_duration = parseDuration('--image-duration', options.imageDuration);
  if (options.videoDuration !== undefined) durations.video_duration = parseDuration('--video-duration', options.videoDuration, { allowZero: true });

  const before = await readNextFilters(runtimeDir);
  if (persist && options.clear) await clearNextFilters(runtimeDir);
  const stored = persist && options.clear ? {} : before;
  const given = FILTER_KEYS.some(key => options[key]?.length);
  const resolved = {
    ...(given ? pick(options, FILTER_KEYS) : pick(stored, FILTER_KEYS)),
    random: options.random ?? stored.random,
    ...pick(stored, Object.keys(DURATIONS)),
    ...durations
  };
  if (persist) {
    const state = await readState(runtimeDir);
    if (state && (given || options.random !== undefined || Object.keys(durations).length)) {
      await writeNextFilters(runtimeDir, state.pid, resolved);
    }
    const changed = Object.keys(DURATIONS).some(key => before[key] !== resolved[key]);
    if (state && changed) await sendControl(runtimeDir, state, { durations: true }, control);
  }
  return { ...options, ...resolved };
}

async function writeNextFilters(runtimeDir, pid, values) {
  const file = nextFiltersPath(runtimeDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeJson(temporary, { pid, ...pick(values, [...FILTER_KEYS, 'random', ...Object.keys(DURATIONS)]) });
  await fs.rename(temporary, file);
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined && (!Array.isArray(source[key]) || source[key].length))
    .map(key => [key, source[key]]));
}
