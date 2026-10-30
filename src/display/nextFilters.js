import fs from 'fs-extra';
import { nextFiltersPath, readState } from './Daemon.js';

// --query/--tag/--keywords and --random/--no-random given to next or menu stay in effect for every later
// next and the advances after keep and skip, until next --clear or the daemon restarts. They live in the
// runtime dir tagged with the daemon's pid, so a file a crashed daemon left behind is ignored.
const FILTER_KEYS = ['query', 'tag', 'keywords'];

// The stored { query, tag, keywords, random } for the running daemon, or {} when none apply
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
  return FILTER_KEYS.some(key => stored[key]?.length) || stored.random !== undefined;
}

// options with the stored values filling in what the command line left out. With persist (next and
// menu), --clear drops the stored values first, filters given replace the stored filters as a set, and
// --random/--no-random replace the stored order; the result is written for the running daemon.
export async function resolveNextFilters(runtimeDir, options = {}, { persist = false } = {}) {
  if (persist && options.clear) await clearNextFilters(runtimeDir);
  const stored = await readNextFilters(runtimeDir);
  const given = FILTER_KEYS.some(key => options[key]?.length);
  const resolved = {
    ...(given ? pick(options, FILTER_KEYS) : pick(stored, FILTER_KEYS)),
    random: options.random ?? stored.random
  };
  if (persist && (given || options.random !== undefined)) {
    const state = await readState(runtimeDir);
    if (state) await writeNextFilters(runtimeDir, state.pid, resolved);
  }
  return { ...options, ...resolved };
}

async function writeNextFilters(runtimeDir, pid, values) {
  const file = nextFiltersPath(runtimeDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeJson(temporary, { pid, ...pick(values, [...FILTER_KEYS, 'random']) });
  await fs.rename(temporary, file);
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined && (!Array.isArray(source[key]) || source[key].length))
    .map(key => [key, source[key]]));
}
