import { DISPLAY_STATUSES } from '../display/Playlist.js';

// --query, --tag and --keywords as findMedia filters. Queries match a saved search exactly, ignoring case,
// and any of them may match; tags and keywords must all match. A query no search used is an error that
// names the closest saved queries, so a typo does not read as an empty result.
export function matchFilters(database, { query, tag, keywords } = {}) {
  const filters = {};
  if (query?.length) {
    const known = database.getSearchQueries();
    const lowered = new Set(known.map(text => text.toLowerCase()));
    for (const text of query) {
      if (lowered.has(text.toLowerCase())) continue;
      const closest = closestQueries(text, known);
      throw new Error(`No search used the query "${text}"`
        + (closest.length ? `; closest: ${closest.map(item => `"${item}"`).join(', ')}` : known.length ? '' : '; run a search first'));
    }
    filters.queries = query;
  }
  if (tag?.length) filters.tags = tag;
  if (keywords?.length) filters.keywords = keywords;
  return filters;
}

export function hasMatchFilters(filters) {
  return Boolean(filters.queries || filters.tags || filters.keywords);
}

// Saved queries nearest to text by edit distance, ignoring case; containment counts as closest
export function closestQueries(text, known, limit = 3) {
  const target = text.toLowerCase();
  return known
    .map(query => {
      const lower = query.toLowerCase();
      const distance = lower.includes(target) || target.includes(lower) ? 0 : editDistance(target, lower);
      return { query, distance };
    })
    .filter(({ query, distance }) => distance <= Math.max(2, Math.floor(Math.max(query.length, text.length) / 2)))
    .sort((a, b) => a.distance - b.distance || a.query.localeCompare(b.query))
    .slice(0, limit)
    .map(({ query }) => query);
}

export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

// The displayable items the --query/--tag/--keywords filters in options match, for next and the
// advances after rating; null without filters
export function matchingMedia(database, options) {
  const filters = matchFilters(database, options);
  if (!hasMatchFilters(filters)) return null;
  return database.findMedia({ ...filters, downloaded: true, status: DISPLAY_STATUSES });
}
