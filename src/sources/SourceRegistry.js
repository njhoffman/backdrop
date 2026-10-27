import { PexelsSource } from './PexelsSource.js';

export class SourceRegistry {
  constructor(config, sources = [new PexelsSource(config)]) {
    this.sources = new Map(sources.map(source => [source.name, source]));
  }

  get(name) {
    const source = this.sources.get(name);
    if (!source) throw new Error(`Unknown source: ${name} (available: ${[...this.sources.keys()].join(', ')})`);
    return source;
  }
}
