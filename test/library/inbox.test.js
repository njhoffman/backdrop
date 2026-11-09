import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { moveLegacyInbox } from '../../src/library/inbox.js';
import { silentLogger } from '../helpers/fakes.js';

describe('moveLegacyInbox', () => {
  let dir, db, legacy, inbox, media;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-inbox-'));
    legacy = path.join(dir, 'cache', 'inbox');
    inbox = path.join(dir, 'data', 'inbox');
    media = path.join(dir, 'data', 'media');
    db = new DatabaseManager();
    db.initialize(':memory:');
  });

  afterEach(async () => {
    db.close();
    await fs.remove(dir);
  });

  async function item(n, folder = legacy) {
    const file = path.join(folder, `remote-${n}.mp4`);
    await fs.outputFile(file, `video ${n}`);
    return db.addMedia({ kind: 'video', source: 'pexels', source_id: String(n), path: file, width: 1920, height: 1080 });
  }

  it('moves the unrated downloads, their paths, and the paths undo puts a kept file back to', async () => {
    const unrated = await item(1);
    const kept = await item(2, media);
    // Kept from the old inbox: undo would move it back there
    db.addRating(kept, 2, null, { previousPath: path.join(legacy, 'remote-2.mp4'), ratedPath: path.join(media, 'remote-2.mp4') });
    const elsewhere = await item(3, path.join(legacy, 'nested'));

    const result = await moveLegacyInbox({ legacy, inbox, database: db, logger: silentLogger });
    expect(result).to.deep.equal({ moved: 1, left: 1, ratings: 1 });
    expect(db.getMedia(unrated).path).to.equal(path.join(inbox, 'remote-1.mp4'));
    expect(await fs.readFile(path.join(inbox, 'remote-1.mp4'), 'utf8')).to.equal('video 1');
    expect(db.getMedia(kept).path).to.equal(path.join(media, 'remote-2.mp4'));
    const rating = db.getLatestRating(kept);
    expect([rating.previous_path, rating.rated_path]).to.deep.equal([path.join(inbox, 'remote-2.mp4'), path.join(media, 'remote-2.mp4')]);
    // Only files directly in the folder are the inbox's; the folder stays while anything is left
    expect(db.getMedia(elsewhere).path).to.equal(path.join(legacy, 'nested', 'remote-3.mp4'));
    expect(await fs.pathExists(legacy)).to.equal(true);
  });

  it('leaves a file whose name is taken in the new inbox, and removes the old folder once it is empty', async () => {
    const clash = await item(1);
    await fs.outputFile(path.join(inbox, 'remote-1.mp4'), 'another');
    expect(await moveLegacyInbox({ legacy, inbox, database: db, logger: silentLogger })).to.deep.equal({ moved: 0, left: 1, ratings: 0 });
    expect(db.getMedia(clash).path).to.equal(path.join(legacy, 'remote-1.mp4'));

    await fs.remove(path.join(inbox, 'remote-1.mp4'));
    expect(await moveLegacyInbox({ legacy, inbox, database: db, logger: silentLogger })).to.deep.equal({ moved: 1, left: 0, ratings: 0 });
    expect(await fs.pathExists(legacy)).to.equal(false);
  });

  it('does nothing without an old inbox, or when the inbox is still there', async () => {
    expect(await moveLegacyInbox({ legacy, inbox, database: db, logger: silentLogger })).to.equal(null);
    await item(1);
    expect(await moveLegacyInbox({ legacy, inbox: legacy, database: db, logger: silentLogger })).to.equal(null);
    expect(await fs.pathExists(path.join(legacy, 'remote-1.mp4'))).to.equal(true);
  });
});
