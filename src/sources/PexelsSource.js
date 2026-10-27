import { Source, SourceError } from './Source.js';

const BASE = 'https://api.pexels.com/v1/';
const IMAGE_SIZES = ['original', 'large2x', 'large', 'medium', 'small', 'portrait', 'landscape', 'tiny'];

function imageVariant(url, name, width, height) {
  if (!url) return null;
  const params = new URL(url).searchParams;
  const multiplier = Number(params.get('dpr') || 1);
  const w = Number(params.get('w')) * multiplier;
  const h = Number(params.get('h')) * multiplier;
  if (name === 'original') return { url, width, height, mime: 'image/jpeg' };
  if (params.get('fit') === 'crop' && w && h) {
    return { url, width: Math.min(w, width), height: Math.min(h, height), mime: 'image/jpeg' };
  }
  const scale = Math.min(1, w ? w / width : 1, h ? h / height : 1);
  return { url, width: Math.floor(width * scale), height: Math.floor(height * scale), mime: 'image/jpeg' };
}

export class PexelsSource extends Source {
  constructor(config, { fetch: request = globalThis.fetch } = {}) {
    super('pexels');
    this.config = config;
    this.fetch = request;
  }

  async request(endpoint, params = {}) {
    const key = this.config.get().sources.pexels?.api_key;
    if (!key) throw new Error('Pexels requires sources.pexels.api_key or PEXELS_API');
    if (this.rateLimit?.remaining === 0 && this.rateLimit.reset * 1000 > Date.now()) {
      throw new SourceError('Pexels rate limit reached', { status: 429 });
    }
    const url = new URL(endpoint, BASE);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, value);
    }
    const response = await this.fetch(url, {
      headers: { Authorization: key, Accept: 'application/json' }, signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      const reason = response.status === 429 ? 'rate limit reached' : `request failed (HTTP ${response.status})`;
      throw new SourceError(`Pexels ${reason}`, { status: response.status, retryAfter: response.headers.get('retry-after') });
    }
    const number = name => {
      const value = response.headers.get(name);
      return value === null ? null : Number(value);
    };
    this.rateLimit = { limit: number('x-ratelimit-limit'), remaining: number('x-ratelimit-remaining'), reset: number('x-ratelimit-reset') };
    const data = await response.json();
    if (data.error) throw new SourceError(`Pexels: ${data.error}`);
    return data;
  }

  normalize(kind, item) {
    return {
      kind, source: this.name,
      // Photo and video IDs belong to separate API namespaces.
      source_id: `${kind}:${item.id}`,
      width: item.width, height: item.height, duration: item.duration ?? null,
      author: kind === 'image' ? item.photographer : item.user?.name,
      page_url: item.url, tags: item.alt ? [item.alt] : [],
      variants: kind === 'image'
        ? IMAGE_SIZES.map(name => imageVariant(item.src?.[name], name, item.width, item.height)).filter(Boolean)
        : (item.video_files ?? []).filter(file => file.link && file.width && file.height).map(file => ({
          url: file.link, width: file.width, height: file.height, mime: file.file_type
        }))
    };
  }

  async search({ kind, query, page = 1, perPage, orientation, minSize, color }) {
    this.validateKind(kind);
    const settings = this.config.get().sources.pexels;
    const data = await this.request(kind === 'image' ? 'search' : 'videos/search', {
      query, page, per_page: perPage ?? settings.per_page,
      orientation, ...(kind === 'image' ? { size: minSize ?? settings.image_min_size, color } : {})
    });
    const records = data[kind === 'image' ? 'photos' : 'videos'];
    if (!Array.isArray(records)) throw new SourceError('Pexels returned an invalid search response');
    return { items: records.map(item => this.normalize(kind, item)), nextPage: data.next_page ? page + 1 : null, rateLimit: this.rateLimit };
  }

  async metadata(kind, sourceId) {
    this.validateKind(kind);
    const id = String(sourceId).replace(/^(image|video):/, '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid Pexels id');
    return this.normalize(kind, await this.request(kind === 'image' ? `photos/${id}` : `videos/videos/${id}`));
  }

  async downloadVariants(media) {
    return media.variants?.length ? media.variants : (await this.metadata(media.kind, media.source_id)).variants;
  }

  validateKind(kind) {
    if (!['image', 'video'].includes(kind)) throw new Error(`Pexels does not support ${kind}`);
  }
}
