import fs from 'fs-extra';
import path from 'path';
import { readState } from '../display/Daemon.js';
import { MODES, eligibleMedia } from '../display/Playlist.js';
import {
  out, fmt, icon, isInteractive, colorDepth, symbolSet, SYMBOL_SETS, renderBar, stackedBar, formatTable,
  formatDuration, formatBytes, formatStars, formatResolution, displayPath, formatCpu
} from '../utils/output.js';
import { formatPlaybackCost } from '../utils/mediaView.js';

const KINDS = ['video', 'gif', 'image'];
const RESOLUTION_BUCKETS = ['8K', '4K', '1440p', '1080p', 'smaller', 'unknown'];
const BAR_WIDTH = 24;
const RECENT_DAYS = 7;

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
function sqliteTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export class StatsCommand {
  constructor(config, database, logger, { now = () => new Date() } = {}) {
    this.config = config;
    this.database = database;
    this.now = now;
  }

  // Bars only on a terminal; piped output keeps the aligned numbers alone
  bar(fraction) {
    if (!isInteractive()) return '';
    return renderBar(fraction, BAR_WIDTH, { depth: colorDepth(), ascii: symbolSet() === SYMBOL_SETS.ascii });
  }

  section(title, rows, options) {
    out.print();
    out.heading(title);
    for (const line of formatTable(rows, options)) out.print(line);
  }

  async showStats() {
    const stats = this.database.getStats();
    const since = sqliteTime(new Date(this.now().getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000));
    const detail = this.database.getDetailedStats({ since });

    this.library(stats, detail);
    this.ratings(stats, detail);
    this.resolutions(detail);
    this.sources(detail);
    this.queries(detail);
    this.activity(stats, detail);
    await this.storage();
    await this.monitors();
    this.playbackCost();
    this.quota();
    return { ...stats, detail };
  }

  library(stats, detail) {
    const extra = Object.fromEntries(detail.kinds.map(row => [row.kind, row]));
    const totals = { new: 0, kept: 0, skipped: 0, pending: 0, duration: 0 };
    const rows = [[fmt.dim('kind'), fmt.dim('total'), fmt.dim('new'), fmt.dim('kept'), fmt.dim('skipped'),
      fmt.dim('pending'), fmt.dim('playing time'), '']];
    for (const kind of KINDS) {
      const { pending = 0, duration = 0 } = extra[kind] ?? {};
      // Pending items are new but not downloaded; they get their own column
      const counts = { ...stats.media[kind], new: stats.media[kind].new - pending };
      for (const key of ['new', 'kept', 'skipped']) totals[key] += counts[key];
      totals.pending += pending;
      totals.duration += duration;
      rows.push(this.libraryRow(`${icon(kind)}${fmt.cyan(kind)}`, { ...counts, pending, duration }, kind !== 'image'));
    }
    rows.push(this.libraryRow(fmt.bold('total'), totals, true));
    this.section('Library', rows, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'] });
    if (isInteractive()) {
      out.detail(`bar: ${fmt.green('kept')} ${fmt.cyan('new')} ${fmt.red('skipped')}; pending items are saved by searches, not downloaded`);
    }
  }

  libraryRow(label, counts, timed) {
    const total = counts.new + counts.kept + counts.skipped;
    const bar = isInteractive() ? stackedBar([
      { value: counts.kept, style: 'green' }, { value: counts.new, style: 'cyan' }, { value: counts.skipped, style: 'red' }
    ], BAR_WIDTH) : '';
    return [label, fmt.bold(total), counts.new, fmt.green(counts.kept), fmt.red(counts.skipped), fmt.yellow(counts.pending),
      timed && counts.duration ? formatDuration(counts.duration) : fmt.dim('-'), bar];
  }

  ratings(stats, detail) {
    const byRating = [0, 0, 0, 0];
    const orientations = { landscape: 0, portrait: 0 };
    for (const row of detail.ratings) {
      byRating[row.rating] += row.count;
      if (row.rating > 0) orientations[row.orientation] += row.count;
    }
    const rated = byRating[1] + byRating[2] + byRating[3];
    const rows = [3, 2, 1].map(rating => [formatStars({ rating }), byRating[rating], percent(byRating[rating], rated),
      this.bar(rated ? byRating[rating] / rated : 0)]);
    rows.push([formatStars({ rating: 0 }), byRating[0], '', '']);
    this.section('Ratings (current, per item)', rows, { align: ['l', 'r', 'r'] });
    const parts = [`${orientations.landscape} landscape`, `${orientations.portrait} portrait`,
      `${stats.ratings} rating changes`];
    if (detail.lastRating) parts.push(`last ${detail.lastRating.slice(0, 16)} UTC`);
    out.detail(parts.join(', '));
  }

  resolutions(detail) {
    const counts = Object.fromEntries(detail.resolutions.map(row => [row.bucket, row.count]));
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const rows = RESOLUTION_BUCKETS.filter(bucket => counts[bucket] || !['unknown', '8K'].includes(bucket))
      .map(bucket => [bucket, counts[bucket] ?? 0, percent(counts[bucket] ?? 0, total), this.bar(total ? (counts[bucket] ?? 0) / total : 0)]);
    this.section('Resolution (downloaded, not skipped; by short side)', rows, { align: ['l', 'r', 'r'] });
  }

  sources(detail) {
    if (!detail.sources.length) return;
    const rows = [[fmt.dim('source'), fmt.dim('items'), fmt.dim('downloaded'), fmt.dim('kept'), fmt.dim('skipped'),
      fmt.dim('pending'), fmt.dim('avg rating')]];
    for (const row of detail.sources) {
      rows.push([fmt.cyan(row.source), row.total, row.downloaded, fmt.green(row.kept), fmt.red(row.skipped),
        fmt.yellow(row.pending), row.average ? row.average.toFixed(1) : fmt.dim('-')]);
    }
    this.section('Sources', rows, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'] });
  }

  queries(detail) {
    if (!detail.queries.length) return;
    const rows = [[fmt.dim('query'), fmt.dim('results'), fmt.dim('downloaded'), fmt.dim('kept')]];
    for (const row of detail.queries) {
      rows.push([`${icon('query')}"${row.query}"`, row.results, row.downloaded, fmt.green(row.kept)]);
    }
    this.section('Top searches', rows, { align: ['l', 'r', 'r', 'r'] });
  }

  activity(stats, detail) {
    const { recent } = detail;
    const rows = [
      [`${icon('download')}added`, recent.added],
      [`${icon('star')}ratings`, recent.ratings],
      [`${icon('query')}searches`, recent.searches]
    ];
    this.section(`Last ${RECENT_DAYS} days`, rows, { align: ['l', 'r'] });
    const totals = [`all time: ${stats.searches} ${stats.searches === 1 ? 'search' : 'searches'}`];
    if (stats.duplicates) totals.push(`${stats.duplicates} duplicate downloads detected`);
    out.detail(totals.join(', '));
  }

  async storage() {
    const { paths, library } = this.config.get();
    const usage = {};
    for (const name of ['media', 'inbox', 'trash']) usage[name] = await directoryUsage(paths[name]);
    const total = Object.values(usage).reduce((sum, { bytes }) => sum + bytes, 0);
    const rows = Object.entries(usage).map(([name, { files, bytes }]) => [
      name, `${files} files`, formatBytes(bytes), this.bar(total ? bytes / total : 0), fmt.dim(displayPath(paths[name]))
    ]);
    rows.push([fmt.bold('total'), '', fmt.bold(formatBytes(total)), '', '']);
    this.section('Storage', rows, { align: ['l', 'r', 'r'] });
    out.detail(library.trash_days
      ? `trash files are purged ${library.trash_days} days after they were skipped`
      : 'trash purging is off (library.trash_days: 0)');
  }

  // Eligible counts need the monitor sizes, which only the running daemon knows offline
  async monitors() {
    const state = await readState(this.config.get().paths.runtime);
    if (!state) return;
    const { allow_upscale: allowUpscale } = this.config.get().display;
    const rows = [[fmt.dim('monitor'), fmt.dim('size'), ...MODES.map(mode => fmt.dim(`${mode}s`))]];
    for (const monitor of state.monitors) {
      rows.push([`${icon('monitor')}${fmt.bold(monitor.name)}`, formatResolution(monitor.width, monitor.height),
        ...MODES.map(mode => eligibleMedia(this.database, mode, monitor, { allowUpscale }).length)]);
    }
    this.section('Eligible on each monitor', rows, { align: ['l', 'l', 'r', 'r'] });
  }

  // Average mpv CPU (percent of one core) while items played, from the daemon's samples
  playbackCost() {
    const { groups, expensive, software } = this.database.getPlaybackCost();
    if (!groups.length) return;
    const rows = [[fmt.dim('kind'), fmt.dim('size'), fmt.dim('decoder'), fmt.dim('items'), fmt.dim('sampled'), fmt.dim('avg cpu')]];
    for (const row of groups) {
      rows.push([`${icon(row.kind)}${fmt.cyan(row.kind)}`, row.bucket,
        row.decoder === 'software' ? fmt.yellow(row.decoder) : row.decoder, row.items,
        formatDuration(row.seconds), formatCpu((row.cpu_seconds / row.seconds) * 100)]);
    }
    this.section('Playback cost (mpv CPU, % of one core)', rows, { align: ['l', 'l', 'l', 'r', 'r', 'r'] });
    for (const media of expensive) {
      out.detail(`#${media.id} ${formatResolution(media.width, media.height)}  `
        + formatPlaybackCost({ seconds: media.sampled_seconds, cpu_seconds: media.cpu_seconds, hwdec: media.hwdec }));
    }
    if (software) out.detail(fmt.yellow(`${software} item(s) last played with software decoding`));
  }

  quota() {
    const limits = this.database.getSetting('source_rate_limit:pexels');
    if (!limits) return;
    const { remaining, limit, reset } = limits;
    const rows = [['pexels', `${remaining ?? '?'} / ${limit ?? '?'}`,
      limit && Number.isFinite(remaining) ? this.bar(remaining / limit) : '',
      fmt.dim(`reset ${reset ? `${sqliteTime(new Date(reset * 1000)).slice(0, 16)} UTC` : 'unknown'}`)]];
    this.section('API quota (last response)', rows, { align: ['l', 'r'] });
  }
}

function percent(count, total) {
  return total ? fmt.dim(`${Math.round((count / total) * 100)}%`) : fmt.dim('-');
}
