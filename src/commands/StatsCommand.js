import { out, fmt } from '../utils/output.js';

export class StatsCommand {
  constructor(config, database, logger) {
    this.database = database;
  }

  async showStats() {
    const stats = this.database.getStats();
    for (const [kind, counts] of Object.entries(stats.media)) {
      out.row(kind, `${counts.new} new, ${fmt.green(counts.kept)} kept, ${fmt.yellow(counts.skipped)} skipped`);
    }
    out.row('Searches', stats.searches);
    out.row('Ratings', stats.ratings);
    const limits = this.database.getSetting('source_rate_limit:pexels');
    if (limits) out.row('Pexels quota (last response)', `${limits.remaining ?? '?'} / ${limits.limit ?? '?'}, reset ${limits.reset ? new Date(limits.reset * 1000).toISOString() : 'unknown'}`);
    return stats;
  }
}
