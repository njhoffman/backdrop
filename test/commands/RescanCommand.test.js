import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { RescanCommand } from '../../src/commands/RescanCommand.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('RescanCommand', () => {
  let dir, db, command, probe, control, lines, probed;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-rescan-'));
    db = new DatabaseManager(); db.initialize(':memory:');
    probed = {};
    probe = sinon.stub().callsFake(async file => probed[file] ?? null);
    control = { refreshMedia: sinon.stub().resolves(), appendMedia: sinon.stub().resolves({}) };
    command = new RescanCommand(makeConfig(), db, silentLogger, { probe, control });
    lines = [];
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
    sinon.stub(console, 'error').callsFake(line => lines.push(line));
  });
  afterEach(async () => { sinon.restore(); db.close(); await fs.remove(dir); process.exitCode = 0; });

  async function add(name, fields, info) {
    const file = path.join(dir, name);
    await fs.outputFile(file, name);
    probed[file] = info;
    return db.addMedia({ source: 'local', source_id: name, path: file, width: 1920, height: 1080, duration: 10, ...fields });
  }

  it('fills in missing video frame rates only, leaving images and known rates alone', async () => {
    const video = await add('a.mp4', { kind: 'video' }, { kind: 'video', width: 1920, height: 1080, duration: 10, fps: 25 });
    await add('b.mp4', { kind: 'video', fps: 30 }, { kind: 'video', width: 1920, height: 1080, duration: 10, fps: 60 });
    await add('c.png', { kind: 'image', duration: null }, { kind: 'image', width: 1920, height: 1080, duration: null, fps: null });
    const summary = await command.rescan();
    expect(probe.callCount).to.equal(1);
    expect(summary.updated).to.deep.equal([video]);
    expect(db.getMedia(video).fps).to.equal(25);
    expect(lines.join('\n')).to.include(`#${video}  fps ? → 25fps`);
    expect(control.refreshMedia.called).to.be.false;
    expect((await command.rescan()).scanned).to.equal(0);
  });

  it('with --all corrects kind, size and duration and refreshes playlists for changed sizes', async () => {
    const id = await add('a.mp4', { kind: 'video', fps: 25 }, { kind: 'video', width: 3840, height: 2160, duration: 10.2, fps: 25 });
    const same = await add('b.png', { kind: 'image', duration: null }, { kind: 'image', width: 1920, height: 1080, duration: null, fps: null });
    const summary = await command.rescan({ all: true });
    expect(summary.updated).to.deep.equal([id]);
    expect(db.getMedia(id)).to.include({ width: 3840, height: 2160, duration: 10 });
    expect(db.getMedia(same).width).to.equal(1920);
    expect(control.refreshMedia.calledOnce).to.be.true;
    expect(control.appendMedia.calledOnceWithExactly([id])).to.be.true;
  });

  it('reports missing files and failed probes, failing only for probes', async () => {
    const gone = await add('gone.mp4', { kind: 'video' }, null);
    await fs.remove(path.join(dir, 'gone.mp4'));
    await add('bad.mp4', { kind: 'video' }, null);
    const summary = await command.rescan();
    expect(summary.missing.map(media => media.id)).to.deep.equal([gone]);
    expect(summary.failed).to.have.length(1);
    expect(db.getMedia(gone)).to.not.be.null;
    expect(process.exitCode).to.equal(1);
    expect(lines.join('\n')).to.include('missing 1, failed 1');
  });
});
