import { expect } from 'chai';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { SearchCommand } from '../../src/commands/SearchCommand.js';
import { SourceRegistry } from '../../src/sources/SourceRegistry.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

const item = (id, overrides = {}) => ({ kind: 'image', source: 'fake', source_id: String(id), width: 4000, height: 3000,
  variants: [{ url: `https://example.com/${id}`, width: 4000, height: 3000, mime: 'image/jpeg' }], ...overrides });

describe('SearchCommand', () => {
  let db, config, source, command;
  beforeEach(() => {
    db = new DatabaseManager(); db.initialize(':memory:');
    config = makeConfig();
    source = { name: 'fake', search: sinon.stub() };
    command = new SearchCommand(config, db, silentLogger, { sources: new SourceRegistry(config, [source]),
      monitors: async () => [{ name: 'DP-1', width: 1920, height: 1080 }] });
    sinon.stub(console, 'log'); sinon.stub(console, 'error');
  });
  afterEach(() => { sinon.restore(); db.close(); });
  const run = (options = {}) => command.searchImages('ocean', { source: 'fake', perPage: 2, ...options });

  it('paginates and associates upserts with ranks while preserving local state', async () => {
    const id = db.addMedia(item(1, { path: '/library/a.jpg', speed: 0.8 }));
    db.addRating(id, 3);
    source.search.onFirstCall().resolves({ items: [item(1), item(2)], nextPage: 2, rateLimit: { remaining: 42 } });
    source.search.onSecondCall().resolves({ items: [item(3)], nextPage: null });
    const result = await run();
    expect(result).to.include({ added: 2, updated: 1, pages: 2, fetched: 3 });
    expect(db.getSearchResults(result.searchId).map(m => m.rank)).to.deep.equal([1, 2, 3]);
    expect(db.getMedia(id)).to.include({ path: '/library/a.jpg', status: 'kept', speed: 0.8 });
    expect(db.getSetting('source_rate_limit:fake').remaining).to.equal(42);
    expect(source.search.secondCall.args[0].page).to.equal(2);
  });

  it('credits a known duplicate\'s query to the item it duplicates', async () => {
    const original = db.addMedia(item(1, { path: '/library/a.jpg' }));
    const copy = db.addMedia(item(2));
    db.markDuplicate(copy, original);
    source.search.resolves({ items: [item(2), item(3)], nextPage: null });
    const result = await run();
    expect(result).to.include({ added: 1, updated: 0, duplicates: 1 });
    expect(db.getSearchResults(result.searchId).map(m => m.id)).to.deep.equal([original, copy + 1]);
    expect(db.getQueries(original)).to.deep.equal(['ocean']);
    expect(db.getMedia(copy).duplicate_of).to.equal(original);
  });

  it('filters undersized variants and portrait mismatches without changing result ranks', async () => {
    source.search.resolves({ items: [item(1, { variants: [{ url: 'https://example.com/small', width: 640, height: 480 }] }),
      item(2), item(3, { width: 3000, height: 4000 })], nextPage: null });
    const result = await run({ portrait: true });
    expect(result).to.include({ filtered: 2, added: 1 });
    expect(db.getSearchResults(result.searchId)[0].rank).to.equal(3);
    expect(source.search.firstCall.args[0].orientation).to.equal('portrait');
  });

  it('retains completed pages on a rate limit and propagates other failures', async () => {
    source.search.onFirstCall().resolves({ items: [item(1)], nextPage: 2 });
    source.search.onSecondCall().rejects(Object.assign(new Error('limited'), { status: 429 }));
    expect(await run()).to.include({ rateLimited: true, added: 1 });
    source.search.resetBehavior(); source.search.rejects(new Error('network failed'));
    let caught; try { await run(); } catch (error) { caught = error; }
    expect(caught.message).to.equal('network failed');
    expect(db.findMedia()).to.have.length(1);
  });

  it('fails before searching on invalid inputs or unavailable monitor dimensions', async () => {
    for (const options of [{ perPage: '2junk' }, { perPage: 81 }, { orientation: 'diagonal' }, { resolution: '0x10' }, { minSize: 'tiny' }]) {
      let caught; try { await run(options); } catch (error) { caught = error; }
      expect(caught).to.be.instanceOf(Error);
    }
    command.monitors = async () => [];
    let caught; try { await run(); } catch (error) { caught = error; }
    expect(caught.message).to.include('--resolution');
    expect(source.search.called).to.be.false;
    expect(db.getStats().searches).to.equal(0);
  });

  it('accepts an explicit resolution without X and honors configured monitor selection', async () => {
    source.search.resolves({ items: [], nextPage: null });
    command.monitors = async () => { throw new Error('no X'); };
    await run({ resolution: '2560x1440' });
    expect(source.search.firstCall.args[0].target).to.deep.equal({ width: 2560, height: 1440 });
    config.set('display.monitors', ['DP-1']);
    command.monitors = async () => [{ name: 'DP-1', width: 1920, height: 1080 }, { name: 'DP-2', width: 8000, height: 8000 }];
    await run();
    expect(source.search.secondCall.args[0].target).to.deep.equal({ width: 1920, height: 1080 });
  });
});
