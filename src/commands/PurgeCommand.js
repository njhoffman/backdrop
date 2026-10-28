import { purgeTrash } from '../library/purge.js';
import { out, fmt, displayPath } from '../utils/output.js';

export class PurgeCommand {
  constructor(config, database, logger) {
    this.config = config;
    this.database = database;
    this.logger = logger;
  }

  async purge(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const result = await purgeTrash({ config: this.config, database: this.database, logger: this.logger, dryRun });
    if (result.disabled) {
      out.info('Trash purge is disabled (library.trash_days is 0)');
      return result;
    }
    for (const media of result.purged) {
      out.print(`${dryRun ? 'Would purge' : 'Purged'} ${fmt.bold(`#${media.id}`)}: ${displayPath(media.path)}`);
    }
    for (const media of result.failed) {
      out.error(`Not purged #${media.id}: ${displayPath(media.path)}`);
    }
    const days = this.config.get().library.trash_days;
    out.success(`${dryRun ? 'Would purge' : 'Purged'} ${result.purged.length} item(s) skipped more than ${days} day(s) ago`);
    if (result.failed.length) process.exitCode = 1;
    return result;
  }
}
