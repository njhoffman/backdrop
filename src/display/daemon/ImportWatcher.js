import fs from 'fs';
import path from 'path';

// Quiet time after the last change in a watched folder before importing, and the age a file's last change
// must reach to be imported, so files still being copied in are left for the next pass
export const IMPORT_SETTLE_MS = 2000;
// How long to wait before trying again when `backdrop import` holds the import lock
export const IMPORT_RETRY_MS = 10_000;

function isInside(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// library.watch_imports: watches library.import_dirs (inotify, recursive) while the daemon runs and imports
// what appears, for a Daemon (passed in). A change runs the daemon's usual import over every folder:
// unchanged files cost a stat each, and folders moved in, renames and deletions need no handling of their own.
// inotify sees changes made on this machine only, so files a network share gains from elsewhere wait for
// the next start or `backdrop import`.
export class ImportWatcher {
  constructor(daemon, { settle = IMPORT_SETTLE_MS, retry = IMPORT_RETRY_MS } = {}) {
    this.daemon = daemon;
    this.settle = settle;
    this.retry = retry;
    this.watchers = [];
    this.timer = null;
  }

  get watching() {
    return this.watchers.map(entry => entry.dir);
  }

  // Watches the configured folders, replacing any earlier watches; nothing when watching is off
  start() {
    this.stop();
    const { library } = this.daemon.config.get();
    if (!this.daemon.watch || !library.watch_imports) return;
    for (const dir of library.import_dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = this.daemon.watch(dir, { recursive: true }, (event, name) => this.changed(dir, name));
        watcher.on('error', error => {
          this.daemon.logger.warn('Import folder watch failed', { dir, error: error.message });
          this.unwatch(watcher);
        });
        this.watchers.push({ dir, watcher });
      } catch (error) {
        this.daemon.logger.warn('Not watching import folder', { dir, error: error.message });
      }
    }
    if (this.watchers.length) this.daemon.logger.info('Watching import folders', { dirs: this.watching });
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const { watcher } of this.watchers) watcher.close();
    this.watchers = [];
  }

  unwatch(watcher) {
    watcher.close();
    this.watchers = this.watchers.filter(entry => entry.watcher !== watcher);
  }

  // The library's own folders may sit inside an import folder; copies into them are not news
  changed(dir, name) {
    if (this.daemon.stopping) return;
    if (name) {
      const file = path.join(dir, name);
      const { media, trash } = this.daemon.config.get().paths;
      const hidden = String(name).split(path.sep).some(part => part.startsWith('.'));
      if (hidden || isInside(file, media) || isInside(file, trash)) return;
    }
    this.schedule(this.settle);
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.daemon.importing = this.daemon.importing.then(() => this.run());
    }, delay);
  }

  async run() {
    if (this.daemon.stopping) return;
    const summary = await this.daemon.importDirs(this.daemon.firstMonitor(), { settle: this.settle });
    if (!summary || this.daemon.stopping) return;
    // Files still being written get another pass; so does a pass `backdrop import` held off
    if (summary.locked) this.schedule(this.retry);
    else if (summary.recent) this.schedule(this.settle);
  }
}
