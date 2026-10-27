export class StatsCommand {
  constructor(config, database, logger) {
    this.database = database;
  }

  async showStats() {
    const stats = this.database.getStats();
    for (const [kind, counts] of Object.entries(stats.media)) {
      console.log(`${kind}: ${counts.new} new, ${counts.kept} kept, ${counts.skipped} skipped`);
    }
    console.log(`Searches: ${stats.searches}, ratings: ${stats.ratings}`);
    const limits = this.database.getSetting('source_rate_limit:pexels');
    if (limits) console.log(`Pexels quota (last response): ${limits.remaining ?? '?'} / ${limits.limit ?? '?'}, reset ${limits.reset ? new Date(limits.reset * 1000).toISOString() : 'unknown'}`);
    return stats;
  }
}
