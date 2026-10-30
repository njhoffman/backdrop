import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { nextFiltersPath, statePath } from '../../src/display/Daemon.js';
import { clearNextFilters, hasNextFilters, parseDuration, readNextFilters, resolveNextFilters } from '../../src/display/nextFilters.js';

describe('nextFilters', () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-filters-'));
    // readState treats the state as live because this test process's pid is running
    await fs.writeJson(statePath(dir), { pid: process.pid, monitors: [] });
  });
  afterEach(async () => { await fs.remove(dir); });

  it('stores filters and order given with persist, and fills them in for later commands', async () => {
    const given = await resolveNextFilters(dir, { monitor: 'DP-1', query: ['clouds'], random: true }, { persist: true });
    expect(given).to.deep.equal({ monitor: 'DP-1', query: ['clouds'], random: true });
    expect(await fs.readJson(nextFiltersPath(dir))).to.deep.equal({ pid: process.pid, query: ['clouds'], random: true });

    expect(await resolveNextFilters(dir, { monitor: 'DP-2' })).to.deep.equal({ monitor: 'DP-2', query: ['clouds'], random: true });
    // Without persist a flag applies once
    expect(await resolveNextFilters(dir, { random: false })).to.include({ random: false });
    expect(await readNextFilters(dir)).to.deep.equal({ query: ['clouds'], random: true });
  });

  it('replaces the filters as a set, keeps them when only the order changes, and clears them', async () => {
    await resolveNextFilters(dir, { query: ['clouds'], tag: ['sky'] }, { persist: true });
    await resolveNextFilters(dir, { tag: ['sea'] }, { persist: true });
    expect(await readNextFilters(dir)).to.deep.equal({ tag: ['sea'] });
    await resolveNextFilters(dir, { random: false }, { persist: true });
    expect(await readNextFilters(dir)).to.deep.equal({ tag: ['sea'], random: false });

    expect(await resolveNextFilters(dir, { clear: true }, { persist: true })).to.deep.equal({ clear: true, random: undefined });
    expect(await fs.pathExists(nextFiltersPath(dir))).to.be.false;
    await resolveNextFilters(dir, { clear: true, keywords: ['dusk'] }, { persist: true });
    expect(await readNextFilters(dir)).to.deep.equal({ keywords: ['dusk'] });
    await clearNextFilters(dir);
    expect(hasNextFilters(await readNextFilters(dir))).to.be.false;
  });

  it('parses durations in seconds, minutes or hours', () => {
    expect(parseDuration('--image-duration', '90')).to.equal(90);
    expect(parseDuration('--image-duration', '1.5m')).to.equal(90);
    expect(parseDuration('--video-duration', '2h')).to.equal(7200);
    expect(parseDuration('--video-duration', '0', { allowZero: true })).to.equal(0);
    expect(() => parseDuration('--image-duration', '0')).to.throw('--image-duration must be a time such as 90, 90s, 5m or 1h, not 0');
    expect(() => parseDuration('--video-duration', 'soon', { allowZero: true })).to.throw('(0 loops videos forever), not soon');
  });

  it('stores durations apart from the filters and tells the daemon when they change', async () => {
    const signals = [];
    // The daemon answers a control request by moving its state's control counter
    const kill = (pid, signal) => {
      signals.push(signal);
      setTimeout(() => fs.writeJson(statePath(dir), { pid: process.pid, monitors: [], control: signals.length }), 5);
    };
    await fs.writeJson(statePath(dir), { pid: process.pid, monitors: [], control: 0 });
    const persist = options => resolveNextFilters(dir, options, { persist: true, kill, timeout: 1000 });

    const resolved = await persist({ videoDuration: '2m', query: ['clouds'] });
    expect(resolved).to.include({ video_duration: 120 });
    expect(await fs.readJson(nextFiltersPath(dir))).to.include({ video_duration: 120 });
    expect(await fs.readJson(path.join(dir, 'control.json'))).to.deep.equal({ pid: process.pid, durations: true });
    expect(signals).to.deep.equal(['SIGUSR1']);

    // New filters keep the durations; an unchanged duration sends nothing
    await persist({ tag: ['sky'], videoDuration: '120' });
    expect(await readNextFilters(dir)).to.deep.equal({ tag: ['sky'], video_duration: 120 });
    expect(signals).to.have.length(1);
    await persist({ imageDuration: '45' });
    expect(signals).to.have.length(2);
    expect(hasNextFilters({ image_duration: 45 })).to.be.true;

    // --clear drops them too, and the daemon hears of it
    await persist({ clear: true });
    expect(await readNextFilters(dir)).to.deep.equal({});
    expect(signals).to.have.length(3);
    let caught;
    try { await persist({ imageDuration: 'later' }); } catch (error) { caught = error; }
    expect(caught.message).to.include('--image-duration must be a time');
  });

  it('ignores filters another daemon stored, and stores nothing without a running daemon', async () => {
    await fs.writeJson(nextFiltersPath(dir), { pid: process.pid + 1, query: ['old'] });
    expect(await readNextFilters(dir)).to.deep.equal({});
    await fs.remove(statePath(dir));
    await fs.remove(nextFiltersPath(dir));
    await resolveNextFilters(dir, { query: ['clouds'] }, { persist: true });
    expect(await fs.pathExists(nextFiltersPath(dir))).to.be.false;
    expect(hasNextFilters({ random: false })).to.be.true;
  });
});
