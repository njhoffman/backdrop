import inquirer from 'inquirer';
import { SourceRegistry } from '../sources/SourceRegistry.js';
import { targetResolution, positiveInteger, selectVariant } from '../library/quality.js';
import { out, fmt, icon, formatResolution } from '../utils/output.js';

export class SearchCommand {
  constructor(config, database, logger, { sources, monitors, prompt = inquirer.prompt } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.sources = sources ?? new SourceRegistry(config);
    this.monitors = monitors;
    this.prompt = prompt;
  }

  async searchImages(query, options = {}) { return this.search('image', query, options); }
  async searchVideos(query, options = {}) { return this.search('video', query, options); }

  async search(kind, query, options = {}) {
    if (!query && process.stdin.isTTY) query = (await this.prompt([{ type: 'input', name: 'query', message: 'Search keywords:' }])).query;
    query = query?.trim();
    if (!query) throw new Error('Search query cannot be empty');
    const source = this.sources.get(options.source ?? 'pexels');
    const perPage = positiveInteger(options.perPage ?? this.config.get().sources[source.name]?.per_page ?? 80, 'Per-page', 80);
    const orientation = options.portrait ? 'portrait' : options.orientation;
    if (orientation && !['portrait', 'landscape', 'square'].includes(orientation)) throw new Error('Invalid orientation');
    if (options.minSize && !['large', 'medium', 'small'].includes(options.minSize)) throw new Error('Invalid minimum size');
    const target = await targetResolution(this.config, options.resolution, this.monitors);
    const params = { kind, perPage, orientation, minSize: options.minSize, color: options.color, target };
    const searchId = this.database.addSearch(source.name, query, params);
    const summary = { searchId, fetched: 0, added: 0, updated: 0, duplicates: 0, filtered: 0, pages: 0, rateLimited: false };
    const filters = [orientation, options.minSize && `min ${options.minSize}`, options.color].filter(Boolean);
    out.info(`${icon('query')}Searching ${source.name} ${kind}s for ${fmt.bold(`"${query}"`)}`
      + fmt.dim(`  target ${formatResolution(target.width, target.height)}${filters.length ? `, ${filters.join(', ')}` : ''}`));
    let page = 1;
    while (page !== null) {
      let result;
      try {
        result = await source.search({ ...params, query, page });
      } catch (error) {
        if (error.status !== 429) throw error;
        summary.rateLimited = true;
        out.warn(`${source.name}: rate limit reached; saved results are available for download`);
        break;
      }
      if (result.rateLimit) this.database.setSetting(`source_rate_limit:${source.name}`, result.rateLimit);
      this.database.transaction(() => {
        for (const [index, media] of result.items.entries()) {
          summary.fetched++;
          const rank = (page - 1) * perPage + index + 1;
          if ((options.portrait && media.height <= media.width) || !selectVariant(media.variants, target, this.config)) {
            summary.filtered++;
            continue;
          }
          const existing = this.database.getMediaBySource(media.source, media.source_id);
          const id = this.database.upsertMedia(media);
          // A known duplicate credits the query to the item it duplicates
          this.database.addSearchResult(searchId, existing?.duplicate_of ?? id, rank);
          if (existing?.duplicate_of) summary.duplicates++;
          else if (existing) summary.updated++;
          else summary.added++;
        }
      });
      summary.pages++;
      out.detail(`Page ${page}: ${result.items.length} results, ${summary.added} added, ${summary.updated} updated, ${summary.filtered} filtered so far`);
      if (result.nextPage !== null && result.nextPage !== undefined && (!Number.isInteger(result.nextPage) || result.nextPage <= page)) {
        throw new Error(`${source.name}: invalid next page`);
      }
      page = result.items.length ? (result.nextPage ?? null) : null;
    }
    const duplicates = summary.duplicates ? `, ${summary.duplicates} known duplicates` : '';
    out.success(`Search #${searchId}: ${fmt.bold(summary.added)} added, ${summary.updated} updated${duplicates}, `
      + `${summary.filtered} filtered (${summary.fetched} results, ${summary.pages} pages)`);
    const { pending } = this.database.getStats();
    if (pending) out.detail(`${pending} pending; see them with \`backdrop pending\`, fetch with \`backdrop download\``);
    if (source.name === 'pexels') out.detail('Photos and videos provided by Pexels: https://www.pexels.com');
    this.logger.info('Search finished', summary);
    return summary;
  }
}
