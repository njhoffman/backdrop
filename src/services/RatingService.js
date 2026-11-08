import fs from 'fs-extra';
import path from 'path';
import { DisplayControl } from '../display/DisplayControl.js';
import { resolveNextFilters } from '../display/nextFilters.js';
import { queueMatching, randomOrder } from '../display/Playlist.js';
import { matchingMedia } from '../library/match.js';
import { notifyCommand } from '../utils/notify.js';

// Rating, skipping, undoing and the advances after them, returning what changed rather than printing it, for the
// CLI (RatingCommand), the menu and the web interface (docs/specs/web.md, D6). Playlist updates that fail after a
// change committed do not fail it: they are logged and returned as warnings for the caller to show.
//
// A step that fails after a rating committed (keep --next's advance, skip's switch) throws with the work already
// done on the error, error.done = { rated, warnings }, so a caller can report the rating before the failure.
export class RatingService {
  constructor({ config, database, logger, control }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.control = control ?? new DisplayControl({ config, database });
  }

  // The playing item on options.monitor (or the monitor under the pointer): { monitor, path, media, rating }
  async current(options = {}) {
    const current = await this.control.current(options.monitor);
    if (!current.media) throw new Error(`Nothing from the library is playing on ${current.monitor.name}`);
    return current;
  }

  // Keeps the playing item at rating (1-3); with options.next, then plays the next item.
  // Returns { rated, warnings, playing }, playing being null without next.
  async keep(rating = 1, options = {}) {
    if (!/^[1-3]$/.test(String(rating))) throw new Error('Rating must be an integer from 1 to 3');
    const { media, monitor } = await this.current(options);
    if (options.next) options = await this.nextOptions(options);
    // Checked before rating so a bad display.order does not leave a rating without the advance
    const random = options.next && this.random(options);
    const { media: rated, warnings } = await this.rate(media, Number(rating), resolutionOf(monitor));
    if (!options.next) return { rated, warnings, playing: null, options };
    try {
      return { rated, warnings, playing: await this.advance(monitor, options, random), options };
    } catch (error) {
      throw withDone(error, { rated, warnings });
    }
  }

  // Skips the playing item. Removing its entry advances mpv to the next entry of the shuffled playlist; with filters
  // stored by next or the menu, a matching entry goes first when there is one (any matching one with random).
  // Returns { rated, warnings, playing, options }.
  async skip(options = {}) {
    const { media, monitor } = await this.current(options);
    options = await this.nextOptions(options);
    const random = this.random(options);
    const matches = matchingMedia(this.database, options);
    let done = null;
    try {
      const playing = await this.control.switchTo(monitor.name, async client => {
        if (matches) await queueMatching(client, new Set(matches.map(item => item.path)), { random });
        const result = await this.rate(media, 0, resolutionOf(monitor));
        done = { rated: result.media, warnings: result.warnings };
        return result.media;
      });
      await this.announce(playing);
      return { ...done, playing, options };
    } catch (error) {
      throw done ? withDone(error, done) : error;
    }
  }

  // The filters and order next and the menu stored; random or no-random here apply to this advance only
  nextOptions(options) {
    return resolveNextFilters(this.config.get().paths.runtime, options);
  }

  random(options) {
    return randomOrder(this.config.get().display, options.random);
  }

  // Plays the next item on monitor and announces it. Filters pick it when one matches; otherwise the advance goes
  // on as without them. Returns what the monitor plays now.
  async advance(monitor, options, random = this.random(options)) {
    const matches = matchingMedia(this.database, options);
    const playing = await this.control.next(monitor.name, matches ? { random, matches, fallback: true } : { random });
    await this.announce(playing);
    return playing;
  }

  // The desktop notification for what a monitor plays after a command switched it (display.notify)
  async announce(playing) {
    await notifyCommand(this.config, this.database, playing, { logger: this.logger });
  }

  // Rates an item and moves its file: to the trash for 0, into the library for 1-3. Returns { media, warnings }.
  async rate(media, rating, resolution = null) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 3) throw new Error('Rating must be an integer from 0 to 3');
    if (!media.path) throw new Error('Download this item before rating it');
    const { paths } = this.config.get();
    const target = path.join(rating === 0 ? paths.trash : paths.media, path.basename(media.path));
    if (rating === 0) await this.control.removeMedia(media);
    try {
      await this.moveAndCommit(media.path, target, () => {
        const latest = this.database.getMedia(media.id);
        if (!latest || latest.path !== media.path) throw new Error('Media changed while rating; try again');
        this.database.addRating(media.id, rating, resolution, { previousPath: media.path, ratedPath: target });
        this.database.updateMedia(media.id, { path: target });
      });
    } catch (error) {
      if (rating === 0) await this.control.appendMedia([media.id]).catch(() => {});
      throw error;
    }
    const warnings = [];
    await this.syncPlayback(media, target, rating === 0, warnings);
    this.logger.info('Media rated', { mediaId: media.id, rating });
    return { media: this.database.getMedia(media.id), warnings };
  }

  // File moves cannot join SQLite transactions. Restore the old path if the write fails.
  async moveAndCommit(from, to, commit) {
    const moved = from !== to;
    if (moved) await fs.move(from, to, { overwrite: false });
    else await fs.access(from);
    try {
      return this.database.transaction(commit);
    } catch (error) {
      if (moved) await fs.move(to, from, { overwrite: false });
      throw error;
    }
  }

  async syncPlayback(previous, target, removed, warnings) {
    try {
      if (removed) return;
      if (target !== previous.path) await this.control.refreshMedia(previous);
      await this.control.appendMedia([previous.id]);
    } catch (error) {
      this.playbackWarning(error, warnings);
    }
  }

  // A disconnected display must not suggest retrying a rating change that already committed
  playbackWarning(error, warnings) {
    this.logger.warn('Rating change saved but playlist update failed', { error: error.message });
    warnings.push(`Rating change saved; playlist update failed: ${error.message}`);
  }

  // Undoes the latest rating, moving the file back. discard drops it from undo history instead, leaving the item and
  // its files as they are, for a rating whose file can no longer be restored.
  // Returns { action: 'none' | 'discarded' | 'undone', rating, media, warnings }.
  async undo({ discard = false } = {}) {
    const rating = this.database.getLastRating();
    if (!rating) return { action: 'none', rating: null, media: null, warnings: [] };
    if (discard) {
      this.database.finalizeRating(rating.id);
      return { action: 'discarded', rating, media: this.database.getMedia(rating.media_id), warnings: [] };
    }
    // Failures that retrying cannot fix would otherwise block every later undo
    const stuck = message => new Error(`${message}; \`backdrop undo --discard\` drops this rating from undo history`);
    const previous = this.database.getMedia(rating.media_id);
    if (!previous?.path) {
      throw stuck(previous?.status === 'skipped' && rating.rating === 0
        ? `#${rating.media_id} was purged from trash; its file cannot be restored`
        : `#${rating.media_id} has no downloaded file to restore`);
    }
    const preceding = this.database.getLatestRating(previous.id, rating.id);
    const { paths } = this.config.get();
    const directory = preceding ? (preceding.rating === 0 ? paths.trash : paths.media) : paths.inbox;
    const target = rating.previous_path ?? path.join(directory, path.basename(previous.path));
    if (rating.rated_path && previous.path !== rating.rated_path) throw stuck(`#${previous.id} moved since this rating`);
    let result;
    try {
      await this.moveAndCommit(previous.path, target, () => {
        if (this.database.getMedia(previous.id)?.path !== previous.path) throw new Error('Media changed while undoing; try again');
        result = this.database.undoLastRating(rating.id);
        this.database.updateMedia(previous.id, { path: target });
      });
    } catch (error) {
      // A missing file or an occupied destination: the file system, not a race
      if (error.code === 'ENOENT' || /already exists/.test(error.message)) throw stuck(error.message);
      throw error;
    }
    const warnings = [];
    if (result.media.status === 'skipped') {
      try { await this.control.removeMedia(previous); } catch (error) { this.playbackWarning(error, warnings); }
    } else {
      await this.syncPlayback(previous, target, false, warnings);
    }
    return { action: 'undone', rating, media: this.database.getMedia(previous.id), warnings };
  }

  // Plays the next item once the playing one is rated. Returns { media, playing, options }.
  async goNext(options = {}) {
    const { media, monitor, rating } = await this.current(options);
    if (!rating) throw new Error('Rate this item with keep or skip before go-next');
    options = await this.nextOptions(options);
    return { media, playing: await this.advance(monitor, options), options };
  }
}

function resolutionOf(monitor) {
  return `${monitor.width}x${monitor.height}`;
}

function withDone(error, done) {
  error.done = done;
  return error;
}
