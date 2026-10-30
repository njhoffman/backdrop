import fs from 'fs-extra';
import path from 'path';
import { DisplayControl } from '../display/DisplayControl.js';
import { resolveNextFilters } from '../display/nextFilters.js';
import { queueRandom, queueMatching, randomOrder } from '../display/Playlist.js';
import { matchingMedia } from '../library/match.js';
import { out, fmt } from '../utils/output.js';
import { printMedia, printPlaying, formatMediaLine, formatAdjustments, wantsJson, mediaJson } from '../utils/mediaView.js';
import { notifyCommand } from '../utils/notify.js';

export class RatingCommand {
  constructor(config, database, logger, { control } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.control = control ?? new DisplayControl({ config, database });
  }

  async current(options) {
    const current = await this.control.current(options.monitor);
    if (!current.media) throw new Error(`Nothing from the library is playing on ${current.monitor.name}`);
    return current;
  }

  async keep(rating = 1, options = {}) {
    if (!/^[1-3]$/.test(String(rating))) throw new Error('Rating must be an integer from 1 to 3');
    const { media, monitor } = await this.current(options);
    if (options.next) options = await this.nextOptions(options);
    // Checked before rating so a bad display.order does not leave a rating without the advance
    const random = options.next && this.random(options);
    const json = wantsJson(options);
    const rated = await this.rate(media, Number(rating), `${monitor.width}x${monitor.height}`);
    // With --next the rated item gets one line, so the full block below it is the item now playing;
    // with --json only one document is printed: the rated item, or with --next the item now playing
    if (json && !options.next) out.json({ item: mediaJson(this.database, rated) });
    else if (!json) this.printRated(rated, { line: options.line || options.next });
    if (options.next) await this.advance(monitor, options, random);
    return rated;
  }

  // The item a rating change applied to, with the rating it now has
  printRated(media, { line = false } = {}) {
    const rating = this.database.getLatestRating(media.id);
    if (line) out.print(formatMediaLine(media, { rating }));
    else printMedia(this.database, media, { rating, extra: [fmt.dim(formatAdjustments(media))] });
  }

  // Removing the playing entry advances mpv, so --random moves a random entry up to play next first.
  // With filters stored by next or the menu, a matching entry goes first when there is one.
  async skip(options = {}) {
    const { media, monitor } = await this.current(options);
    options = await this.nextOptions(options);
    const random = this.random(options);
    const matches = matchingMedia(this.database, options);
    const playing = await this.control.switchTo(monitor.name, async client => {
      const queued = matches && await queueMatching(client, new Set(matches.map(item => item.path)), { random });
      if (!queued && random) await queueRandom(client);
      return this.rate(media, 0, `${monitor.width}x${monitor.height}`);
    });
    await this.show(playing, options);
    return playing.result;
  }

  // The filters and order next and the menu stored; -r/--no-random here apply to this advance only
  nextOptions(options) {
    return resolveNextFilters(this.config.get().paths.runtime, options);
  }

  random(options) {
    return randomOrder(this.config.get().display, options.random);
  }

  // Filters pick the next item when one matches; otherwise the advance goes on as without them
  async advance(monitor, options, random = this.random(options)) {
    const matches = matchingMedia(this.database, options);
    await this.show(await this.control.next(monitor.name, matches ? { random, matches, fallback: true } : { random }), options);
  }

  // Prints and announces what a monitor plays after a command switched it
  async show(playing, options) {
    printPlaying(this.database, playing, options);
    await notifyCommand(this.config, this.database, playing, { logger: this.logger });
  }

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
    await this.syncPlayback(media, target, rating === 0);
    if (rating === 0) out.warn(`#${media.id}: skipped`);
    else out.success(`#${media.id}: kept ${rating}/3`);
    this.logger.info('Media rated', { mediaId: media.id, rating });
    return this.database.getMedia(media.id);
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

  async syncPlayback(previous, target, removed = false) {
    try {
      if (removed) return;
      if (target !== previous.path) await this.control.refreshMedia(previous);
      await this.control.appendMedia([previous.id]);
    } catch (error) {
      this.playbackWarning(error);
    }
  }

  playbackWarning(error) {
    // A disconnected display must not suggest retrying a rating change that already committed.
    this.logger.warn('Rating change saved but playlist update failed', { error: error.message });
    out.warn(`Rating change saved; playlist update failed: ${error.message}`);
  }

  // discard drops the latest rating from undo history instead, leaving the item and its files as they are,
  // for a rating whose file can no longer be restored
  async undo({ discard = false } = {}) {
    const rating = this.database.getLastRating();
    if (!rating) {
      out.info('No rating to undo');
      return null;
    }
    if (discard) {
      this.database.finalizeRating(rating.id);
      out.success(`Dropped the ${rating.rating ? `keep ${rating.rating}/3` : 'skip'} of #${rating.media_id} from undo history; the item is unchanged`);
      return this.database.getMedia(rating.media_id);
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
    if (result.media.status === 'skipped') {
      try { await this.control.removeMedia(previous); } catch (error) { this.playbackWarning(error); }
    } else {
      await this.syncPlayback(previous, target);
    }
    out.success(`Undid rating for #${previous.id}`);
    const restored = this.database.getMedia(previous.id);
    this.printRated(restored);
    return restored;
  }

  async goNext(options = {}) {
    const { media, monitor, rating } = await this.current(options);
    if (!rating) throw new Error('Rate this item with keep or skip before go-next');
    await this.advance(monitor, await this.nextOptions(options));
    return media;
  }
}
