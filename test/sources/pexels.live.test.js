import { expect } from 'chai';
import { PexelsSource } from '../../src/sources/PexelsSource.js';
import { makeConfig } from '../helpers/fakes.js';

// The Pexels adapter against the live API, opt-in: BACKDROP_LIVE_TESTS=1 and a key in PEXELS_API. Three API
// requests (one search page per kind, one metadata lookup) and one small image file from Pexels' CDN.
// Routine `npm test` runs skip it and stay offline.
const live = process.env.BACKDROP_LIVE_TESTS === '1' && Boolean(process.env.PEXELS_API);

(live ? describe : describe.skip)('Pexels live API (BACKDROP_LIVE_TESTS=1)', function () {
  this.timeout(60000);
  let source;

  before(() => {
    source = new PexelsSource(makeConfig({ 'sources.pexels.api_key': process.env.PEXELS_API }));
  });

  it('searches images: whole-picture variants only, attribution and quota', async () => {
    const result = await source.search({ kind: 'image', query: 'mountain lake', perPage: 3, minSize: 'large' });
    expect(result.items).to.have.length(3);
    expect(result.nextPage).to.equal(2);
    expect(result.rateLimit.limit).to.be.above(0);
    for (const item of result.items) {
      expect(item.source_id).to.match(/^image:\d+$/);
      expect(item.author).to.be.a('string').that.is.not.empty;
      expect(item.page_url).to.match(/^https:\/\/www\.pexels\.com\/photo\//);
      expect(item.variants.length).to.be.at.least(4);
      // No fixed-shape crops (portrait, landscape, tiny): each keeps the picture's shape
      for (const variant of item.variants) {
        expect(variant.url).to.not.include('fit=crop');
        expect(Math.abs(variant.width / variant.height - item.width / item.height)).to.be.below(0.02);
      }
    }

    // The smallest variant is a real JPEG on the CDN
    const smallest = [...result.items[0].variants].sort((a, b) => a.width * a.height - b.width * b.height)[0];
    const response = await fetch(smallest.url);
    expect(response.ok).to.equal(true);
    expect(response.headers.get('content-type')).to.match(/^image\/jpeg/);
    expect((await response.arrayBuffer()).byteLength).to.be.above(1000);

    // metadata agrees with the search result
    const meta = await source.metadata('image', result.items[0].source_id);
    expect(meta).to.include({ source_id: result.items[0].source_id, width: result.items[0].width, height: result.items[0].height, author: result.items[0].author });
  });

  it('searches videos: mp4 variants with sizes and a duration', async () => {
    const result = await source.search({ kind: 'video', query: 'mountain lake', perPage: 2 });
    expect(result.items).to.have.length(2);
    for (const item of result.items) {
      expect(item.source_id).to.match(/^video:\d+$/);
      expect(item.duration).to.be.above(0);
      expect(item.variants.length).to.be.above(0);
      for (const variant of item.variants) {
        expect(variant.mime).to.equal('video/mp4');
        expect(variant.width).to.be.above(0);
        expect(variant.url).to.match(/^https:\/\//);
      }
    }
  });
});
