import { MODES } from '../display/Playlist.js';
import { StatsService, directoryUsage, sqliteTime } from '../services/StatsService.js';
import {
  out, fmt, icon, isInteractive, colorDepth, symbolSet, SYMBOL_SETS, renderBar, stackedBar, formatTable,
  formatDuration, formatBytes, formatStars, formatResolution, displayPath, formatCpu
} from '../utils/output.js';
import { formatPlaybackCost, wantsJson } from '../utils/mediaView.js';

export { directoryUsage };

const BAR_WIDTH = 24;

// `backdrop stats`: StatsService collects, this prints, or with --json gives it as one document (raw left out)
export class StatsCommand {
  constructor(config, database, logger, { now = () => new Date() } = {}) {
    this.config = config;
    this.database = database;
    this.service = new StatsService({ config, database, now });
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

  async showStats(options = {}) {
    const data = await this.service.collect();
    const { raw, ...shown } = data;
    if (wantsJson(options)) {
      out.json(shown);
    } else {
      this.library(data.library);
      this.ratings(data.ratings);
      this.resolutions(data.resolutions);
      this.sources(data.sources);
      this.queries(data.queries);
      this.activity(data.recent);
      this.storage(data.storage);
      this.monitors(data.monitors);
      this.playbackCost(data.playback);
      this.quota(data.quota);
    }
    return { ...raw.stats, detail: raw.detail };
  }

  library({ kinds, total }) {
    const rows = [[fmt.dim('kind'), fmt.dim('total'), fmt.dim('new'), fmt.dim('kept'), fmt.dim('skipped'),
      fmt.dim('pending'), fmt.dim('playing time'), '']];
    for (const counts of kinds) rows.push(this.libraryRow(`${icon(counts.kind)}${fmt.cyan(counts.kind)}`, counts, counts.kind !== 'image'));
    rows.push(this.libraryRow(fmt.bold('total'), total, true));
    this.section('Library', rows, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'] });
    if (isInteractive()) {
      out.detail(`bar: ${fmt.green('kept')} ${fmt.cyan('new')} ${fmt.red('skipped')}; pending items are saved by searches, not downloaded`);
    }
  }

  libraryRow(label, counts, timed) {
    const bar = isInteractive() ? stackedBar([
      { value: counts.kept, style: 'green' }, { value: counts.new, style: 'cyan' }, { value: counts.skipped, style: 'red' }
    ], BAR_WIDTH) : '';
    return [label, fmt.bold(counts.total), counts.new, fmt.green(counts.kept), fmt.red(counts.skipped), fmt.yellow(counts.pending),
      timed && counts.duration ? formatDuration(counts.duration) : fmt.dim('-'), bar];
  }

  ratings({ byRating, rated, orientations, changes, last }) {
    const rows = [3, 2, 1].map(rating => [formatStars({ rating }), byRating[rating], percent(byRating[rating], rated),
      this.bar(rated ? byRating[rating] / rated : 0)]);
    rows.push([formatStars({ rating: 0 }), byRating[0], '', '']);
    this.section('Ratings (current, per item)', rows, { align: ['l', 'r', 'r'] });
    const parts = [`${orientations.landscape} landscape`, `${orientations.portrait} portrait`, `${changes} rating changes`];
    if (last) parts.push(`last ${last.slice(0, 16)} UTC`);
    out.detail(parts.join(', '));
  }

  resolutions(buckets) {
    const total = buckets.reduce((sum, { count }) => sum + count, 0);
    const rows = buckets.map(({ bucket, count }) => [bucket, count, percent(count, total), this.bar(total ? count / total : 0)]);
    this.section('Resolution (downloaded, not skipped; by short side)', rows, { align: ['l', 'r', 'r'] });
  }

  sources(sources) {
    if (!sources.length) return;
    const rows = [[fmt.dim('source'), fmt.dim('items'), fmt.dim('downloaded'), fmt.dim('kept'), fmt.dim('skipped'),
      fmt.dim('pending'), fmt.dim('avg rating')]];
    for (const row of sources) {
      rows.push([fmt.cyan(row.source), row.total, row.downloaded, fmt.green(row.kept), fmt.red(row.skipped),
        fmt.yellow(row.pending), row.average ? row.average.toFixed(1) : fmt.dim('-')]);
    }
    this.section('Sources', rows, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'] });
  }

  queries(queries) {
    if (!queries.length) return;
    const rows = [[fmt.dim('query'), fmt.dim('results'), fmt.dim('downloaded'), fmt.dim('kept')]];
    for (const row of queries) {
      rows.push([`${icon('query')}"${row.query}"`, row.results, row.downloaded, fmt.green(row.kept)]);
    }
    this.section('Top searches', rows, { align: ['l', 'r', 'r', 'r'] });
  }

  activity(recent) {
    const rows = [
      [`${icon('download')}added`, recent.added],
      [`${icon('star')}ratings`, recent.ratings],
      [`${icon('query')}searches`, recent.searches]
    ];
    this.section(`Last ${recent.days} days`, rows, { align: ['l', 'r'] });
    const totals = [`all time: ${recent.searches_all_time} ${recent.searches_all_time === 1 ? 'search' : 'searches'}`];
    if (recent.duplicates) totals.push(`${recent.duplicates} duplicate downloads detected`);
    out.detail(totals.join(', '));
  }

  storage({ dirs, bytes, trashDays }) {
    const rows = dirs.map(dir => [
      dir.name, `${dir.files} files`, formatBytes(dir.bytes), this.bar(bytes ? dir.bytes / bytes : 0), fmt.dim(displayPath(dir.path))
    ]);
    rows.push([fmt.bold('total'), '', fmt.bold(formatBytes(bytes)), '', '']);
    this.section('Storage', rows, { align: ['l', 'r', 'r'] });
    out.detail(trashDays
      ? `trash files are purged ${trashDays} days after they were skipped`
      : 'trash purging is off (library.trash_days: 0)');
  }

  // Eligible counts need the monitor sizes, which only the running daemon knows
  monitors(monitors) {
    if (!monitors) return;
    const rows = [[fmt.dim('monitor'), fmt.dim('size'), ...MODES.map(mode => fmt.dim(`${mode}s`))]];
    for (const monitor of monitors) {
      rows.push([`${icon('monitor')}${fmt.bold(monitor.name)}`, formatResolution(monitor.width, monitor.height),
        ...MODES.map(mode => monitor.eligible[mode])]);
    }
    this.section('Eligible on each monitor', rows, { align: ['l', 'l', 'r', 'r'] });
  }

  // Average mpv CPU (percent of one core) while items played, from the daemon's samples
  playbackCost({ groups, expensive, software }) {
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

  quota(quota) {
    if (!quota) return;
    const { remaining, limit, reset } = quota;
    const rows = [['pexels', `${remaining ?? '?'} / ${limit ?? '?'}`,
      limit && Number.isFinite(remaining) ? this.bar(remaining / limit) : '',
      fmt.dim(`reset ${reset ? `${sqliteTime(new Date(reset * 1000)).slice(0, 16)} UTC` : 'unknown'}`)]];
    this.section('API quota (last response)', rows, { align: ['l', 'r'] });
  }
}

function percent(count, total) {
  return total ? fmt.dim(`${Math.round((count / total) * 100)}%`) : fmt.dim('-');
}
