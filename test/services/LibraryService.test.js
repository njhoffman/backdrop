import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { LibraryService } from '../../src/services/LibraryService.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('LibraryService', () => {
  let dir, db, config, control, rating, library, ids;
  const monitor = { name: 'DP-1', width: 1920, height: 1080 };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-library-'));
    config = makeConfig({ 'paths.runtime': dir, 'display.video_loop': 'bounce' });
    db = new DatabaseManager();
    db.initialize(':memory:');
    const add = (kind, name, width, extra = {}) => db.addMedia({ kind, source: 'local', source_id: name, original_name: name, path: `/m/${name}`, width, height: 1080, duration: 10, ...extra });
    ids = {
      ocean: add('video', 'ocean waves.mp4', 1920),
      forest: add('video', 'forest.mp4', 3840),
      sky: add('image', 'sky.jpg', 2560),
      loop: add('gif', 'ocean loop.gif', 1920),
      gone: add('video', 'gone.mp4', 1920, { path: undefined })
    };
    db.addRating(ids.forest, 3);
    db.addRating(ids.sky, 0);
    const client = { setProperty: sinon.stub().resolves() };
    control = {
      client,
      state: sinon.stub().resolves(null),
      current: sinon.stub().resolves({ monitor, media: null }),
      withClient: sinon.stub().callsFake(async (target, fn) => fn(client)),
      send: sinon.stub().resolves({}),
      next: sinon.stub().callsFake(async name => ({ monitor, path: '/m/ocean waves.mp4', media: db.getMedia(ids.ocean), rating: null, name }))
    };
    rating = { rate: sinon.stub().callsFake(async (media, value) => {
      db.addRating(media.id, value);
      return { media: db.getMedia(media.id), warnings: [] };
    }) };
    library = new LibraryService({ config, database: db, logger: silentLogger, control, rating });
  });

  afterEach(async () => {
    db.close();
    await fs.remove(dir);
  });

  const listed = options => library.list(options).items.map(item => item.id);

  it('lists downloaded new and kept items, newest first, by default', () => {
    const result = library.list();
    expect(result).to.include({ total: 3, page: 1, pages: 1, per_page: 48 });
    expect(result.items.map(item => item.id)).to.deep.equal([ids.loop, ids.forest, ids.ocean]);
    expect(result.items[0]).to.include.keys('tags', 'rating', 'bounce');
  });

  it('filters by kind, status, rating, tag and words, and sorts', () => {
    expect(listed({ kind: 'video' })).to.deep.equal([ids.loop, ids.forest, ids.ocean]);
    expect(listed({ kind: 'image', status: 'all' })).to.deep.equal([ids.sky]);
    expect(listed({ status: 'skipped' })).to.deep.equal([ids.sky]);
    expect(listed({ min_rating: '3' })).to.deep.equal([ids.forest]);
    expect(listed({ tag: ['ocean'] })).to.deep.equal([ids.loop, ids.ocean]);
    expect(listed({ keywords: ['waves'] })).to.deep.equal([ids.ocean]);
    expect(listed({ sort: 'oldest' })).to.deep.equal([ids.ocean, ids.forest, ids.loop]);
    expect(listed({ sort: 'largest' })[0]).to.equal(ids.forest);
  });

  it('pages, keeping the page within range', () => {
    const second = library.list({ per_page: '2', page: '2' });
    expect(second).to.include({ total: 3, page: 2, pages: 2, per_page: 2 });
    expect(second.items.map(item => item.id)).to.deep.equal([ids.ocean]);
    expect(library.list({ per_page: '2', page: '9' }).page).to.equal(2);
    expect(library.list({ per_page: '500' }).per_page).to.equal(100);
  });

  it('refuses unknown choices, naming the ones it takes', () => {
    expect(() => library.list({ kind: 'audio' })).to.throw('Unknown kind: audio (use all, video, image)');
    expect(() => library.list({ sort: 'size' })).to.throw('Unknown sort');
    expect(() => library.list({ min_rating: '5' })).to.throw('min_rating must be 1, 2 or 3');
    expect(() => library.list({ query: ['never searched'] })).to.throw('No search used the query');
  });

  it('offers the common tags and the saved searches', () => {
    const { tags, queries } = library.facets();
    expect(tags[0]).to.deep.equal({ tag: 'ocean', count: 2 });
    expect(queries).to.deep.equal([]);
  });

  it('gives an item, or a 404 error for an unknown one', () => {
    expect(library.item(ids.ocean).id).to.equal(ids.ocean);
    let caught;
    try { library.item(999); } catch (error) { caught = error; }
    expect(caught).to.include({ status: 404, message: 'No library item #999' });
  });

  it('rates any item through the rating service', async () => {
    const { item, warnings } = await library.rate(ids.ocean, '2');
    expect(item.rating.value).to.equal(2);
    expect(warnings).to.deep.equal([]);
    expect(rating.rate.firstCall.args[1]).to.equal(2);
    let caught;
    try { await library.rate(ids.ocean, 4); } catch (error) { caught = error; }
    expect(caught.message).to.include('Rating must be 0');
  });

  it('stores speed, dim and bounce, and applies them to a monitor playing the item', async () => {
    control.state.resolves({ monitors: [{ ...monitor, socket: '/run/dp1.sock' }], visualizer: { musicDim: 40 } });
    control.current.resolves({ monitor, media: db.getMedia(ids.ocean) });
    const item = await library.adjust(ids.ocean, { speed: '0.5', dim: 20, bounce: 'off' });
    expect(item).to.include({ speed: 0.5, dim: 20, bounce: false });
    expect(control.client.setProperty.args).to.deep.equal([['speed', 0.5], ['contrast', -40]]);
    expect(control.send.firstCall.args[2]).to.deep.equal({ bounce: ids.ocean });
  });

  it('only stores a change for an item nothing plays, and refuses video settings on images', async () => {
    await library.adjust(ids.forest, { dim: '+10' });
    expect(db.getMedia(ids.forest).dim).to.equal(10);
    expect(control.client.setProperty.called).to.equal(false);
    let caught;
    try { await library.adjust(ids.sky, { speed: '0.5' }); } catch (error) { caught = error; }
    expect(caught.message).to.equal('Speed only applies to videos and GIFs');
    try { await library.adjust(ids.sky, {}); } catch (error) { caught = error; }
    expect(caught.message).to.equal('Give speed, dim or bounce');
  });

  it('plays an item on a monitor through next with it as the only match', async () => {
    const playing = await library.play(ids.ocean, 'DP-1');
    expect(control.next.firstCall.args[0]).to.equal('DP-1');
    expect(control.next.firstCall.args[1].matches.map(media => media.id)).to.deep.equal([ids.ocean]);
    expect(playing.media.id).to.equal(ids.ocean);
  });
});
