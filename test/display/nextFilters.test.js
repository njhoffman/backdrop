import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { nextFiltersPath, statePath } from '../../src/display/Daemon.js';
import { clearNextFilters, hasNextFilters, readNextFilters, resolveNextFilters } from '../../src/display/nextFilters.js';

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
