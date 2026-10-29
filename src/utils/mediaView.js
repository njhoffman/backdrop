import {
  out, fmt, icon, mark, describeMedia, displayPath, formatQueries, formatRating, formatStars, formatResolution,
  formatClock, formatFps, formatCpu, formatDecoder, formatDuration, orientationName, padVisible, isInteractive
} from './output.js';

// Prints a media item as a heading line plus indented path, query and credit lines:
//   ✓ #412  ▶ video  ⤢ 3840×2160  ◷ 0:18  25fps  landscape  ★★☆ landscape
//       ↳ ~/.local/share/backdrop/inbox/remote-412.mp4
//       ⌕ "ocean waves", "aerial coast"
//       # ocean, waves, aerial
//       ✎ Jane Doe  ↗ https://www.pexels.com/video/...
// tone adds a status symbol; rating (or null for unrated) adds stars; extra is appended to the heading.
export function printMedia(database, media, { tone, rating, extra = [], path = true } = {}) {
  const parts = [`${tone ? mark(tone) : ''}${fmt.bold(`#${media.id}`)}`, describeMedia(media)];
  if (media.source !== 'local') parts.push(fmt.dim(media.source));
  if (rating !== undefined) parts.push(formatRating(rating));
  parts.push(...extra.filter(Boolean));
  out.print(parts.join('  '));
  if (path && media.path) out.field('path', displayPath(media.path));
  const queries = database.getQueries(media.id);
  if (queries.length) out.field('query', formatQueries(queries));
  const tags = database.getTags(media.id);
  if (tags.length) out.field('tag', fmt.dim(tags.join(', ')));
  const credit = [media.author, media.page_url && fmt.dim(`${icon('link')}${media.page_url}`)].filter(Boolean);
  if (credit.length) out.field('author', credit.join('  '));
}

// Average CPU of an item while it played, e.g. "cpu 4.1% over 12m30s, vaapi"; empty until sampled
export function formatPlaybackCost(stats) {
  if (!stats?.seconds) return '';
  const decoder = formatDecoder(stats.hwdec);
  return `cpu ${formatCpu((stats.cpu_seconds / stats.seconds) * 100)} over ${formatDuration(stats.seconds)}${decoder ? `, ${decoder}` : ''}`;
}

// Stored playback changes, e.g. "speed 0.8, dim 20"; empty when there are none
export function formatAdjustments(media) {
  return [media.speed !== 1 && `speed ${media.speed}`, media.dim && `dim ${media.dim}`].filter(Boolean).join(', ');
}

// Fixed widths, so lines printed by separate commands still line up:
// id, kind, resolution, running time, frame rate, orientation, rating, source, adjustments, then the path
const LINE_WIDTHS = [7, 7, 9, 7, 8, 9, 7, 8, 17];

// One line per item for fzf or a table. Aligned and styled on a terminal; tab-separated when piped
// (fzf --delimiter '\t'), keeping colors only with FORCE_COLOR (fzf --ansi). Empty fields stay in place.
export function formatMediaLine(media, { rating } = {}) {
  const fields = [
    fmt.bold(`#${media.id}`),
    `${icon(media.kind)}${fmt.cyan(media.kind)}`,
    formatResolution(media.width, media.height),
    media.kind !== 'image' && Number.isFinite(media.duration) ? formatClock(media.duration) : '',
    media.kind !== 'image' ? formatFps(media.fps) : '',
    fmt.dim(orientationName(media) ?? ''),
    formatStars(rating),
    fmt.dim(media.source),
    fmt.dim(formatAdjustments(media)),
    displayPath(media.path)
  ];
  if (!isInteractive()) return fields.join('\t');
  return fields.map((field, index) => (index < LINE_WIDTHS.length ? padVisible(field, LINE_WIDTHS[index]) : field))
    .join('  ').trimEnd();
}

// What a monitor plays after a command switched it: the full block, or one line with --line
export function printPlaying(database, { monitor, path, media, rating }, { line = false } = {}) {
  if (!path) {
    out.info(`${monitor.name}: nothing playing`);
  } else if (!media) {
    out.print(displayPath(path));
  } else if (line) {
    out.print(formatMediaLine(media, { rating }));
  } else {
    printMedia(database, media, {
      rating, extra: [fmt.dim(formatAdjustments(media)), fmt.dim(`${icon('monitor')}${monitor.name}`)]
    });
  }
}
