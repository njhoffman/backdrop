import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { ScreensaverCommand } from '../../src/commands/ScreensaverCommand.js';
import { statePath } from '../../src/display/Daemon.js';
import { screensaverPath } from '../../src/display/runtimeFiles.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';
import { notifications } from '../helpers/setup.js';

describe('ScreensaverCommand', () => {
  let dir, config, lines, signals, runs, daemon;

  const writeState = extra => fs.writeJson(statePath(dir), {
    pid: process.pid, version: '2.89.2', control: 0, handled: [], monitors: [], screensaver: { active: false }, ...extra
  });
  // Stands in for the daemon on SIGUSR1: takes each control request in the runtime dir, hands it to answer(request),
  // whose result becomes the state's screensaver, and lists the request's id as handled
  const fakeDaemon = answer => async () => {
    const names = (await fs.readdir(dir)).filter(name => /^control-.+\.json$/.test(name));
    const state = await fs.readJson(statePath(dir));
    for (const name of names) {
      const request = await fs.readJson(path.join(dir, name));
      await fs.remove(path.join(dir, name));
      state.screensaver = answer(request);
      state.handled = [...state.handled, name.slice('control-'.length, -'.json'.length)];
    }
    await fs.writeJson(statePath(dir), state);
  };
  const command = (options = {}) => new ScreensaverCommand(config, null, silentLogger, {
    run: async (file, args) => { runs.push([file, ...args]); return ''; },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      daemon?.().catch(() => {});
    },
    timeout: 300,
    ...options
  });
  const fails = async action => {
    try {
      await command().run(action);
    } catch (error) {
      return error.message;
    }
    return null;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-saver-'));
    config = makeConfig({ 'paths.runtime': dir, 'paths.logfile': '/logs/backdrop.log' });
    lines = [];
    signals = [];
    runs = [];
    daemon = null;
    notifications.length = 0;
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
  });
  afterEach(async () => {
    sinon.restore();
    await fs.remove(dir);
  });

  describe('status', () => {
    it('reads the mode from the state without asking the daemon', async () => {
      await command().run('status');
      expect(lines.at(-1)).to.include('Screensaver off');
      await writeState({ screensaver: { active: true, trigger: 'idle' } });
      await command().run('status');
      expect(lines.at(-1)).to.include('Screensaver on (idle)');
      await writeState({ screensaver: { active: false } });
      await command().run('status');
      expect(lines.at(-1)).to.include('Screensaver off');
      expect(signals).to.deep.equal([]);
    });
  });

  describe('with the daemon running', () => {
    it('asks for the action and reports the mode the daemon answers with', async () => {
      await writeState();
      const requests = [];
      daemon = fakeDaemon(request => {
        requests.push(request);
        return { active: request.screensaver !== 'off', trigger: 'manual' };
      });
      await command().run('on');
      expect(lines.at(-1)).to.include('Screensaver on');
      await command().run('off');
      expect(lines.at(-1)).to.include('Screensaver off');
      await command().run();
      expect(requests).to.deep.equal([
        { pid: process.pid, screensaver: 'on' }, { pid: process.pid, screensaver: 'off' }, { pid: process.pid, screensaver: 'toggle' }
      ]);
      expect(signals).to.deep.equal([[process.pid, 'SIGUSR1'], [process.pid, 'SIGUSR1'], [process.pid, 'SIGUSR1']]);
      // Every request was taken, none left behind
      expect((await fs.readdir(dir)).filter(name => name.startsWith('control-'))).to.deep.equal([]);
    });

    it('says the daemon did not answer, pointing at the log, and withdraws the request', async () => {
      await writeState();
      expect(await fails('toggle')).to.equal('The daemon did not answer; see /logs/backdrop.log');
      expect((await fs.readdir(dir)).filter(name => name.startsWith('control-'))).to.deep.equal([]);
    });

    it('turns down a daemon too old for control requests without signalling it', async () => {
      await writeState({ control: undefined });
      expect(await fails('on')).to.include('cannot take this request');
      expect(signals).to.deep.equal([]);
    });
  });

  describe('with no daemon', () => {
    it('puts back the desktop a crashed daemon left in screensaver mode, for off and the toggle', async () => {
      for (const action of ['off', 'toggle']) {
        runs = [];
        await fs.writeJson(screensaverPath(dir), { restore: 'workspace 3', onLeave: ['polybar-msg cmd show'] });
        await command().run(action);
        expect(lines.at(-1)).to.include('Screensaver off (the daemon had stopped)');
        expect(runs).to.deep.equal([
          ['i3-msg', 'mode', 'default'], ['sh', '-c', 'polybar-msg cmd show'], ['i3-msg', 'workspace 3']
        ]);
        expect(await fs.pathExists(screensaverPath(dir))).to.equal(false);
      }
    });

    it('is already off for off, and notifies and fails for on and the toggle', async () => {
      await command().run('off');
      expect(lines.at(-1)).to.include('Screensaver off');
      expect(notifications).to.have.length(0);
      for (const action of ['on', 'toggle']) {
        expect(await fails(action)).to.equal('The daemon is not running; start it with `backdrop start`');
      }
      expect(notifications).to.have.length(2);
      expect(runs).to.deep.equal([]);
    });

    it('leaves a saved desktop alone for on, which needs the daemon', async () => {
      await fs.writeJson(screensaverPath(dir), { restore: 'workspace 3' });
      expect(await fails('on')).to.include('The daemon is not running');
      expect(runs).to.deep.equal([]);
      expect(await fs.pathExists(screensaverPath(dir))).to.equal(true);
    });
  });
});
