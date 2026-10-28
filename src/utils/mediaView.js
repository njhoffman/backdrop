import { out, fmt, icon, mark, describeMedia, displayPath, formatQueries, formatRating } from './output.js';

// Prints a media item as a heading line plus indented path, query and credit lines:
//   ✓ #412  ▶ video  ⤢ 3840×2160  ◷ 0:18  landscape  ★★☆ landscape
//       ↳ ~/.local/share/backdrop/inbox/remote-412.mp4
//       ⌕ "ocean waves", "aerial coast"
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
  const credit = [media.author, media.page_url && fmt.dim(`${icon('link')}${media.page_url}`)].filter(Boolean);
  if (credit.length) out.field('author', credit.join('  '));
}
