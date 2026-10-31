import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { ImportLock, importLockPath } from '../../src/library/importLock.js';
import { makeConfig } from '../helpers/fakes.js';

describe('ImportLock', () => {
  let dir;
  let file;
  // Fake /proc: pid -> start time; missing pids are gone
  let starts;
  const lockFor = (pid, options = {}) => new ImportLock(file, { pid, readStart: p => starts[p] ?? null, pollMs: 5, ...options });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-lock-'));
    file = path.join(dir, 'library', 'import.lock');
    starts = { 100: '500', 200: '600' };
  });
  afterEach(() => fs.remove(dir));

  it('sits beside the media directory', () => {
    const config = makeConfig({ 'paths.media': '/data/backdrop/media' });
    expect(importLockPath(config)).to.equal('/data/backdrop/import.lock');
  });

  it('is taken by one process at a time and freed on release', () => {
    const first = lockFor(100);
    const second = lockFor(200);

    expect(first.tryAcquire()).to.be.true;
    expect(second.tryAcquire()).to.be.false;
    expect(second.holder()).to.deep.equal({ pid: 100 });

    first.release();
    expect(fs.existsSync(file)).to.be.false;
    expect(second.tryAcquire()).to.be.true;
  });

  it('takes over a lock whose holder is gone', () => {
    lockFor(100).tryAcquire();
    delete starts[100];

    expect(lockFor(200).tryAcquire()).to.be.true;
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).to.equal(200);
  });

  it('takes over a lock whose pid now belongs to another process', () => {
    lockFor(100).tryAcquire();
    starts[100] = '999';

    expect(lockFor(200).tryAcquire()).to.be.true;
  });

  it('respects an unreadable lock while it is fresh and ignores it once old', () => {
    fs.outputFileSync(file, '');
    let now = fs.statSync(file).mtimeMs + 1000;
    const lock = lockFor(200, { now: () => now });

    expect(lock.tryAcquire()).to.be.false;
    now += 60_000;
    expect(lock.tryAcquire()).to.be.true;
  });

  it('leaves a lock alone on release once another process has taken it over', () => {
    const first = lockFor(100);
    first.tryAcquire();
    delete starts[100];
    lockFor(200).tryAcquire();

    first.release();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).to.equal(200);
  });

  it('waits for the holder to finish, telling the caller once', async () => {
    const first = lockFor(100);
    first.tryAcquire();
    const waits = [];
    setTimeout(() => first.release(), 30);

    expect(await lockFor(200).acquire({ onWait: holder => waits.push(holder) })).to.be.true;
    expect(waits).to.deep.equal([{ pid: 100 }]);
  });

  it('stops waiting when asked', async () => {
    lockFor(100).tryAcquire();
    let stop = false;
    setTimeout(() => { stop = true; }, 20);

    expect(await lockFor(200).acquire({ shouldStop: () => stop })).to.be.false;
  });
});
