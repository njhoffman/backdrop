import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import { RatingCommand } from './RatingCommand.js';
import { positiveInteger } from '../library/quality.js';
import { out, mark, displayPath } from '../utils/output.js';
import { printMedia, formatMediaLine } from '../utils/mediaView.js';

export class ListCommand {
  constructor(config, database, logger, { rating, prompt = inquirer.prompt } = {}) {
    this.config = config;
    this.database = database;
    this.rating = rating ?? new RatingCommand(config, database, logger);
    this.prompt = prompt;
  }

  async listImages(options = {}) { return this.list(['image'], options); }
  async listVideos(options = {}) { return this.list(['video', 'gif'], options); }

  async list(kind, options = {}) {
    const filters = { kind, downloaded: true };
    if (options.source) filters.source = options.source;
    if (options.status) {
      if (!['new', 'kept', 'skipped'].includes(options.status)) throw new Error('Invalid status');
      filters.status = options.status;
    }
    if (options.rated !== undefined) {
      if (![true, 'any', 'landscape', 'portrait'].includes(options.rated)) throw new Error('--rated accepts landscape, portrait or any');
      filters.minRating = 1;
      if (['landscape', 'portrait'].includes(options.rated)) filters.orientation = options.rated;
    }
    if (options.minRating !== undefined) filters.minRating = positiveInteger(options.minRating, 'Minimum rating', 3);
    if (options.local === false) filters.excludeLocal = true;
    if (options.keywords) filters.keywords = options.keywords;
    if (options.number !== undefined) filters.limit = positiveInteger(options.number, 'Number');
    const items = this.database.findMedia(filters);
    for (const item of items) {
      const rating = this.database.getLatestRating(item.id);
      if (options.line) out.print(formatMediaLine(item, { rating }));
      else printMedia(this.database, item, { rating });
      if (options.interactive) {
        const { action } = await this.prompt([{ type: 'list', name: 'action', message: 'Action:',
          choices: [{ name: 'Next', value: 'next' }, { name: 'Keep 1', value: 1 }, { name: 'Keep 2', value: 2 },
            { name: 'Keep 3', value: 3 }, { name: 'Skip', value: 0 }, { name: 'Exit', value: 'exit' }] }]);
        if (action === 'exit') break;
        if (Number.isInteger(action)) Object.assign(item, await this.rating.rate(item, action));
      }
    }
    if (!items.length) out.info('No matching downloaded media');
    // One-line output is meant for fzf and tables, so no summary row joins the items
    else if (!options.line) out.print(`${mark('info')}${items.length} item(s)`);
    if (options.playlist) {
      const file = path.resolve(this.config.expandPath(options.playlist));
      const paths = [];
      for (const item of items) if (await fs.pathExists(item.path)) paths.push(item.path);
      if (paths.some(filePath => /[\r\n]/.test(filePath))) throw new Error('Cannot export paths containing line breaks');
      await fs.outputFile(file, `#EXTM3U\n${paths.join('\n')}${paths.length ? '\n' : ''}`);
      out.success(`Playlist: ${displayPath(file)} (${paths.length} files)`);
    }
    return items;
  }
}
