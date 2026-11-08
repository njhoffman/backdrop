import { RatingService } from '../services/RatingService.js';
import { out, fmt } from '../utils/output.js';
import { printMedia, printPlaying, formatMediaLine, formatAdjustments, wantsJson, mediaJson } from '../utils/mediaView.js';

// keep, skip, undo and go-next at the prompt: RatingService does the work, this prints it
export class RatingCommand {
  constructor(config, database, logger, { control, service } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.service = service ?? new RatingService({ config, database, logger, control });
  }

  get control() {
    return this.service.control;
  }

  set control(control) {
    this.service.control = control;
  }

  async keep(rating = 1, options = {}) {
    const json = wantsJson(options);
    let result;
    try {
      result = await this.service.keep(rating, options);
    } catch (error) {
      // The rating committed before the advance failed
      if (error.done) this.printKept(error.done, options, json);
      throw error;
    }
    this.printKept(result, options, json);
    if (result.playing) printPlaying(this.database, result.playing, result.options);
    return result.rated;
  }

  // With --next the rated item gets one line, so the full block below it is the item now playing;
  // with --json only one document is printed: the rated item, or with --next the item now playing
  printKept({ rated, warnings }, options, json) {
    this.printRating(rated, warnings);
    if (json && !options.next) out.json({ item: mediaJson(this.database, rated, undefined, { config: this.config.get() }) });
    else if (!json) this.printRated(rated, { line: options.line || options.next });
  }

  // The item a rating change applied to, with the rating it now has
  printRated(media, { line = false } = {}) {
    const rating = this.database.getLatestRating(media.id);
    if (line) out.print(formatMediaLine(media, { rating }));
    else printMedia(this.database, media, { rating, extra: [fmt.dim(formatAdjustments(media))] });
  }

  // Playlist warnings, then the rating itself
  printRating(media, warnings) {
    for (const warning of warnings) out.warn(warning);
    const rating = this.database.getLatestRating(media.id)?.rating;
    if (rating === 0) out.warn(`#${media.id}: skipped`);
    else out.success(`#${media.id}: kept ${rating}/3`);
  }

  async skip(options = {}) {
    let result;
    try {
      result = await this.service.skip(options);
    } catch (error) {
      if (error.done) this.printRating(error.done.rated, error.done.warnings);
      throw error;
    }
    this.printRating(result.rated, result.warnings);
    printPlaying(this.database, result.playing, result.options);
    return result.rated;
  }

  // Rates one item (the list commands' interactive rating) and prints the change; returns the updated item
  async rate(media, rating, resolution = null) {
    const { media: rated, warnings } = await this.service.rate(media, rating, resolution);
    this.printRating(rated, warnings);
    return rated;
  }

  async undo(options = {}) {
    const { action, rating, media, warnings } = await this.service.undo(options);
    if (action === 'none') {
      out.info('No rating to undo');
      return null;
    }
    if (action === 'discarded') {
      out.success(`Dropped the ${rating.rating ? `keep ${rating.rating}/3` : 'skip'} of #${rating.media_id} from undo history; the item is unchanged`);
      return media;
    }
    for (const warning of warnings) out.warn(warning);
    out.success(`Undid rating for #${media.id}`);
    this.printRated(media);
    return media;
  }

  async goNext(options = {}) {
    const { media, playing, options: resolved } = await this.service.goNext(options);
    printPlaying(this.database, playing, resolved);
    return media;
  }
}
