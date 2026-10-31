import { expect } from 'chai';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ChildRegistry, childrenPath, findOrphans, processStart, reapOrphans } from '../../src/display/children.js';
import { FakeChild } from '../helpers/fakes.js';

const exited = child => (child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise(resolve => child.once('exit', resolve)));

describe('child processes', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-children-')); });
  afterEach(async () => fs.remove(dir));

  const writeRecord = (children, daemon = 999999) => fs.writeJson(childrenPath(dir), { daemon, children });

  describe('processStart', () => {
    it('reads a process start time from /proc and is null for a missing process', () => {
      expect(processStart(process.pid)).to.match(/^\d+$/);
      expect(processStart(process.pid)).to.equal(processStart(process.pid));
      expect(processStart(2 ** 22 + 1)).to.equal(null);
    });
  });

  describe('ChildRegistry', () => {
    it('records each spawned child with its group and start time until it exits', async () => {
      const registry = new ChildRegistry({ runtimeDir: () => dir, pid: 77, readStart: pid => `t${pid}` });
      let next = 500;
      const spawnFake = registry.track(() => new FakeChild(next++));
      const group = spawnFake('/usr/bin/xwinwrap', [], { detached: true });
      const plain = spawnFake('pactl', ['subscribe'], {});
      expect(await fs.readJson(childrenPath(dir))).to.deep.equal({
        daemon: 77,
        children: [
          { pid: 500, group: true, command: 'xwinwrap', start: 't500' },
          { pid: 501, group: false, command: 'pactl', start: 't501' }
        ]
      });

      group.exit(0);
      expect((await fs.readJson(childrenPath(dir))).children.map(child => child.pid)).to.deep.equal([501]);
      plain.exit(0);
      expect(await fs.pathExists(childrenPath(dir))).to.equal(false);
    });

    it('passes through a child that failed to launch without a pid', () => {
      const registry = new ChildRegistry({ runtimeDir: () => dir, readStart: () => '1' });
      const child = registry.track(() => new FakeChild(undefined))('missing', []);
      expect(child.pid).to.equal(undefined);
      expect(fs.pathExistsSync(childrenPath(dir))).to.equal(false);
    });
  });

  describe('reapOrphans', () => {
    it('signals the recorded processes still running, groups as groups, and clears the runtime files', async () => {
      await writeRecord([
        { pid: 10, group: true, command: 'xwinwrap', start: 'a' },
        { pid: 11, group: false, command: 'pactl', start: 'b' },
        // Reused pid: the start time no longer matches
        { pid: 12, group: true, command: 'glava', start: 'c' },
        // Already gone
        { pid: 13, group: true, command: 'glava', start: 'd' },
        // Recorded without /proc: never signalled
        { pid: 14, group: true, command: 'xwinwrap', start: null }
      ]);
      for (const name of ['state.json', 'DP-1.sock', 'DP-1.m3u', 'control.json', 'next-filters.json', 'keep.txt']) {
        await fs.writeFile(path.join(dir, name), '');
      }
      const starts = { 10: 'a', 11: 'b', 12: 'other', 13: null, 14: 'e' };
      const kills = [];
      const groups = new Set([10]);
      const kill = (pid, signal) => {
        if (signal === 0) {
          if (!groups.has(-pid)) throw new Error('ESRCH');
          return;
        }
        kills.push([pid, signal]);
        if (signal === 'SIGTERM') { starts[Math.abs(pid)] = null; groups.delete(-pid); }
      };
      const warnings = [];
      const orphans = await reapOrphans(dir, {
        kill, isRunning: () => false, readStart: pid => starts[pid] ?? null, grace: 100,
        logger: { warn: (message, meta) => warnings.push(meta) }
      });

      expect(orphans.map(child => child.pid)).to.deep.equal([10, 11]);
      expect(kills).to.deep.equal([[-10, 'SIGTERM'], [11, 'SIGTERM']]);
      expect(warnings[0].processes).to.deep.equal([{ pid: 10, command: 'xwinwrap' }, { pid: 11, command: 'pactl' }]);
      expect(await fs.readdir(dir)).to.deep.equal(['keep.txt']);
    });

    it('sends SIGKILL to a group whose members outlive the grace period, even after the leader exits', async () => {
      await writeRecord([{ pid: 20, group: true, command: 'xwinwrap', start: 'a' }]);
      const kills = [];
      let leader = 'a';
      // xwinwrap exits on SIGTERM, mpv in its group does not
      const kill = (pid, signal) => {
        if (signal === 0) return;
        kills.push([pid, signal]);
        leader = null;
      };
      await reapOrphans(dir, { kill, isRunning: () => false, readStart: () => leader, grace: 60 });
      expect(kills).to.deep.equal([[-20, 'SIGTERM'], [-20, 'SIGKILL']]);
    });

    it('finds what a dead daemon left without signalling anything', async () => {
      await writeRecord([{ pid: 40, group: true, command: 'xwinwrap', start: 'a' }, { pid: 41, group: false, command: 'pactl', start: 'b' }]);
      const starts = { 40: 'a', 41: 'changed' };
      expect(findOrphans(dir, { isRunning: () => false, readStart: pid => starts[pid] })).to.deep.equal({
        daemon: 999999, orphans: [{ pid: 40, group: true, command: 'xwinwrap', start: 'a' }]
      });
      expect(await fs.pathExists(childrenPath(dir))).to.equal(true);
      expect(findOrphans(dir, { isRunning: () => true })).to.equal(null);
      await fs.remove(childrenPath(dir));
      expect(findOrphans(dir)).to.equal(null);
    });

    it('leaves a running daemon and a missing record alone', async () => {
      const kill = () => { throw new Error('must not signal'); };
      expect(await reapOrphans(dir, { kill })).to.deep.equal([]);
      await writeRecord([{ pid: 30, group: true, command: 'xwinwrap', start: 'a' }], process.pid);
      await fs.writeFile(path.join(dir, 'state.json'), '{}');
      expect(await reapOrphans(dir, { kill, readStart: () => 'a' })).to.deep.equal([]);
      expect(await fs.pathExists(path.join(dir, 'state.json'))).to.equal(true);
    });

    it('ends a real process group left by a dead daemon', async () => {
      const registry = new ChildRegistry({ runtimeDir: () => dir, pid: 2 ** 22 + 1 });
      const child = registry.track(spawn)('sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
      await new Promise(resolve => setTimeout(resolve, 50));
      const orphans = await reapOrphans(dir, { grace: 2000 });
      expect(orphans.map(item => item.pid)).to.deep.equal([child.pid]);
      await exited(child);
      expect(child.signalCode).to.equal('SIGTERM');
      // The group went with it, sleep included
      expect(() => process.kill(-child.pid, 0)).to.throw();
    });
  });
});
