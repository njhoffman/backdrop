import { bounces, entryPath, playsBounce, playUrl, smoothedFor } from '../bounce.js';
import { refreshEntries } from '../Playlist.js';
import { GATE_INTERVAL_MS, IdleGate } from '../IdleGate.js';
import fs from 'fs-extra';
import { renameIdCopies } from '../../library/copies.js';
import { listReverseWork, listReversed, recordEncode, reversedPath, reversedReady, removeStaleWork } from '../../library/reverse.js';

const GIGABYTE = 1024 ** 3;
// What Daemon.reverseAnywhere returns when the other machine went away and the job may not run here
export const UNAVAILABLE = Symbol('offload unavailable');
// How long before its end a playing video is switched to its bounce, so the switch lands where it would loop anyway
const SWITCH_LEAD_MS = 100;

// Reversed copies for bouncing videos (src/display/bounce.js), for a Daemon (passed in). An item is reversed
// the first time it plays and, ahead of time, when it is next in a playlist; one encode runs at a time, at the
// lowest CPU priority, and only while the load level is normal (a rise aborts it, to start again later) and, with
// display.bounce_idle_load, once the machine has been idle (IdleGate, read every GATE_INTERVAL_MS; a job running
// when it closes stops, keeping its finished chunks). When
// a copy is ready the item's playlist entries are swapped for its bounce URL; the playing one switches at the end of
// its pass, where it would loop anyway (planSwitch), when the video duration leaves room for a whole bounce, else at
// its next play. The copies are kept within display.bounce_cache_gb (prune).
export class Bounce {
  constructor(daemon, { loadavg, cpus } = {}) {
    this.daemon = daemon;
    this.gate = new IdleGate({
      kind: 'bounce',
      settings: () => this.settings.display,
      ...(loadavg ? { loadavg } : {}), ...(cpus ? { cpus } : {}),
      now: () => (this.daemon.now ?? Date.now)()
    });
    // Items waiting to be reversed, by id, oldest first
    this.queue = new Map();
    // Items whose entries may still need swapping (a copy made, or the item's bounce changed)
    this.pending = new Set();
    // Items that no encoder could reverse, not tried again until the daemon restarts
    this.failed = new Set();
    this.running = null;
    this.controller = null;
    // The item being reversed now, which must not be queued again meanwhile
    this.encoding = null;
    // Switches planned for the end of a pass, by screen: { mediaId, timer }
    this.switches = new Map();
    // When the item a switch replaced had loaded, by screen: { mediaId, loadedAt }, so its play time carries over
    this.carries = new Map();
  }

  get settings() {
    return this.daemon.config.get();
  }

  async begin() {
    if (!this.settings.paths.bounce) return;
    this.gate.check();
    this.daemon.every?.(GATE_INTERVAL_MS, () => this.tick().catch(error => this.daemon.logger.warn('Bounce gate check failed', { error: error.message })));
    await renameIdCopies(this.settings.paths.bounce, this.daemon.database, { logger: this.daemon.logger });
    await removeStaleWork(this.settings.paths.bounce);
    await this.prune();
  }

  // For state.json: how many items wait, the one being reversed, and the idle gate
  summary() {
    return { waiting: this.queue.size, encoding: this.encoding, gate: this.gate.summary(), host: this.offloading ? this.daemon.offload.host.name : null };
  }

  // Whether reversals go to another machine (offload.hosts, src/offload/RemoteEncoder.js): then this machine's load
  // and idle gate do not hold them, since the work is not done here
  get offloading() {
    return Boolean(this.daemon.offload?.available);
  }

  // A gate reading: an encode starts when it opens, and the one running stops (to resume later) when it closes
  async tick() {
    const was = this.gate.allowed;
    this.gate.check();
    const now = this.gate.allowed;
    if (was === now) return;
    const load = this.gate.load ? { one: Math.round(this.gate.load.one * 100) / 100, five: Math.round(this.gate.load.five * 100) / 100 } : null;
    if (now) {
      this.daemon.logger.info('Reversing allowed: the load stayed low', { perCpu: load });
      this.kick();
    } else {
      this.daemon.logger.info('Reversing paused: the load rose', { perCpu: load, encoding: this.encoding });
      if (!this.remote) this.controller?.abort();
    }
    if (this.daemon.writeState) await this.daemon.writeState().catch(() => {});
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
    if (this.switches.get(screen)?.mediaId !== media?.id) this.cancelSwitch(screen);
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
    if (!media?.path || this.failed.has(media.id) || this.queue.has(media.id) || this.encoding === media.id) return;
    if (!bounces(media, this.settings.display) || reversedReady(media, this.settings.paths.bounce)) return;
    // A smoothed copy gets its own reversed copy from the smoothing job (daemon/Smooth.js)
    if (smoothedFor(media, this.settings)) return;
    this.queue.set(media.id, media);
    this.kick();
  }

  // Whether an encode would start now, apart from smoothing: one queued, none running, and the load allows it (the
  // load level and the idle gate)
  canStart() {
    return !this.running && !this.daemon.stopping && this.queue.size > 0
      && (this.offloading || (this.daemon.load.level === 'normal' && this.gate.allowed));
  }

  // Starts the oldest queued encode when canStart and no smoothing job runs: background encodes share one slot, so the
  // two never add their load together (and close each other's idle gate). Returns whether one started.
  kick() {
    if (!this.canStart() || this.daemon.smoothing?.running) return false;
    const [id, media] = this.queue.entries().next().value;
    this.queue.delete(id);
    const controller = new AbortController();
    this.controller = controller;
    this.encoding = id;
    this.remote = this.offloading;
    this.running = (async () => {
      const started = this.daemon.now();
      const target = await this.daemon.reverseAnywhere(media, reversedPath(media, this.settings.paths.bounce), { signal: controller.signal, local: !this.remote });
      if (target === UNAVAILABLE) {
        // The other machine went away: queued again at the front, for this machine's gates to start
        this.queue = new Map([[id, media], ...this.queue]);
        return;
      }
      if (controller.signal.aborted) {
        // Paused for the load (its level or the idle gate) or stopped: queued again at the front for when it falls
        if (!this.daemon.stopping) this.queue = new Map([[id, media], ...this.queue]);
        return;
      }
      if (!target) {
        // A rating moves the file (inbox to library, or to the trash) under a running encode: try again from where it is
        const now = this.daemon.database.getMedia(id);
        if (now?.path && now.path !== media.path) {
          this.daemon.logger.info('Reversing again: the file moved while it was being reversed', { mediaId: id });
          // Queued directly: want() turns away the item still counted as encoding; the finally below starts it
          if (bounces(now, this.settings.display)) this.queue = new Map([[id, now], ...this.queue]);
          return;
        }
        this.failed.add(id);
        return;
      }
      try {
        recordEncode(this.daemon.database, new Date(this.daemon.now()), (this.daemon.now() - started) / 1000);
      } catch (error) {
        this.daemon.logger.warn('Failed to count the encode', { error: error.message });
      }
      this.pending.add(id);
      await this.daemon.enqueue(async () => {
        await this.swap(this.pending);
        // The new copy is for an item about to play
        await this.prune(new Set([id]));
      });
    })().catch(error => this.daemon.logger.warn('Bounce failed', { mediaId: id, error: error.message }))
      .finally(() => {
        this.running = null;
        this.controller = null;
        this.encoding = null;
        this.remote = false;
        // The slot passes to smoothing when nothing more is reversed now
        if (!this.kick()) this.daemon.smoothing?.kick?.();
      });
    return true;
  }

  // The load left normal: the running encode stops and waits; one on another machine goes on
  pause() {
    if (!this.remote) this.controller?.abort();
  }

  async stop() {
    for (const screen of [...this.switches.keys()]) this.cancelSwitch(screen);
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
    await this.prune();
    this.want(media);
  }

  // `backdrop copies --sync`: unwanted copies go, and the items still bouncing are reversed again, not waiting for their
  // next play. A copy of a replaced file is of content no item has, so its item is reversed on its next play instead.
  async resync() {
    const removed = await this.prune();
    for (const id of removed) this.want(this.daemon.database.getMedia(id));
    return removed;
  }

  // display.video_loop changed: every entry is checked, and what plays now is queued
  async reconfigure() {
    await this.prune();
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
        const result = await refreshEntries(screen.client, { database: this.daemon.database, config: this.settings, mediaIds: checked ?? undefined, monitor: screen.monitor });
        result.held.forEach(id => held.add(id));
        for (const id of result.held) await this.planSwitch(screen, id);
      } catch (error) {
        this.daemon.logger.warn('Failed to swap bounce entries', { monitor: screen.monitor.name, error: error.message });
      }
    }
    // Ids added while this ran stay pending
    for (const id of checked ?? []) if (!held.has(id)) this.pending.delete(id);
    held.forEach(id => this.pending.add(id));
  }

  // Plans the playing item's switch to what it should load now (its bounce, or back to the file) for the end of its
  // pass, where mpv would loop anyway: the bounce entry goes in after it and plays, and the old one goes. Only when
  // the video duration leaves room for a whole pass of the new one; otherwise the swap waits for its next play.
  async planSwitch(screen, mediaId) {
    if (this.switches.get(screen)?.mediaId === mediaId) return;
    this.cancelSwitch(screen);
    const media = this.daemon.database.getMedia(mediaId);
    if (!media?.duration || screen.media?.id !== mediaId || !screen.client) return;
    let position;
    try {
      position = await screen.client.getProperty('time-pos');
    } catch {
      return;
    }
    if (!Number.isFinite(position)) return;
    const speed = media.speed || 1;
    const untilEnd = Math.max(0, ((screen.bouncing ? 2 : 1) * media.duration - position) / speed);
    const nextLength = (playsBounce(playUrl(media, this.settings, [screen.monitor])) ? 2 : 1) * media.duration / speed;
    const timeout = this.daemon.videoDuration?.() ?? 0;
    const played = (this.daemon.now() - (screen.loadedAt ?? this.daemon.now())) / 1000 + untilEnd;
    if (timeout && timeout - played < nextLength) return;
    const timer = setTimeout(() => {
      this.daemon.enqueue(() => this.switchNow(screen, mediaId));
    }, Math.max(0, untilEnd * 1000 - SWITCH_LEAD_MS));
    this.switches.set(screen, { mediaId, timer });
  }

  cancelSwitch(screen) {
    clearTimeout(this.switches.get(screen)?.timer);
    this.switches.delete(screen);
  }

  // The planned switch: checked again (another item may play, or a speed change moved the end), then made
  async switchNow(screen, mediaId) {
    this.switches.delete(screen);
    if (this.daemon.stopping || this.daemon.screens.get(screen.monitor.name) !== screen || screen.media?.id !== mediaId) return;
    const media = this.daemon.database.getMedia(mediaId);
    const url = media && playUrl(media, this.settings, [screen.monitor]);
    try {
      const position = await screen.client.getProperty('time-pos');
      const untilEnd = ((screen.bouncing ? 2 : 1) * media.duration - position) / (media.speed || 1);
      // Still well before the end (slowed down since): planned again
      if (untilEnd * 1000 > SWITCH_LEAD_MS * 3) {
        await this.planSwitch(screen, mediaId);
        return;
      }
      const playlist = await screen.client.getProperty('playlist');
      const index = playlist.findIndex(entry => entry.current);
      if (index === -1 || entryPath(playlist[index].filename) !== media.path || playlist[index].filename === url) return;
      this.carries.set(screen, { mediaId, loadedAt: screen.loadedAt });
      await screen.client.command('loadfile', url, 'insert-next');
      await screen.client.command('playlist-next', 'force');
      await screen.client.command('playlist-remove', index);
      this.daemon.logger.info('Switched to the bounce at the end of a pass', { monitor: screen.monitor.name, mediaId });
    } catch (error) {
      this.carries.delete(screen);
      this.daemon.logger.warn('Failed to switch to the bounce', { monitor: screen.monitor.name, mediaId, error: error.message });
    }
  }

  // For a load a switch made: when the item it replaced had loaded, so the video duration counts from then; else null
  carried(screen, media) {
    const carry = this.carries.get(screen);
    this.carries.delete(screen);
    return carry && media && carry.mediaId === media.id ? carry.loadedAt : null;
  }

  // Deletes the copies no longer wanted: of items gone, skipped or no longer bouncing; then, while the rest do not fit
  // in display.bounce_cache_gb (0 for no limit), those of the lowest-rated items, the newest copy first. Every video
  // plays once per pass of the shuffled playlist, so deleting the least recently played would remove each copy just
  // before its next play; keeping the oldest copies instead keeps a set that is used again every pass. Copies of what
  // plays now and of protect (a copy just made for the next item) stay. The entries of deleted copies go back to the
  // plain file, which mpv would otherwise fail to load and drop. Returns the ids whose copy was deleted.
  async prune(protect = new Set()) {
    const { paths, display } = this.settings;
    if (!paths.bounce) return [];
    const playing = new Set([...this.daemon.screens.values()].map(screen => screen.media?.id).filter(Boolean));
    for (const id of protect) playing.add(id);
    // Copies are named for their item's sha256: one whose file was replaced (download --upgrade) has no item any more
    const all = (await listReversed(paths.bounce)).map(copy => {
      const media = this.daemon.database.getMediaBySha256(copy.sha256);
      return { ...copy, media, id: media?.id ?? null };
    });
    const copies = all.filter(copy => copy.id === null || !playing.has(copy.id));
    const unwanted = copies.filter(({ media }) => !media?.path || media.status === 'skipped' || !bounces(media, display)
      || !reversedReady(media, paths.bounce));
    const rating = id => this.daemon.database.getLatestRating(id)?.rating ?? 0;
    const kept = copies.filter(copy => !unwanted.includes(copy))
      .map(copy => ({ ...copy, rating: rating(copy.id) }))
      .sort((a, b) => a.rating - b.rating || b.mtimeMs - a.mtimeMs);
    const limit = (display.bounce_cache_gb ?? 0) * GIGABYTE;
    // Copies playing now count toward the limit but are never deleted
    let total = all.filter(copy => !unwanted.includes(copy)).reduce((sum, copy) => sum + copy.size, 0);
    const evicted = [];
    for (const copy of kept) {
      if (!limit || total <= limit) break;
      evicted.push(copy);
      total -= copy.size;
    }
    // A stopped job's chunks stay only while its item still bounces (the job running now keeps its own)
    for (const work of await listReverseWork(paths.bounce)) {
      const media = this.daemon.database.getMediaBySha256(work.key);
      if (media && media.id === this.encoding) continue;
      if (media?.path && media.status !== 'skipped' && bounces(media, display)) continue;
      await fs.remove(work.file).catch(error => this.daemon.logger.warn('Failed to delete reverse work', { file: work.file, error: error.message }));
    }
    const removed = [];
    for (const copy of [...unwanted, ...evicted]) {
      try {
        await fs.remove(copy.file);
        removed.push(copy.id);
      } catch (error) {
        this.daemon.logger.warn('Failed to delete a reversed copy', { mediaId: copy.id, file: copy.file, error: error.message });
      }
    }
    if (!removed.length) return removed;
    this.daemon.logger.info('Pruned reversed copies', { unwanted: unwanted.length, overLimit: evicted.length, bytesKept: total });
    // A copy of a replaced file (no item has its sha256 now) may still be what an entry plays: every entry is checked
    await this.swap(removed.includes(null) ? null : removed);
    return removed.filter(id => id !== null);
  }
}
