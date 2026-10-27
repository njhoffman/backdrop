import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { RatingCommand } from '../../src/commands/RatingCommand.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('RatingCommand', () => {
  let dir, db, config, control, command, id, monitor;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-rating-'));
    config = makeConfig(Object.fromEntries(['media', 'inbox', 'trash'].map(key => [`paths.${key}`, path.join(dir, key)])));
    db = new DatabaseManager(); db.initialize(':memory:');
    const file = path.join(dir, 'inbox', 'ocean.waves.mp4');
    await fs.outputFile(file, 'video');
    id = db.addMedia({ kind: 'video', source: 'pexels', source_id: 'video:1', path: file, width: 4000, height: 4000 });
    monitor = { name: 'DP-1', width: 1080, height: 1920 };
    control = { current: sinon.stub().callsFake(async () => ({ media: db.getMedia(id), monitor, rating: db.getLatestRating(id) })),
      removeMedia: sinon.stub().resolves(), refreshMedia: sinon.stub().resolves(), appendMedia: sinon.stub().resolves(), next: sinon.stub().resolves() };
    command = new RatingCommand(config, db, silentLogger, { control });
    sinon.stub(console, 'log'); sinon.stub(console, 'error');
  });
  afterEach(async () => { sinon.restore(); db.close(); await fs.remove(dir); });
  async function fails(fn, text) {
    let caught; try { await fn(); } catch (error) { caught = error; }
    expect(caught?.message).to.include(text);
  }

  it('keeps the exact socket path and records the target monitor orientation', async () => {
    const old = db.getMedia(id).path;
    await command.keep('3', { monitor: 'DP-1' });
    expect(control.current.calledOnceWithExactly('DP-1')).to.be.true;
    expect(db.getMedia(id)).to.include({ status: 'kept', path: path.join(dir, 'media', 'ocean.waves.mp4') });
    expect(db.getLatestRating(id)).to.include({ rating: 3, orientation: 'portrait', resolution: '1080x1920', previous_path: old });
    expect(await fs.pathExists(old)).to.be.false;
    expect(control.refreshMedia.calledOnce).to.be.true;
  });

  it('changes an imported current rating while retaining undo history', async () => {
    await command.keep(2);
    await command.keep(3);
    expect(db.findMedia({ minRating: 3 }).map(m => m.id)).to.deep.equal([id]);
    await command.undo();
    expect(db.getLatestRating(id).rating).to.equal(2);
    expect(db.findMedia({ minRating: 3 })).to.deep.equal([]);
  });

  it('skips on all monitors before moving, and a fresh command can undo it', async () => {
    await command.keep(2);
    const kept = db.getMedia(id).path;
    control.removeMedia.callsFake(async item => expect(await fs.pathExists(item.path)).to.be.true);
    await command.skip();
    const trash = db.getMedia(id).path;
    expect(db.getMedia(id).status).to.equal('skipped');
    expect(path.dirname(trash)).to.equal(config.get().paths.trash);
    const fresh = new RatingCommand(config, db, silentLogger, { control });
    await fresh.undo();
    expect(db.getMedia(id)).to.include({ path: kept, status: 'kept' });
    expect(db.getLatestRating(id).rating).to.equal(2);
    expect(await fs.pathExists(trash)).to.be.false;
    expect(await fs.pathExists(kept)).to.be.true;
  });

  it('restores an unreviewed download to the inbox on undo', async () => {
    const original = db.getMedia(id).path;
    await command.skip(); await command.undo();
    expect(db.getMedia(id)).to.include({ status: 'new', path: original });
    expect(db.getLatestRating(id)).to.be.null;
  });

  it('undoes globally in rating order and does nothing with no history', async () => {
    expect(await command.undo()).to.be.null;
    await command.keep();
    const other = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: path.join(dir, 'media', 'b.png') });
    await fs.outputFile(db.getMedia(other).path, 'image');
    await command.rate(db.getMedia(other), 3);
    await command.undo();
    expect(db.getLatestRating(id).rating).to.equal(1);
    expect(db.getLatestRating(other)).to.be.null;
  });

  it('rejects bad ratings and idle monitors without changing anything', async () => {
    for (const rating of ['2abc', '1.5', '4', '0', '-1', '']) await fails(() => command.keep(rating), 'integer');
    control.current.resolves({ media: null, monitor });
    await fails(() => command.keep(), 'Nothing from the library');
    expect(db.getStats().ratings).to.equal(0);
  });

  it('preserves existing destination files and ratings on a move failure', async () => {
    const target = path.join(dir, 'media', 'ocean.waves.mp4');
    await fs.outputFile(target, 'other');
    await fails(() => command.keep(), 'already exists');
    expect(await fs.readFile(target, 'utf8')).to.equal('other');
    expect(db.getLatestRating(id)).to.be.null;
    expect(await fs.pathExists(db.getMedia(id).path)).to.be.true;
  });

  it('restores the file and rolls back the rating if updating the database fails', async () => {
    const original = db.getMedia(id).path;
    sinon.stub(db, 'updateMedia').throws(new Error('database failed'));
    await fails(() => command.keep(), 'database failed');
    expect(db.getMedia(id)).to.include({ status: 'new', path: original });
    expect(db.getLatestRating(id)).to.be.null;
    expect(await fs.pathExists(original)).to.be.true;
  });

  it('keeps the latest rating intact when undo cannot restore its file', async () => {
    const original = db.getMedia(id).path;
    await command.keep();
    await fs.outputFile(original, 'collision');
    await fails(() => command.undo(), 'already exists');
    expect(db.getLatestRating(id).rating).to.equal(1);
    expect(db.getMedia(id).status).to.equal('kept');
  });

  it('reports a committed rating as successful if playlist synchronization fails', async () => {
    control.refreshMedia.rejects(new Error('socket closed'));
    await command.keep();
    expect(db.getMedia(id).status).to.equal('kept');
    expect(console.error.called).to.be.true;
  });

  it('go-next requires a rating and uses the resolved monitor rather than a shell hook', async () => {
    await fails(() => command.goNext(), 'Rate this item');
    await command.keep();
    await command.goNext({ monitor: 'DP-1' });
    expect(control.next.calledOnceWithExactly('DP-1')).to.be.true;
  });

  it('restores playback references after a skip file move fails', async () => {
    const original = db.getMedia(id).path;
    await fs.outputFile(path.join(dir, 'trash', path.basename(original)), 'collision');
    await fails(() => command.skip(), 'already exists');
    expect(db.getMedia(id)).to.include({ status: 'new', path: original });
    expect(db.getLatestRating(id)).to.be.null;
    expect(control.appendMedia.calledOnceWithExactly([id])).to.be.true;
  });

  it('restores pre-v4/import history using the directory for the prior status', async () => {
    await command.keep(2);
    // Imported/pre-v4 ratings have no movement history.
    db.db.prepare('UPDATE ratings SET previous_path = NULL, rated_path = NULL').run();
    await command.undo();
    expect(db.getMedia(id)).to.include({ status: 'new', path: path.join(dir, 'inbox', 'ocean.waves.mp4') });
    expect(db.getLatestRating(id)).to.be.null;
  });

  it('does not report a failed undo when only its post-commit playlist update fails', async () => {
    await command.skip();
    await command.rate(db.getMedia(id), 2);
    control.removeMedia.rejects(new Error('socket closed'));
    await command.undo();
    expect(db.getMedia(id).status).to.equal('skipped');
    expect(db.getLatestRating(id).rating).to.equal(0);
    expect(console.error.called).to.be.true;
  });
});
