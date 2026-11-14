import fs from 'fs';
import path from 'path';
import { processStart } from '../display/children.js';

// A lock file with no readable holder (being written, or cut short) is ignored after this long
const UNREADABLE_GRACE_MS = 10_000;

// A lock across processes: a file created with O_EXCL that names its holder by pid and /proc start time,
// so a lock left by a crashed or killed process is taken over instead of blocking forever.
export class FileLock {
  constructor(file, { pid = process.pid, readStart = processStart, pollMs = 50, now = Date.now } = {}) {
    this.file = file;
    this.pid = pid;
    this.readStart = readStart;
    this.pollMs = pollMs;
    this.now = now;
    this.held = null;
  }

  // The process holding the lock as { pid }, or null when it is free or its holder is gone
  holder() {
    return this.inspect().holder;
  }

  // The lock file's text and inode (null when there is none) and its live holder as { pid } (null when free or stale)
  inspect() {
    let text;
    let stat;
    try {
      text = fs.readFileSync(this.file, 'utf8');
      stat = fs.statSync(this.file);
    } catch {
      return { text: null, ino: null, holder: null };
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      return { text, ino: stat.ino, holder: this.now() - stat.mtimeMs < UNREADABLE_GRACE_MS ? { pid: null } : null };
    }
    const alive = Number.isInteger(record?.pid) && record.start != null && this.readStart(record.pid) === record.start;
    return { text, ino: stat.ino, holder: alive ? { pid: record.pid } : null };
  }

  // Takes the lock if it is free or stale; true when this process now holds it
  tryAcquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = JSON.stringify({ pid: this.pid, start: this.readStart(this.pid) });
        fs.writeFileSync(this.file, content, { flag: 'wx' });
        this.held = content;
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const found = this.inspect();
      if (found.holder) return false;
      if (found.text !== null && !this.setAside(found)) return false;
    }
    return false;
  }

  // Moves a stale lock out of the way; false when what it moved was not that lock. Two waiters may both find the
  // same stale lock: removing it outright, the slower one could remove the lock the faster one has just written,
  // and both would hold it. Only one rename of the file succeeds, so each waiter renames it to a name of its own
  // and checks it moved the stale file (the same inode and text: an empty stale lock and a new one not yet written
  // read alike, and a removed file's inode can be reused). A fresh lock moved by mistake is linked back; link fails
  // rather than overwrite a lock a third waiter took meanwhile.
  setAside(stale) {
    const aside = `${this.file}.stale-${this.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      fs.renameSync(this.file, aside);
    } catch (error) {
      // Gone already: another waiter moved it, and the next create decides
      if (error.code === 'ENOENT') return true;
      throw error;
    }
    let same = false;
    try {
      same = fs.statSync(aside).ino === stale.ino && fs.readFileSync(aside, 'utf8') === stale.text;
    } catch {
      // Unreadable: treated as not the stale one
    }
    if (!same) {
      try {
        fs.linkSync(aside, this.file);
      } catch {
        // A third waiter holds it now
      }
    }
    fs.rmSync(aside, { force: true });
    return same;
  }

  // Waits until the lock is free. onWait(holder) runs once, the first time it has to wait.
  // shouldStop() ends the wait early, returning false; so does a timeout (ms) running out.
  async acquire({ onWait = () => {}, shouldStop = () => false, timeout = Infinity } = {}) {
    let waited = false;
    const deadline = this.now() + timeout;
    while (!this.tryAcquire()) {
      if (shouldStop() || this.now() > deadline) return false;
      if (!waited) {
        waited = true;
        onWait(this.holder() ?? { pid: null });
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
    return true;
  }

  // Removes the lock file, only if it is still the one this process wrote
  release() {
    if (!this.held) return;
    try {
      if (fs.readFileSync(this.file, 'utf8') === this.held) fs.rmSync(this.file, { force: true });
    } catch {
      // Already gone
    }
    this.held = null;
  }

  // Runs fn holding the lock, waiting up to timeout ms for it; throws busy() when it stays taken
  async around(fn, { timeout, busy = () => new Error(`${this.file} is held by another process`) } = {}) {
    if (!await this.acquire({ timeout })) throw busy();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
