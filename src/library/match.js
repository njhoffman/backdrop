import { DISPLAY_STATUSES } from '../display/Playlist.js';
import { closestMatches } from '../utils/closest.js';

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
      const closest = closestMatches(text, known);
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

// The displayable items the --query/--tag/--keywords filters in options match, for next and the
// advances after rating; null without filters
export function matchingMedia(database, options) {
  const filters = matchFilters(database, options);
  if (!hasMatchFilters(filters)) return null;
  return database.findMedia({ ...filters, downloaded: true, status: DISPLAY_STATUSES });
}
