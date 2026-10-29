import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { purgeTrash, trashDays } from '../../src/library/purge.js';
import { PurgeCommand } from '../../src/commands/PurgeCommand.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('trash purge', () => {
  let dir, db, config;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-purge-'));
    config = makeConfig({ 'paths.trash': path.join(dir, 'trash'), 'library.trash_days': 30 });
    db = new DatabaseManager();
    db.initialize(':memory:');
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(dir);
  });

  // A skipped item whose file sits in `folder`, skipped `age` days ago
  async function skipped(name, { age = 31, folder = 'trash' } = {}) {
    const file = path.join(dir, folder, name);
    await fs.outputFile(file, 'media');
    const id = db.addMedia({ kind: 'image', source: 'pexels', source_id: name, path: file });
    db.addRating(id, 0);
    db.db.prepare(`UPDATE media SET status_changed_at = datetime('now', ?) WHERE id = ?`).run(`-${age} days`, id);
    return id;
  }

  const run = (options = {}) => purgeTrash({ config, database: db, logger: silentLogger, ...options });

  it('deletes expired trash files and keeps their rows and ratings with no path', async () => {
    const old = await skipped('old.jpg');
    const recent = await skipped('recent.jpg', { age: 5 });
    const file = db.getMedia(old).path;

    const result = await run();

    expect(result.purged.map(m => m.id)).to.deep.equal([old]);
    expect(await fs.pathExists(file)).to.be.false;
    expect(db.getMedia(old)).to.include({ path: null, status: 'skipped' });
    expect(db.getLatestRating(old)).to.include({ rating: 0, final: 1 });
    // Undo skips the purged item and reaches the recent skip, whose file still exists
    expect(db.getLastRating().media_id).to.equal(recent);
    expect(await fs.pathExists(db.getMedia(recent).path)).to.be.true;
    expect((await run()).purged).to.deep.equal([]);
  });

  it('lists without deleting on a dry run', async () => {
    const id = await skipped('old.jpg');
    const result = await run({ dryRun: true });
    expect(result.purged.map(m => m.id)).to.deep.equal([id]);
    expect(await fs.pathExists(db.getMedia(id).path)).to.be.true;
  });

  it('treats an already missing file as purged', async () => {
    const id = await skipped('old.jpg');
    await fs.remove(db.getMedia(id).path);
    expect((await run()).purged.map(m => m.id)).to.deep.equal([id]);
    expect(db.getMedia(id).path).to.be.null;
  });

  it('leaves the row for the next run when unlink fails', async () => {
    const id = await skipped('old.jpg');
    const unlink = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    const result = await run({ unlink });
    expect(result.failed.map(m => m.id)).to.deep.equal([id]);
    expect(db.getMedia(id).path).to.not.be.null;
  });

  it('never deletes skipped files outside the trash folder', async () => {
    const id = await skipped('stray.jpg', { folder: 'media' });
    const result = await run();
    expect(result.failed.map(m => m.id)).to.deep.equal([id]);
    expect(await fs.pathExists(db.getMedia(id).path)).to.be.true;
  });

  it('is disabled by trash_days 0 and rejects invalid values', async () => {
    const id = await skipped('old.jpg');
    config.set('library.trash_days', 0);
    expect(await run()).to.deep.include({ disabled: true, purged: [] });
    expect(await fs.pathExists(db.getMedia(id).path)).to.be.true;
    for (const bad of [-1, 1.5, '30']) {
      config.set('library.trash_days', bad);
      expect(() => trashDays(config)).to.throw('trash_days');
    }
  });

  describe('PurgeCommand', () => {
    beforeEach(() => {
      sinon.stub(console, 'log');
      sinon.stub(console, 'error');
    });
    afterEach(() => { process.exitCode = undefined; });

    it('reports what was purged or would be', async () => {
      const id = await skipped('old.jpg');
      const command = new PurgeCommand(config, db, silentLogger);
      await command.purge({ dryRun: true });
      expect(console.log.calledWithMatch(`Would purge #${id}`)).to.be.true;
      await command.purge();
      expect(console.log.calledWithMatch(`Purged #${id}`)).to.be.true;
      expect(console.log.calledWithMatch('Purged 1 item(s) skipped more than 30 day(s) ago')).to.be.true;
    });

    it('says when purging is disabled and fails when an item could not be purged', async () => {
      const command = new PurgeCommand(config, db, silentLogger);
      config.set('library.trash_days', 0);
      await command.purge();
      expect(console.log.calledWithMatch('disabled')).to.be.true;

      config.set('library.trash_days', 30);
      await skipped('stray.jpg', { folder: 'media' });
      await command.purge();
      expect(process.exitCode).to.equal(1);
    });
  });
});
