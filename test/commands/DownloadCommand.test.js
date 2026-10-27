import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import sinon from 'sinon';
import { Readable } from 'stream';
import axios from 'axios';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { DownloadCommand } from '../../src/commands/DownloadCommand.js';
import { SourceRegistry } from '../../src/sources/SourceRegistry.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

const variant = (width, height) => ({ url: `https://example.com/${width}`, width, height, mime: 'video/mp4' });

describe('DownloadCommand', () => {
  let dir, db, config, source, control, command, exitCode;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-download-'));
    db = new DatabaseManager(); db.initialize(':memory:');
    config = makeConfig({ 'paths.inbox': path.join(dir, 'inbox') });
    source = { name: 'fake', downloadVariants: async media => media.variants };
    control = { appendMedia: sinon.stub().resolves() };
    command = new DownloadCommand(config, db, silentLogger, { sources: new SourceRegistry(config, [source]), control,
      monitors: async () => [{ name: 'DP-1', width: 1920, height: 1080 }],
      probe: async () => ({ kind: 'video', width: 1920, height: 1080, duration: 12 }),
      transfer: sinon.spy(async (url, file) => fs.writeFile(file, url)) });
    exitCode = process.exitCode;
    sinon.stub(console, 'log'); sinon.stub(console, 'error');
  });
  afterEach(async () => { sinon.restore(); process.exitCode = exitCode; db.close(); await fs.remove(dir); });
  const add = (sourceId = 1, variants = [variant(3840, 2160), variant(640, 480), variant(1920, 1080)]) =>
    db.addMedia({ source: 'fake', source_id: sourceId, kind: 'video', width: 3840, height: 2160, variants });

  it('chooses the smallest fitting variant and stores measured dimensions, hash and inbox path', async () => {
    const id = add();
    const result = await command.download({ total: 1 });
    expect(result.downloaded).to.deep.equal([id]);
    expect(command.transfer.firstCall.args[0]).to.equal('https://example.com/1920');
    expect(db.getMedia(id)).to.include({ status: 'new', width: 1920, height: 1080, duration: 12 });
    expect(db.getMedia(id).sha256).to.have.length(64);
    expect(db.getMedia(id).path).to.equal(path.join(dir, 'inbox', `remote-${id}.mp4`));
    expect(control.appendMedia.calledOnceWithExactly([id])).to.be.true;
    expect(await fs.readdir(config.get().paths.inbox)).to.deep.equal([`remote-${id}.mp4`]);
  });

  it('skips undersized and already downloaded items and fills the requested successful count', async () => {
    add(1, [variant(640, 480)]);
    const done = add(2); db.updateMedia(done, { path: '/existing.mp4' });
    const next = add(3); add(4);
    const result = await command.download({ total: 1, type: 'videos', source: 'fake' });
    expect(result).to.deep.equal({ downloaded: [next], skipped: 1, failed: 0 });
    expect(command.transfer.callCount).to.equal(1);
  });

  it('rejects measured undersized files and cleans temporary data without marking downloaded', async () => {
    const id = add();
    command.probe = async () => ({ kind: 'video', width: 640, height: 480 });
    expect((await command.download()).failed).to.equal(1);
    expect(db.getMedia(id).path).to.be.null;
    expect(await fs.readdir(config.get().paths.inbox)).to.deep.equal([]);
    expect(process.exitCode).to.equal(1);
  });

  it('cleans partial files on failed transfers and continues to the next item', async () => {
    add(); const next = add(2);
    let attempts = 0;
    command.transfer = async (url, file) => {
      await fs.writeFile(file, url);
      if (++attempts === 1) throw new Error('connection reset');
    };
    expect(await command.download({ total: 1 })).to.deep.equal({ downloaded: [next], skipped: 0, failed: 1 });
    expect(await fs.readdir(config.get().paths.inbox)).to.deep.equal([`remote-${next}.mp4`]);
  });

  it('rejects duplicate content and cleans the new copy without affecting the existing item', async () => {
    const first = add(); await command.download({ total: 1 });
    const second = add(2);
    expect((await command.download()).failed).to.equal(1);
    expect(db.getMedia(second).path).to.be.null;
    expect(await fs.pathExists(db.getMedia(first).path)).to.be.true;
    expect(await fs.readdir(config.get().paths.inbox)).to.deep.equal([`remote-${first}.mp4`]);
  });

  it('validates filters and does not contact sources without known monitor dimensions', async () => {
    add();
    for (const options of [{ total: '2bad' }, { type: 'audio' }, { source: 'bad' }]) {
      let caught; try { await command.download(options); } catch (error) { caught = error; }
      expect(caught).to.be.instanceOf(Error);
    }
    command.monitors = async () => [];
    let caught; try { await command.download(); } catch (error) { caught = error; }
    expect(caught.message).to.include('--resolution');
    expect(command.transfer.called).to.be.false;
  });

  it('propagates response stream errors rather than leaving a hung download', async () => {
    const stream = new Readable({ read() { this.destroy(new Error('stream failed')); } });
    sinon.stub(axios, 'get').resolves({ data: stream });
    let caught;
    try { await command.downloadFile('https://example.com/v', path.join(dir, 'partial')); } catch (error) { caught = error; }
    expect(caught.message).to.equal('stream failed');
  });
});
