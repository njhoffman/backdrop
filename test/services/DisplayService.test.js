import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { statePath } from '../../src/display/Daemon.js';
import { DisplayService } from '../../src/services/DisplayService.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// The service returns what changed and never prints; DisplayCommand.test.js covers the same steps through the CLI
describe('DisplayService', () => {
  let dir, db, config, printed;
  const monitor = { name: 'DP-1', width: 1920, height: 1080 };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-display-service-'));
    config = makeConfig({ 'paths.runtime': dir });
    db = new DatabaseManager();
    db.initialize(':memory:');
    printed = [];
    sinon.stub(console, 'log').callsFake(line => printed.push(line));
    sinon.stub(console, 'error').callsFake(line => printed.push(line));
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(dir);
  });

  const make = options => new DisplayService({ config, database: db, logger: silentLogger, ...options });

  it('says what a stop found: orphans, nothing, or a stopped daemon', async () => {
    let orphans = [{ pid: 10, command: 'xwinwrap' }];
    const service = make({ reap: async () => orphans });
    expect(await service.stop()).to.deep.equal({ action: 'reaped', orphans });
    orphans = [];
    expect(await service.stop()).to.deep.equal({ action: 'not-running' });
    expect(printed).to.deep.equal([]);
  });

  it('reports a running daemon on start without spawning another', async () => {
    const state = { pid: process.pid, control: 0, monitors: [monitor] };
    await fs.writeJson(statePath(dir), state);
    const spawnProcess = sinon.stub();
    expect(await make({ spawnProcess }).start()).to.deep.equal({ action: 'running', state });
    expect(spawnProcess.called).to.be.false;
  });

  it('switches the mode, returning what the target plays only when the wallpaper shows', async () => {
    const playing = { monitor, path: '/m/1.mp4', media: null, rating: null };
    const service = make();
    service.control = {
      state: async () => ({ wallpaper: true }),
      switchTo: sinon.stub().callsFake(async (name, change) => ({ ...playing, result: await change() })),
      mode: async () => ({ mode: 'image', counts: { 'DP-1': 3 } })
    };
    const result = await service.mode('image', { monitor: 'DP-1' });
    expect(result).to.include({ mode: 'image', running: true });
    expect(result.playing).to.include({ path: '/m/1.mp4' });

    service.control.state = async () => ({ wallpaper: false });
    expect(await service.mode('video')).to.include({ running: true, playing: null });
    service.control.state = async () => null;
    expect(await service.mode('video')).to.include({ running: false, playing: null });
  });

  it('plays the next and previous items, returning them with the options in effect', async () => {
    const playing = { monitor, path: '/m/2.mp4', media: null, rating: null };
    const service = make();
    service.control = { next: sinon.stub().resolves(playing), prev: sinon.stub().resolves(playing) };
    const next = await service.next({ monitor: 'DP-1' });
    expect(next.playing).to.equal(playing);
    expect(next.options).to.include({ monitor: 'DP-1' });
    expect(service.control.next.firstCall.args[0]).to.equal('DP-1');
    expect((await service.prev({ monitor: 'DP-1' })).playing).to.equal(playing);
  });

  it('gives the status as data while the daemon is stopped', async () => {
    const status = await make().status();
    expect(status.daemon).to.include({ running: false, pid: null });
    expect(status.monitors).to.deep.equal([]);
    expect(status.mode).to.equal('video');
  });
});
