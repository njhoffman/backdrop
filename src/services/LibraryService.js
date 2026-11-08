import { contrastFor, MODE_KINDS } from '../display/Playlist.js';
import { parseBounce, parseDim, parseSpeed } from '../display/DisplayControl.js';
import { matchFilters } from '../library/match.js';
import { mediaJson } from '../utils/mediaView.js';
import { notifyCommand } from '../utils/notify.js';
import { RatingService } from './RatingService.js';

// The library as the web interface's Library page sees it (docs/specs/web.md): pages of downloaded items with the
// list commands' filters, one item's details, and changes to any item, playing or not: a rating, its speed, dim and
// bounce (applied at once on a monitor playing it), and playing it on a monitor. Returns data, as the other services.

export const LIBRARY_KINDS = { all: undefined, video: MODE_KINDS.video, image: MODE_KINDS.image };
export const LIBRARY_STATUSES = { shown: ['new', 'kept'], new: ['new'], kept: ['kept'], skipped: ['skipped'], all: undefined };
// The orders the page offers, findMedia's (MEDIA_ORDERS): the database sorts and pages, so a page reads only its rows
const SORTS = { newest: 'newest', oldest: 'oldest', largest: 'largest', rating: 'rating', played: 'played', cost: 'cost' };
export const LIBRARY_SORTS = Object.keys(SORTS);
const PER_PAGE = 48;
const MAX_PER_PAGE = 100;

export class LibraryService {
  constructor({ config, database, logger, control, rating }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.control = control;
    this.rating = rating ?? new RatingService({ config, database, logger, control });
  }

  // One page of downloaded items: { total, page, per_page, items } with items as mediaJson. kind is all, video (with
  // GIFs) or image; status is shown (new and kept, the default), new, kept, skipped or all; min_rating 1-3; query, tag
  // and keywords as the list commands take them (an unknown query is an error naming the closest); sort is newest
  // (the default), oldest, largest, rating (highest first), played (last played first) or cost (most CPU first).
  list({ kind = 'all', status = 'shown', min_rating: minRating, query, tag, keywords, sort = 'newest', page = 1, per_page: perPage = PER_PAGE } = {}) {
    const choose = (table, value, name) => {
      if (!Object.hasOwn(table, value)) throw new Error(`Unknown ${name}: ${value} (use ${Object.keys(table).join(', ')})`);
      return table[value];
    };
    const filters = { downloaded: true, ...matchFilters(this.database, { query, tag, keywords }) };
    const kinds = choose(LIBRARY_KINDS, kind, 'kind');
    const statuses = choose(LIBRARY_STATUSES, status, 'status');
    if (kinds) filters.kind = kinds;
    if (statuses) filters.status = statuses;
    if (minRating !== undefined && minRating !== null && minRating !== '') {
      const value = Number(minRating);
      if (![1, 2, 3].includes(value)) throw new Error('min_rating must be 1, 2 or 3');
      filters.minRating = value;
    }
    const order = choose(SORTS, sort, 'sort');
    const size = Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(Number(perPage)) || PER_PAGE));
    const total = this.database.countMedia(filters);
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(pages, Math.max(1, Math.trunc(Number(page)) || 1));
    const shown = this.database.findMedia({ ...filters, order, limit: size, offset: (current - 1) * size });
    return { total, page: current, pages, per_page: size, items: shown.map(media => mediaJson(this.database, media)) };
  }

  // What the filters offer: the most common tags and every saved search's query
  facets() {
    return { tags: this.database.getTagCounts(60), queries: this.database.getSearchQueries() };
  }

  item(id) {
    return mediaJson(this.database, this.require(id));
  }

  require(id) {
    const media = this.database.getMedia(Number(id));
    if (!media) throw Object.assign(new Error(`No library item #${id}`), { status: 404 });
    return media;
  }

  // Rates any item: 0 skips it into the trash, 1-3 keeps it. Returns { item, warnings }.
  async rate(id, rating) {
    const value = Number(rating);
    if (![0, 1, 2, 3].includes(value)) throw new Error('Rating must be 0 (skip) or 1 to 3');
    const { media, warnings } = await this.rating.rate(this.require(id), value);
    return { item: mediaJson(this.database, media), warnings };
  }

  // Changes an item's speed, dim and bounce ({ speed?, dim?, bounce? }, each as the commands take it) and stores
  // them; a monitor playing the item takes speed and dim at once, and the daemon swaps its entries for a bounce.
  // Returns the item.
  async adjust(id, { speed, dim, bounce } = {}) {
    const media = this.require(id);
    const video = MODE_KINDS.video.includes(media.kind);
    const changes = {};
    if (speed !== undefined) {
      if (!video) throw new Error('Speed only applies to videos and GIFs');
      changes.speed = parseSpeed(String(speed), media.speed);
    }
    if (dim !== undefined) changes.dim = parseDim(String(dim), media.dim);
    if (bounce !== undefined) {
      if (!video) throw new Error('Bounce only applies to videos and GIFs');
      changes.bounce = parseBounce(String(bounce), media, this.config.get().display);
    }
    if (!Object.keys(changes).length) throw new Error('Give speed, dim or bounce');
    this.database.updateMedia(media.id, changes);
    await this.applyLive(media.id, changes);
    return mediaJson(this.database, this.database.getMedia(media.id));
  }

  // Applies a change on each monitor playing the item now; a display that does not answer keeps the stored change
  async applyLive(id, changes) {
    const state = await this.control.state({ required: false });
    if (!state) return;
    const { paths } = this.config.get();
    for (const monitor of (state.monitors ?? []).filter(item => item.socket)) {
      try {
        const current = await this.control.current(monitor.name);
        if (current.media?.id !== id) continue;
        await this.control.withClient(current.monitor, async client => {
          if (changes.speed !== undefined) await client.setProperty('speed', changes.speed);
          if (changes.dim !== undefined) {
            await client.setProperty('contrast', contrastFor(Math.max(changes.dim, state.visualizer?.musicDim ?? 0)));
          }
        });
      } catch (error) {
        this.logger.warn('Change stored but not applied on a monitor', { monitor: monitor.name, error: error.message });
      }
    }
    if (changes.bounce !== undefined) await this.control.send(paths.runtime, state, { bounce: id }, { logfile: paths.logfile });
    // A smoothed copy is made for a speed (display.smooth)
    if (changes.speed !== undefined) await this.control.send(paths.runtime, state, { item: id }, { logfile: paths.logfile });
  }

  // Plays the item on a monitor now, when that monitor's playlist has it (the mode and size decide), and announces
  // it as next does. Returns what the monitor plays.
  async play(id, monitor) {
    const media = this.require(id);
    const playing = await this.control.next(monitor, { matches: [media] });
    await notifyCommand(this.config, this.database, playing, { logger: this.logger });
    return playing;
  }
}
