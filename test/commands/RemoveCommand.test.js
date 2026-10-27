import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { RemoveCommand } from '../../src/commands/RemoveCommand.js';
import { Importer } from '../../src/library/Importer.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('RemoveCommand', () => {
  let tempDir, db, config, control, command, media;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-remove-'));
    config = makeConfig({ 'paths.media': path.join(tempDir, 'media') });
    db = new DatabaseManager();
    db.initialize(':memory:');
    const file = path.join(tempDir, 'media', 'local-1.png');
    await fs.outputFile(file, 'wallpaper');
    const id = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: file });
    db.addRating(id, 2);
    media = db.getMedia(id);
    control = {
      current: sinon.stub().resolves({ media, monitor: { name: 'DP-1' } }),
      removeMedia: sinon.stub().resolves()
    };
    command = new RemoveCommand(config, db, silentLogger, { control });
    sinon.stub(console, 'log');
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(tempDir);
  });

  async function fails(fn, message) {
    let error;
    try { await fn(); } catch (caught) { error = caught; }
    expect(error?.message).to.include(message);
  }

  it('removes a file, its row and ratings after removing it from playback', async () => {
    control.removeMedia.callsFake(async item => {
      expect(item.id).to.equal(media.id);
      expect(await fs.pathExists(item.path)).to.be.true;
      expect(db.getMedia(item.id)).to.not.be.null;
    });
    await command.remove(String(media.id));
    expect(await fs.pathExists(media.path)).to.be.false;
    expect(db.getMedia(media.id)).to.be.null;
    expect(db.getStats().ratings).to.equal(0);
    expect(control.current.called).to.be.false;
  });

  it('targets the current item on the selected monitor', async () => {
    await command.remove(undefined, { current: true, monitor: 'DP-1' });
    expect(control.current.calledOnceWithExactly('DP-1')).to.be.true;
    expect(db.getMedia(media.id)).to.be.null;
  });

  it('retains source records so unchanged originals are not re-imported', async () => {
    const original = path.join(tempDir, 'source.png');
    await fs.writeFile(original, 'wallpaper');
    const stat = await fs.stat(original);
    db.recordImportedFile({ source_path: original, size: stat.size, mtime_ms: stat.mtimeMs,
      media_id: media.id, status: 'imported' });
    await command.remove(String(media.id));
    expect(db.getImportedFile(original)).to.include({ media_id: null, status: 'imported' });
    const importer = new Importer({ config, database: db, logger: silentLogger,
      probe: async () => { throw new Error('must not probe unchanged originals'); } });
    expect((await importer.importFile(original)).status).to.equal('unchanged');
    expect(await fs.readFile(original, 'utf8')).to.equal('wallpaper');
  });

  it('removes rows for undownloaded or already missing files', async () => {
    await fs.unlink(media.path);
    await command.remove(String(media.id));
    const id = db.addMedia({ kind: 'video', source: 'pexels', source_id: 1 });
    await command.remove(String(id));
    expect(db.findMedia()).to.deep.equal([]);
  });

  it('rejects invalid or ambiguous targets before touching playback', async () => {
    for (const id of [undefined, '0', '-1', '1.5', '1abc', '9007199254740992']) {
      await fails(() => command.remove(id), 'Specify a media id or --current');
    }
    await fails(() => command.remove(String(media.id), { current: true }), 'either');
    await fails(() => command.remove(String(media.id), { monitor: 'DP-1' }), '--current');
    await fails(() => command.remove('999'), 'not found');
    expect(control.removeMedia.called).to.be.false;
    expect(await fs.pathExists(media.path)).to.be.true;
  });

  it('rejects idle or unrecognized current paths', async () => {
    control.current.resolves({ media: null, monitor: { name: 'DP-1' } });
    await fails(() => command.remove(undefined, { current: true }), 'Nothing from the library');
    expect(control.removeMedia.called).to.be.false;
  });

  it('preserves the file and row when playback cannot be updated', async () => {
    control.removeMedia.rejects(new Error('socket unavailable'));
    await fails(() => command.remove(String(media.id)), 'socket unavailable');
    expect(db.getMedia(media.id)).to.not.be.null;
    expect(await fs.pathExists(media.path)).to.be.true;
  });

  it('preserves the row when the file cannot be deleted', async () => {
    sinon.stub(fs, 'unlink').rejects(new Error('permission denied'));
    await fails(() => command.remove(String(media.id)), 'permission denied');
    expect(db.getMedia(media.id)).to.not.be.null;
    expect(await fs.pathExists(media.path)).to.be.true;
  });
});
