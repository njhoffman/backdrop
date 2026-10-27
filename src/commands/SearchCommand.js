import inquirer from 'inquirer';
import { SourceRegistry } from '../sources/SourceRegistry.js';
import { targetResolution, positiveInteger, selectVariant } from '../library/quality.js';
import { out, fmt } from '../utils/output.js';

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
    const summary = { searchId, fetched: 0, added: 0, updated: 0, filtered: 0, pages: 0, rateLimited: false };
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
          this.database.addSearchResult(searchId, id, rank);
          if (existing) summary.updated++; else summary.added++;
        }
      });
      summary.pages++;
      out.detail(`Page ${page}: ${summary.added} added, ${summary.updated} updated, ${summary.filtered} filtered`);
      if (result.nextPage !== null && result.nextPage !== undefined && (!Number.isInteger(result.nextPage) || result.nextPage <= page)) {
        throw new Error(`${source.name}: invalid next page`);
      }
      page = result.items.length ? (result.nextPage ?? null) : null;
    }
    out.success(`Search #${searchId}: ${fmt.bold(summary.added)} added, ${summary.updated} updated, ${summary.filtered} filtered`);
    if (source.name === 'pexels') out.detail('Photos and videos provided by Pexels: https://www.pexels.com');
    this.logger.info('Search finished', summary);
    return summary;
  }
}
