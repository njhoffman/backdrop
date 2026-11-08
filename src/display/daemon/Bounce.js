import { bounces, entryPath } from '../bounce.js';
import { refreshEntries } from '../Playlist.js';
import { reversedReady, removeStaleWork } from '../../library/reverse.js';

// Reversed copies for bouncing videos (src/display/bounce.js), for a Daemon (passed in). An item is reversed
// the first time it plays and, ahead of time, when it is next in a playlist; one encode runs at a time, at the
// lowest CPU priority, and only while the load level is normal (a rise aborts it, to start again later). When
// a copy is ready the item's playlist entries are swapped for its bounce URL; the playing one waits for its
// next play, since reloading it would restart it.
export class Bounce {
  constructor(daemon) {
    this.daemon = daemon;
    // Items waiting to be reversed, by id, oldest first
    this.queue = new Map();
    // Items whose entries may still need swapping (a copy made, or the item's bounce changed)
    this.pending = new Set();
    // Items that no encoder could reverse, not tried again until the daemon restarts
    this.failed = new Set();
    this.running = null;
    this.controller = null;
  }

  get settings() {
    return this.daemon.config.get();
  }

  async begin() {
    if (this.settings.paths.bounce) await removeStaleWork(this.settings.paths.bounce);
  }

  // Whether anything can bounce, so loads skip the look-ahead otherwise
  active() {
    try {
      return this.settings.display.video_loop === 'bounce' || this.daemon.database.hasBounceOverrides();
    } catch {
      return false;
    }
  }

  // On every load: entries still waiting are swapped, and the item and the next entry are queued
  async onLoaded(screen, media) {
    if (this.pending.size) await this.swap(this.pending);
    if (!media || !this.active()) return;
    this.want(media);
    try {
      const playlist = await screen.client.getProperty('playlist');
      const next = playlist[playlist.findIndex(entry => entry.current) + 1];
      this.want(next && this.daemon.database.getMediaByPath(entryPath(next.filename)));
    } catch (error) {
      this.daemon.logger.warn('Bounce look-ahead failed', { monitor: screen.monitor.name, error: error.message });
    }
  }

  // Queues an item that bounces and has no current reversed copy
  want(media) {
    if (!media?.path || this.failed.has(media.id) || this.queue.has(media.id)) return;
    if (!bounces(media, this.settings.display) || reversedReady(media, this.settings.paths.bounce)) return;
    this.queue.set(media.id, media);
    this.kick();
  }

  // Starts the oldest queued encode when none runs and the load allows it
  kick() {
    if (this.running || this.daemon.stopping || !this.queue.size || this.daemon.load.level !== 'normal') return;
    const [id, media] = this.queue.entries().next().value;
    this.queue.delete(id);
    const controller = new AbortController();
    this.controller = controller;
    this.running = (async () => {
      const target = await this.daemon.reverse(media, { signal: controller.signal });
      if (controller.signal.aborted) {
        // Paused for the load or stopped: queued again at the front for when the load falls
        if (!this.daemon.stopping) this.queue = new Map([[id, media], ...this.queue]);
        return;
      }
      if (!target) {
        this.failed.add(id);
        return;
      }
      this.pending.add(id);
      await this.daemon.enqueue(() => this.swap(this.pending));
    })().catch(error => this.daemon.logger.warn('Bounce failed', { mediaId: id, error: error.message }))
      .finally(() => {
        this.running = null;
        this.controller = null;
        this.kick();
      });
  }

  // The load left normal: the running encode stops and waits
  pause() {
    this.controller?.abort();
  }

  async stop() {
    this.queue.clear();
    this.controller?.abort();
    await this.running;
  }

  // An item's bounce changed (`backdrop bounce`): its entries are swapped and it is queued if it now bounces
  async changed(mediaId) {
    const media = this.daemon.database.getMedia(mediaId);
    if (!media) return;
    this.failed.delete(mediaId);
    this.pending.add(mediaId);
    await this.swap(this.pending);
    this.want(media);
  }

  // display.video_loop changed: every entry is checked, and what plays now is queued
  async reconfigure() {
    await this.swap(null);
    for (const screen of this.daemon.screens.values()) this.want(screen.media);
  }

  // Swaps the entries of ids (every entry for null) on every monitor; ids still playing stay pending
  async swap(ids) {
    const checked = ids ? new Set(ids) : null;
    const held = new Set();
    for (const screen of [...this.daemon.screens.values()]) {
      if (!screen.client) continue;
      try {
        const result = await refreshEntries(screen.client, { database: this.daemon.database, config: this.settings, mediaIds: checked ?? undefined });
        result.held.forEach(id => held.add(id));
      } catch (error) {
        this.daemon.logger.warn('Failed to swap bounce entries', { monitor: screen.monitor.name, error: error.message });
      }
    }
    // Ids added while this ran stay pending
    for (const id of checked ?? []) if (!held.has(id)) this.pending.delete(id);
    held.forEach(id => this.pending.add(id));
  }
}
