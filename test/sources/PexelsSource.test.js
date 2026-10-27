import { expect } from 'chai';
import sinon from 'sinon';
import { PexelsSource } from '../../src/sources/PexelsSource.js';
import { SourceRegistry } from '../../src/sources/SourceRegistry.js';
import { makeConfig } from '../helpers/fakes.js';

const photo = { id: 7, width: 4000, height: 3000, photographer: 'Alice', url: 'https://pexels.com/photo/7', alt: 'Ocean', src: {
  original: 'https://images.pexels.com/a.jpg', large: 'https://images.pexels.com/a.jpg?w=940&h=650',
  large2x: 'https://images.pexels.com/a.jpg?w=940&h=650&dpr=2', portrait: 'https://images.pexels.com/a.jpg?fit=crop&w=800&h=1200'
} };
const video = { id: 7, width: 3840, height: 2160, duration: 10, user: { name: 'Bob' }, url: 'https://pexels.com/video/7',
  video_files: [{ link: 'https://videos.pexels.com/a.mp4', width: 1920, height: 1080, file_type: 'video/mp4' }] };

describe('PexelsSource', () => {
  let config, request, source;
  beforeEach(() => {
    config = makeConfig({ 'sources.pexels.api_key': 'test-key' });
    request = sinon.stub().resolves(new Response(JSON.stringify({ photos: [photo], next_page: 'next' }), {
      headers: { 'X-Ratelimit-Limit': '20000', 'X-Ratelimit-Remaining': '99', 'X-Ratelimit-Reset': '2000000000' }
    }));
    source = new PexelsSource(config, { fetch: request });
  });
  async function fails(fn, text) {
    let caught; try { await fn(); } catch (error) { caught = error; }
    expect(caught?.message).to.include(text); return caught;
  }

  it('encodes queries and normalizes image variants, attribution, pagination and quota', async () => {
    const result = await source.search({ kind: 'image', query: 'ocean & sky', perPage: 15, page: 2 });
    const [url, options] = request.firstCall.args;
    expect(url.searchParams.get('query')).to.equal('ocean & sky');
    expect(url.pathname).to.equal('/v1/search');
    expect(url.searchParams.get('size')).to.equal('large');
    expect(options.headers.Authorization).to.equal('test-key');
    expect(result.nextPage).to.equal(3);
    expect(result.rateLimit.remaining).to.equal(99);
    expect(result.items[0]).to.include({ source: 'pexels', source_id: 'image:7', author: 'Alice', page_url: photo.url });
    expect(result.items[0].variants.map(v => [v.width, v.height])).to.deep.equal([[4000, 3000], [1733, 1300], [866, 650], [800, 1200]]);
  });

  it('uses the current video endpoint with a distinct identity for matching image IDs', async () => {
    request.resolves(new Response(JSON.stringify({ videos: [video] })));
    const result = await source.search({ kind: 'video', query: 'waves' });
    expect(request.firstCall.args[0].pathname).to.equal('/v1/videos/search');
    expect(result.items[0]).to.include({ source_id: 'video:7', author: 'Bob' });
    expect(result.items[0].variants[0]).to.include({ width: 1920, height: 1080, mime: 'video/mp4' });
    expect(result.nextPage).to.be.null;
  });

  it('fetches metadata when variants are absent and otherwise uses stored URLs without credentials', async () => {
    request.resolves(new Response(JSON.stringify(video)));
    const variants = await source.downloadVariants({ kind: 'video', source_id: 'video:7', variants: [] });
    expect(request.firstCall.args[0].pathname).to.equal('/v1/videos/videos/7');
    expect(variants).to.have.length(1);
    config.set('sources.pexels.api_key', '');
    expect(await source.downloadVariants({ variants })).to.equal(variants);
  });

  it('validates credentials on request, so construction and unrelated commands work offline', async () => {
    config.set('sources.pexels.api_key', '');
    expect(() => new SourceRegistry(config)).to.not.throw();
    await fails(() => source.search({ kind: 'image', query: 'waves' }), 'api_key');
    expect(request.called).to.be.false;
    expect(() => new SourceRegistry(config).get('unknown')).to.throw('Unknown source');
  });

  it('reports HTTP failures and rate limits without retrying', async () => {
    request.resolves(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    const error = await fails(() => source.search({ kind: 'image', query: 'waves' }), 'rate limit');
    expect(error).to.include({ status: 429, retryAfter: '60' });
    expect(request.callCount).to.equal(1);
    request.resolves(new Response('', { status: 401 }));
    await fails(() => source.metadata('image', 1), 'HTTP 401');
  });

  it('stops before another request when the observed quota is exhausted', async () => {
    source.rateLimit = { remaining: 0, reset: Date.now() / 1000 + 3600 };
    const error = await fails(() => source.search({ kind: 'image', query: 'waves' }), 'rate limit');
    expect(error.status).to.equal(429);
    expect(request.called).to.be.false;
  });

  it('rejects unsupported media and malformed API responses', async () => {
    await fails(() => source.search({ kind: 'gif', query: 'waves' }), 'does not support');
    request.resolves(new Response('{}'));
    await fails(() => source.search({ kind: 'image', query: 'waves' }), 'invalid search response');
  });
});
