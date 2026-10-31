import fs from 'fs';
import path from 'path';
import { processStart } from '../display/children.js';

// How often a waiting import checks the lock again
const POLL_MS = 500;
// A lock file with no readable holder (being written, or cut short) is ignored after this long
const UNREADABLE_GRACE_MS = 10_000;

// One import at a time across processes (the daemon's startup and watched imports, `backdrop import`).
// The lock file sits beside the media directory and names its holder by pid and /proc start time,
// so a lock left by a crashed or killed import is taken over instead of blocking forever.
export function importLockPath(config) {
  return path.join(path.dirname(config.get().paths.media), 'import.lock');
}

export class ImportLock {
  constructor(file, { pid = process.pid, readStart = processStart, pollMs = POLL_MS, now = Date.now } = {}) {
    this.file = file;
    this.pid = pid;
    this.readStart = readStart;
    this.pollMs = pollMs;
    this.now = now;
    this.held = null;
  }

  // The import holding the lock as { pid }, or null when it is free or its holder is gone
  holder() {
    let text;
    let stat;
    try {
      text = fs.readFileSync(this.file, 'utf8');
      stat = fs.statSync(this.file);
    } catch {
      return null;
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      return this.now() - stat.mtimeMs < UNREADABLE_GRACE_MS ? { pid: null } : null;
    }
    const alive = Number.isInteger(record?.pid) && record.start != null && this.readStart(record.pid) === record.start;
    return alive ? { pid: record.pid } : null;
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
      if (this.holder()) return false;
      // Stale: remove it and try once more; another process may still win the race for it
      fs.rmSync(this.file, { force: true });
    }
    return false;
  }

  // Waits until the lock is free. onWait(holder) runs once, the first time it has to wait.
  // shouldStop() ends the wait early, returning false.
  async acquire({ onWait = () => {}, shouldStop = () => false } = {}) {
    let waited = false;
    while (!this.tryAcquire()) {
      if (shouldStop()) return false;
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
}
