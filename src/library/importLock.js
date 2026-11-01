import path from 'path';
import { FileLock } from '../utils/fileLock.js';

// How often a waiting import checks the lock again
const POLL_MS = 500;

// One import at a time across processes (the daemon's startup and watched imports, `backdrop import`).
// The lock file sits beside the media directory (see FileLock for how a stale one is taken over).
export function importLockPath(config) {
  return path.join(path.dirname(config.get().paths.media), 'import.lock');
}

export class ImportLock extends FileLock {
  constructor(file, options = {}) {
    super(file, { pollMs: POLL_MS, ...options });
  }
}
