import fs from 'fs-extra';
import path from 'path';
import { readState } from '../display/Daemon.js';
import { MODES, eligibleMedia } from '../display/Playlist.js';

// What `backdrop stats` shows, as data, for the CLI (StatsCommand prints it, or --json) and the web interface's Status
// page: the library by kind and status, ratings, resolutions, sources, searches, recent activity, storage, what each
// monitor can show, playback cost and the last API quota seen. Works offline; the monitors need the running daemon.

export const KINDS = ['video', 'gif', 'image'];
const RESOLUTION_BUCKETS = ['8K', '4K', '1440p', '1080p', 'smaller', 'unknown'];
export const RECENT_DAYS = 7;

// Files and bytes under a directory; a missing directory counts as empty
export async function directoryUsage(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { files: 0, bytes: 0 };
    throw error;
  }
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      bytes += (await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
      files++;
    } catch {
      // removed while counting
    }
  }
  return { files, bytes };
}

// SQLite CURRENT_TIMESTAMP format (UTC), for comparing against stored timestamps
export function sqliteTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export class StatsService {
  constructor({ config, database, now = () => new Date() }) {
    this.config = config;
    this.database = database;
    this.now = now;
  }

  // Every section; raw holds getStats() and getDetailedStats() as the database gives them
  async collect() {
    const stats = this.database.getStats();
    const since = sqliteTime(new Date(this.now().getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000));
    const detail = this.database.getDetailedStats({ since });
    return {
      library: this.library(stats, detail),
      ratings: this.ratings(stats, detail),
      resolutions: this.resolutions(detail),
      sources: detail.sources,
      queries: detail.queries,
      recent: { days: RECENT_DAYS, ...detail.recent, searches_all_time: stats.searches, duplicates: stats.duplicates },
      storage: await this.storage(),
      monitors: await this.monitors(),
      playback: this.database.getPlaybackCost(),
      quota: this.quota(),
      raw: { stats, detail }
    };
  }

  // { kinds: [{ kind, total, new, kept, skipped, pending, duration }], total }; pending items are new but not
  // downloaded, so they leave the new column
  library(stats, detail) {
    const extra = Object.fromEntries(detail.kinds.map(row => [row.kind, row]));
    const total = { kind: 'total', total: 0, new: 0, kept: 0, skipped: 0, pending: 0, duration: 0 };
    const kinds = KINDS.map(kind => {
      const { pending = 0, duration = 0 } = extra[kind] ?? {};
      const counts = { kind, new: stats.media[kind].new - pending, kept: stats.media[kind].kept, skipped: stats.media[kind].skipped, pending, duration };
      counts.total = counts.new + counts.kept + counts.skipped;
      for (const key of ['total', 'new', 'kept', 'skipped', 'pending', 'duration']) total[key] += counts[key];
      return counts;
    });
    return { kinds, total };
  }

  // { byRating: [skipped, 1, 2, 3], rated, orientations: { landscape, portrait }, changes, last }
  ratings(stats, detail) {
    const byRating = [0, 0, 0, 0];
    const orientations = { landscape: 0, portrait: 0 };
    for (const row of detail.ratings) {
      byRating[row.rating] += row.count;
      if (row.rating > 0) orientations[row.orientation] += row.count;
    }
    return { byRating, rated: byRating[1] + byRating[2] + byRating[3], orientations, changes: stats.ratings, last: detail.lastRating ?? null };
  }

  // [{ bucket, count }], 8K and unknown only when there are some
  resolutions(detail) {
    const counts = Object.fromEntries(detail.resolutions.map(row => [row.bucket, row.count]));
    return RESOLUTION_BUCKETS.filter(bucket => counts[bucket] || !['unknown', '8K'].includes(bucket))
      .map(bucket => ({ bucket, count: counts[bucket] ?? 0 }));
  }

  // { dirs: [{ name, path, files, bytes }], bytes, trashDays }
  async storage() {
    const { paths, library } = this.config.get();
    const dirs = [];
    for (const name of ['media', 'inbox', 'trash']) dirs.push({ name, path: paths[name], ...await directoryUsage(paths[name]) });
    return { dirs, bytes: dirs.reduce((sum, dir) => sum + dir.bytes, 0), trashDays: library.trash_days };
  }

  // [{ name, width, height, eligible: { video, image } }], or null while the daemon is stopped: only it knows the sizes
  async monitors() {
    const state = await readState(this.config.get().paths.runtime);
    if (!state) return null;
    const { allow_upscale: allowUpscale } = this.config.get().display;
    return state.monitors.map(monitor => ({
      name: monitor.name, width: monitor.width, height: monitor.height,
      eligible: Object.fromEntries(MODES.map(mode => [mode, eligibleMedia(this.database, mode, monitor, { allowUpscale }).length]))
    }));
  }

  // { source, remaining, limit, reset } from the last Pexels response, or null
  quota() {
    const limits = this.database.getSetting('source_rate_limit:pexels');
    return limits ? { source: 'pexels', remaining: limits.remaining ?? null, limit: limits.limit ?? null, reset: limits.reset ?? null } : null;
  }
}
