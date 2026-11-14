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

  describe('start', () => {
    // A spawned daemon that writes its state after ms, or never (null); exitCode set later by the test
    function daemonAfter(ms) {
      const child = { pid: 4321, exitCode: null, signalCode: null, unref() {} };
      const spawnProcess = () => {
        if (ms !== null) setTimeout(() => fs.writeJson(statePath(dir), { pid: process.pid, control: 0, monitors: [monitor] }), ms);
        return child;
      };
      return { child, spawnProcess };
    }

    it('waits for a slow daemon while its process runs', async () => {
      const { spawnProcess } = daemonAfter(400);
      const result = await make({ spawnProcess, timeout: 2000 }).start();
      expect(result.action).to.equal('started');
    });

    it('fails at once when the daemon exits or is killed before it starts', async () => {
      const exiting = daemonAfter(null);
      setTimeout(() => { exiting.child.exitCode = 1; }, 50);
      const began = Date.now();
      let caught;
      try { await make({ spawnProcess: exiting.spawnProcess, timeout: 5000 }).start(); } catch (error) { caught = error; }
      expect(caught.message).to.match(/^Daemon exited \(code 1\) before it started; see /);
      expect(Date.now() - began).to.be.below(2000);
      const killed = daemonAfter(null);
      setTimeout(() => { killed.child.signalCode = 'SIGKILL'; }, 50);
      caught = null;
      try { await make({ spawnProcess: killed.spawnProcess, timeout: 5000 }).start(); } catch (error) { caught = error; }
      expect(caught.message).to.match(/^Daemon was killed \(SIGKILL\) before it started/);
    });

    it('gives up after the timeout on a daemon still running without a state, saying so', async () => {
      const { spawnProcess } = daemonAfter(null);
      let caught;
      try { await make({ spawnProcess, timeout: 300 }).start(); } catch (error) { caught = error; }
      expect(caught.message).to.match(/^Daemon did not start within 0 s \(pid 4321, still running\); see /);
    });
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
