import fs from 'fs-extra';
import path from 'path';
import { DisplayControl } from '../display/DisplayControl.js';
import { queueRandom, randomOrder } from '../display/Playlist.js';
import { out, fmt } from '../utils/output.js';
import { printMedia, printPlaying, formatMediaLine, formatAdjustments } from '../utils/mediaView.js';
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
    // Checked before rating so a bad display.order does not leave a rating without the advance
    const random = options.next && this.random(options);
    const rated = await this.rate(media, Number(rating), `${monitor.width}x${monitor.height}`);
    // With --next the rated item gets one line, so the full block below it is the item now playing
    this.printRated(rated, { line: options.line || options.next });
    if (options.next) await this.advance(monitor, options, random);
    return rated;
  }

  // The item a rating change applied to, with the rating it now has
  printRated(media, { line = false } = {}) {
    const rating = this.database.getLatestRating(media.id);
    if (line) out.print(formatMediaLine(media, { rating }));
    else printMedia(this.database, media, { rating, extra: [fmt.dim(formatAdjustments(media))] });
  }

  // Removing the playing entry advances mpv, so --random moves a random entry up to play next first
  async skip(options = {}) {
    const { media, monitor } = await this.current(options);
    const random = this.random(options);
    const playing = await this.control.switchTo(monitor.name, async client => {
      if (random) await queueRandom(client);
      return this.rate(media, 0, `${monitor.width}x${monitor.height}`);
    });
    await this.show(playing, options);
    return playing.result;
  }

  random(options) {
    return randomOrder(this.config.get().display, options.random);
  }

  async advance(monitor, options, random = this.random(options)) {
    await this.show(await this.control.next(monitor.name, { random }), options);
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

  async undo() {
    const rating = this.database.getLastRating();
    if (!rating) {
      out.info('No rating to undo');
      return null;
    }
    const previous = this.database.getMedia(rating.media_id);
    if (!previous?.path) {
      throw new Error(previous?.status === 'skipped' && rating.rating === 0
        ? `#${rating.media_id} was purged from trash; its file cannot be restored`
        : 'Rating item has no downloaded file to restore');
    }
    const preceding = this.database.getLatestRating(previous.id, rating.id);
    const { paths } = this.config.get();
    const directory = preceding ? (preceding.rating === 0 ? paths.trash : paths.media) : paths.inbox;
    const target = rating.previous_path ?? path.join(directory, path.basename(previous.path));
    if (rating.rated_path && previous.path !== rating.rated_path) throw new Error('Media path changed since this rating');
    let result;
    await this.moveAndCommit(previous.path, target, () => {
      if (this.database.getMedia(previous.id)?.path !== previous.path) throw new Error('Media changed while undoing; try again');
      result = this.database.undoLastRating(rating.id);
      this.database.updateMedia(previous.id, { path: target });
    });
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
    await this.advance(monitor, options);
    return media;
  }
}
