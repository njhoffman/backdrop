import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { CONTROL_REQUEST, controlPath, controlRequestPath, statePath } from '../../src/display/runtimeFiles.js';
import { requestId, sendControl } from '../../src/display/control.js';

describe('sendControl', () => {
  let dir, signals;
  // The daemon's state; readState treats it as live because this test process's pid is running
  const writeState = state => fs.writeJson(statePath(dir), { pid: process.pid, control: 0, monitors: [], ...state });
  const pendingIds = async () => (await fs.readdir(dir)).map(name => CONTROL_REQUEST.exec(name)?.[1]).filter(Boolean).sort();

  // A daemon that, a moment after each signal, takes every pending request and lists its id as handled,
  // one signal at a time as the daemon's queue does
  const answering = (handled = [], requests = []) => {
    let queue = Promise.resolve();
    return () => {
      signals.push('SIGUSR1');
      queue = queue.then(() => take(handled, requests));
    };
  };
  const take = async (handled, requests) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    for (const id of await pendingIds()) {
      const file = controlRequestPath(dir, id);
      if (!await fs.pathExists(file)) continue;
      requests.push(await fs.readJson(file));
      await fs.remove(file);
      handled.push(id);
    }
    await writeState({ control: handled.length, handled: [...handled] });
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-control-'));
    signals = [];
  });
  afterEach(async () => { await fs.remove(dir); });

  it('makes unique ids that sort by time first', () => {
    const later = requestId(10_000, 1);
    const earlier = [requestId(9_999, 99_999), requestId(9_999, 99_999)];
    expect([later, ...earlier].sort()).to.deep.equal([...earlier, later]);
    expect(earlier[0]).to.not.equal(earlier[1]);
    expect(CONTROL_REQUEST.exec(path.basename(controlRequestPath(dir, later)))[1]).to.equal(later);
  });

  it('writes one file per request and waits for its own id, so two at once both arrive', async () => {
    await writeState({ handled: [] });
    const state = { pid: process.pid, control: 0, handled: [] };
    const requests = [];
    const kill = answering([], requests);
    const [first, second] = await Promise.all([
      sendControl(dir, state, { durations: true }, { kill, id: 'a' }),
      sendControl(dir, state, { wallpaper: false }, { kill, id: 'b' })
    ]);
    expect(requests).to.deep.equal([{ pid: process.pid, durations: true }, { pid: process.pid, wallpaper: false }]);
    expect(first.handled).to.include('a');
    expect(second.handled).to.include('b');
    expect(await fs.readdir(dir)).to.deep.equal(['state.json']);
  });

  it('does not take another request moving the counter as its answer', async () => {
    await writeState({ handled: [] });
    const state = { pid: process.pid, control: 0, handled: [] };
    const kill = async () => { await writeState({ control: 1, handled: ['other'] }); };
    const error = await sendControl(dir, state, { durations: true }, { kill, id: 'mine', timeout: 150 }).catch(caught => caught);
    expect(error.message).to.equal('The daemon did not answer');
    // Withdrawn, so a late daemon does not apply it by surprise
    expect(await pendingIds()).to.deep.equal([]);
  });

  it('withdraws the request when the signal fails', async () => {
    const kill = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); };
    const error = await sendControl(dir, { pid: process.pid, control: 0, handled: [] }, { wallpaper: true }, { kill, id: 'x' }).catch(caught => caught);
    expect(error.message).to.equal('kill ESRCH');
    expect(await fs.pathExists(controlRequestPath(dir, 'x'))).to.be.false;
  });

  it('writes control.json and waits on the counter for a daemon before 2.38.2', async () => {
    await writeState({});
    const kill = async () => {
      expect(await fs.readJson(controlPath(dir))).to.deep.equal({ pid: process.pid, preset: 'calm' });
      setTimeout(() => writeState({ control: 1 }), 5);
    };
    const state = await sendControl(dir, { pid: process.pid, control: 0 }, { preset: 'calm' }, { kill });
    expect(state.control).to.equal(1);
  });

  it('resolves to null when the daemon stopped because of the request', async () => {
    const kill = async () => { await fs.remove(statePath(dir)); };
    expect(await sendControl(dir, { pid: process.pid, control: 0, handled: [] }, { wallpaper: false }, { kill, id: 'z' })).to.be.null;
  });
});
