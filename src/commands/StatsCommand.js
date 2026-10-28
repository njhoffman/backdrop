import { out, fmt, icon } from '../utils/output.js';

export class StatsCommand {
  constructor(config, database, logger) {
    this.database = database;
  }

  async showStats() {
    const stats = this.database.getStats();
    for (const [kind, counts] of Object.entries(stats.media)) {
      const total = counts.new + counts.kept + counts.skipped;
      out.row(`${icon(kind)}${kind}`, `${fmt.bold(total)} ${fmt.dim('(')}${counts.new} new, ${fmt.green(counts.kept)} kept, ${fmt.yellow(counts.skipped)} skipped${fmt.dim(')')}`);
    }
    out.row(`${icon('pending')}Pending download`, stats.pending);
    if (stats.duplicates) out.row(`${icon('duplicate')}Duplicates found`, stats.duplicates);
    out.row(`${icon('query')}Searches`, stats.searches);
    out.row(`${icon('star')}Ratings`, stats.ratings);
    const limits = this.database.getSetting('source_rate_limit:pexels');
    if (limits) out.row('Pexels quota (last response)', `${limits.remaining ?? '?'} / ${limits.limit ?? '?'}, reset ${limits.reset ? new Date(limits.reset * 1000).toISOString() : 'unknown'}`);
    return stats;
  }
}
