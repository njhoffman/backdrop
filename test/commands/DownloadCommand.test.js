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

  it('reports received bytes against Content-Length while writing the file', async () => {
    sinon.stub(axios, 'get').resolves({ data: Readable.from([Buffer.alloc(3), Buffer.alloc(5)]), headers: { 'content-length': '8' } });
    const progress = [];
    const file = path.join(dir, 'partial');
    await command.downloadFile('https://example.com/v', file, (received, total) => progress.push([received, total]));
    expect(progress).to.deep.equal([[3, 8], [8, 8]]);
    expect((await fs.stat(file)).size).to.equal(8);
  });

  it('passes a byte progress callback to the transfer', async () => {
    add();
    await command.download({ total: 1 });
    expect(command.transfer.firstCall.args[2]).to.be.a('function');
  });

  describe('--upgrade', () => {
    let media, file;
    const upgradeVariants = [variant(1280, 720), variant(1920, 1080), variant(3840, 2160)];
    beforeEach(async () => {
      file = path.join(dir, 'media', 'remote-1.mp4');
      await fs.outputFile(file, 'small original');
      const id = db.addMedia({ source: 'fake', source_id: 1, kind: 'video', width: 1280, height: 720, path: file,
        speed: 0.7, dim: 20, variants: upgradeVariants });
      db.addRating(id, 3, '1920x1080');
      media = db.getMedia(id);
      control.refreshMedia = sinon.stub().resolves();
    });

    it('replaces a too-small file with the smallest fitting variant and keeps its history', async () => {
      const result = await command.download({ upgrade: true });

      expect(result.upgraded).to.deep.equal([media.id]);
      expect(command.transfer.firstCall.args[0]).to.equal('https://example.com/1920');
      expect(await fs.readFile(file, 'utf8')).to.equal('https://example.com/1920');
      expect(db.getMedia(media.id)).to.include({ path: file, width: 1920, height: 1080, speed: 0.7, dim: 20, status: 'kept' });
      expect(db.getLatestRating(media.id).rating).to.equal(3);
      expect(control.refreshMedia.calledOnceWith(sinon.match({ id: media.id, path: file }))).to.be.true;
      expect(control.appendMedia.calledOnceWithExactly([media.id])).to.be.true;
      expect((await fs.readdir(path.dirname(file))).sort()).to.deep.equal(['remote-1.mp4']);
    });

    it('skips media that already fits, local and skipped items, and items without a larger variant', async () => {
      const local = db.addMedia({ source: 'local', source_id: 9, kind: 'video', width: 640, height: 360, path: '/m/local-9.mp4' });
      const big = db.addMedia({ source: 'fake', source_id: 2, kind: 'video', width: 1920, height: 1080, path: '/m/big.mp4', variants: upgradeVariants });
      const skipped = db.addMedia({ source: 'fake', source_id: 3, kind: 'video', width: 640, height: 360, path: '/t/s.mp4', variants: upgradeVariants });
      db.addRating(skipped, 0);
      db.updateMedia(media.id, { variants: [variant(1280, 720)] });

      const result = await command.download({ upgrade: true });

      expect(result).to.deep.include({ upgraded: [], skipped: 1, failed: 0 });
      expect(command.transfer.called).to.be.false;
      expect([local, big].map(id => db.getMedia(id).width)).to.deep.equal([640, 1920]);
    });

    it('keeps the original file and row when the new file is too small or the item changed', async () => {
      command.probe = async () => ({ kind: 'video', width: 1280, height: 720, duration: 12 });
      let result = await command.download({ upgrade: true });
      expect(result.failed).to.equal(1);
      expect(await fs.readFile(file, 'utf8')).to.equal('small original');

      command.probe = async () => ({ kind: 'video', width: 1920, height: 1080, duration: 12 });
      command.transfer = async (url, partial) => {
        await fs.writeFile(partial, url);
        db.updateMedia(media.id, { path: path.join(dir, 'moved.mp4') });
      };
      result = await command.download({ upgrade: true });
      expect(result.failed).to.equal(1);
      expect(await fs.readFile(file, 'utf8')).to.equal('small original');
      expect((await fs.readdir(path.dirname(file))).sort()).to.deep.equal(['remote-1.mp4']);
    });

    it('renames the file when the larger variant has another format', async () => {
      db.updateMedia(media.id, { kind: 'image', variants: [{ ...variant(1920, 1080), mime: 'image/png' }] });
      command.probe = async () => ({ kind: 'image', width: 1920, height: 1080, duration: null });

      await command.download({ upgrade: true, type: 'images' });

      const upgraded = db.getMedia(media.id);
      expect(upgraded.path).to.equal(path.join(dir, 'media', 'remote-1.png'));
      expect(await fs.pathExists(file)).to.be.false;
      expect(await fs.pathExists(upgraded.path)).to.be.true;
    });
  });

  it('propagates response stream errors rather than leaving a hung download', async () => {
    const stream = new Readable({ read() { this.destroy(new Error('stream failed')); } });
    sinon.stub(axios, 'get').resolves({ data: stream });
    let caught;
    try { await command.downloadFile('https://example.com/v', path.join(dir, 'partial')); } catch (error) { caught = error; }
    expect(caught.message).to.equal('stream failed');
  });
});
