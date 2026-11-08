import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { RatingService } from '../../src/services/RatingService.js';
import { FakeMpvClient, makeConfig, silentLogger } from '../helpers/fakes.js';
import { notifications } from '../helpers/setup.js';

// The service returns what changed and never prints; RatingCommand.test.js covers the same steps through the CLI
describe('RatingService', () => {
  let dir, db, config, control, service, id, monitor, client, printed;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-rating-service-'));
    config = makeConfig(Object.fromEntries(['media', 'inbox', 'trash'].map(key => [`paths.${key}`, path.join(dir, key)])));
    db = new DatabaseManager();
    db.initialize(':memory:');
    const file = path.join(dir, 'inbox', 'clip.mp4');
    await fs.outputFile(file, 'video');
    id = db.addMedia({ kind: 'video', source: 'pexels', source_id: 'video:1', path: file, width: 4000, height: 4000 });
    monitor = { name: 'DP-1', width: 1920, height: 1080 };
    client = new FakeMpvClient({ playlist: [{ filename: file, current: true }, { filename: '/m/a.mp4' }] });
    const next = { monitor, path: '/m/a.mp4', media: null, rating: null };
    control = {
      current: sinon.stub().callsFake(async () => ({ monitor, path: db.getMedia(id).path, media: db.getMedia(id), rating: db.getLatestRating(id) })),
      removeMedia: sinon.stub().resolves(), refreshMedia: sinon.stub().resolves(), appendMedia: sinon.stub().resolves(),
      next: sinon.stub().resolves(next),
      switchTo: sinon.stub().callsFake(async (name, change) => ({ ...next, result: await change(client, monitor) }))
    };
    service = new RatingService({ config, database: db, logger: silentLogger, control });
    printed = [];
    sinon.stub(console, 'log').callsFake(line => printed.push(line));
    sinon.stub(console, 'error').callsFake(line => printed.push(line));
    notifications.length = 0;
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(dir);
  });

  it('keeps the playing item and returns it, printing nothing', async () => {
    const result = await service.keep(2, { monitor: 'DP-1' });
    expect(result.rated).to.include({ id, status: 'kept', path: path.join(dir, 'media', 'clip.mp4') });
    expect(result).to.include({ playing: null });
    expect(result.warnings).to.deep.equal([]);
    expect(printed).to.deep.equal([]);
  });

  it('advances after keeping with next, returning what plays now', async () => {
    const result = await service.keep(3, { next: true });
    expect(result.playing).to.include({ path: '/m/a.mp4' });
    expect(control.next.calledOnce).to.be.true;
  });

  it('returns playlist failures as warnings without failing the committed rating', async () => {
    control.appendMedia.rejects(new Error('mpv gone'));
    const result = await service.keep(1);
    expect(result.warnings).to.deep.equal(['Rating change saved; playlist update failed: mpv gone']);
    expect(db.getLatestRating(id).rating).to.equal(1);
  });

  it('puts the rating on the error when the advance after it fails', async () => {
    control.next.rejects(new Error('no socket'));
    let caught;
    try { await service.keep(2, { next: true }); } catch (error) { caught = error; }
    expect(caught.message).to.equal('no socket');
    expect(caught.done.rated).to.include({ id, status: 'kept' });
  });

  it('skips into the trash and returns the item and what plays now', async () => {
    const result = await service.skip({});
    expect(result.rated).to.include({ id, status: 'skipped', path: path.join(dir, 'trash', 'clip.mp4') });
    expect(result.playing).to.include({ path: '/m/a.mp4' });
    expect(control.removeMedia.calledOnce).to.be.true;
  });

  it('undoes, discards, or says there is nothing to undo', async () => {
    expect(await service.undo()).to.deep.equal({ action: 'none', rating: null, media: null, warnings: [] });

    await service.keep(2);
    const undone = await service.undo();
    expect(undone.action).to.equal('undone');
    expect(undone.media).to.include({ path: path.join(dir, 'inbox', 'clip.mp4') });

    await service.keep(3);
    const discarded = await service.undo({ discard: true });
    expect(discarded).to.include({ action: 'discarded' });
    expect(discarded.rating).to.include({ rating: 3 });
    expect(db.getMedia(id).status).to.equal('kept');
  });

  it('plays the next item only once the playing one is rated', async () => {
    let caught;
    try { await service.goNext(); } catch (error) { caught = error; }
    expect(caught.message).to.include('Rate this item');
    await service.keep(2);
    expect((await service.goNext()).playing).to.include({ path: '/m/a.mp4' });
  });
});
