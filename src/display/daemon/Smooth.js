import fs from 'fs-extra';
import { bounces, entryPath, isSmoothedUrl } from '../bounce.js';
import { MODE_KINDS } from '../Playlist.js';
import {
  SMOOTH_FPS, listSmoothWork, listSmoothed, removeStaleSmoothWork, smoothSize, smoothWorkPath, smoothedPath, smoothedReady, smoothedReversedPath,
  smoothedReversedReady, smoothFactor, wantsSmoothing
} from '../../library/smooth.js';

// Smoothed copies of slowed videos (display.smooth, src/library/smooth.js) for a Daemon (passed in), and mpv's frame
// blending meanwhile. One copy is made at a time, only while the load level is normal (a rise aborts it, to start
// again later): the items playing and next first, then every other slowed video, the highest rated first. A bouncing
// item's copy gets its own reversed copy after it. When an item's copies are ready its playlist entries are swapped
// (the bounce queue's swap, which also switches a playing entry at the end of its pass). Copies of items no longer
// slowed, at another speed, gone or skipped are deleted.
export class Smooth {
  constructor(daemon) {
    this.daemon = daemon;
    // Items waiting, by id, in order
    this.queue = new Map();
    this.failed = new Set();
    this.running = null;
    this.controller = null;
    this.encoding = null;
  }

  get settings() {
    return this.daemon.config.get();
  }

  get enabled() {
    return Boolean(this.settings.display.smooth && this.settings.paths.smooth);
  }

  get target() {
    return this.settings.display.smooth_fps ?? SMOOTH_FPS;
  }

  async begin() {
    if (!this.settings.paths.smooth) return;
    await removeStaleSmoothWork(this.settings.paths.smooth);
    await this.prune();
    this.backlog();
  }

  // Every slowed video without its copy, after whatever waits already: those a stopped job left chunks for first, so
  // they carry on, then the highest rated
  backlog() {
    if (!this.enabled) return;
    const { database } = this.daemon;
    const dir = this.settings.paths.smooth;
    const slowed = database.findMedia({ kind: MODE_KINDS.video, status: ['new', 'kept'], downloaded: true, order: 'rating' })
      .filter(media => media.speed < 1);
    const started = slowed.filter(media => fs.existsSync(smoothWorkPath(media, dir)));
    const items = [...started, ...slowed.filter(media => !started.includes(media))];
    for (const media of items) this.want(media, { start: false });
    this.kick();
  }

  // Whether an item needs work: its smoothed copy, or the reversed copy of it when it bounces
  needs(media) {
    if (!this.enabled || !wantsSmoothing(media, this.target)) return false;
    const dir = this.settings.paths.smooth;
    if (!smoothedReady(media, dir)) return true;
    return bounces(media, this.settings.display) && !smoothedReversedReady(media, dir);
  }

  // first: ahead of the backlog (an item playing or next)
  want(media, { first = false, start = true } = {}) {
    if (!media || this.failed.has(media.id) || this.encoding === media.id || !this.needs(media)) return;
    if (first) this.queue = new Map([[media.id, media], ...[...this.queue].filter(([id]) => id !== media.id)]);
    else if (!this.queue.has(media.id)) this.queue.set(media.id, media);
    if (start) this.kick();
  }

  // On every load: mpv blends frames for a slowed video without its copy, and the item and the next entry go first
  async onLoaded(screen, media, filename) {
    await this.applyBlend(screen, media, filename);
    if (!media || !this.enabled) return;
    this.want(media, { first: true });
    try {
      const playlist = await screen.client.getProperty('playlist');
      const next = playlist[playlist.findIndex(entry => entry.current) + 1];
      this.want(next && this.daemon.database.getMediaByPath(entryPath(next.filename)), { first: true });
    } catch (error) {
      this.daemon.logger.warn('Smoothing look-ahead failed', { monitor: screen.monitor.name, error: error.message });
    }
  }

  // display.smooth_blend: mpv's interpolation, timed to the display, while a slowed video plays without a smoothed
  // copy; back to its defaults for anything else, since blending needs a steady display clock to help
  async applyBlend(screen, media, filename) {
    const slowed = Boolean(media && MODE_KINDS.video.includes(media.kind) && media.speed < 1);
    const blend = Boolean(this.settings.display.smooth_blend && slowed && !isSmoothedUrl(filename));
    if (blend === Boolean(screen.blending)) return;
    try {
      await screen.client.setProperty('video-sync', blend ? 'display-resample' : 'audio');
      await screen.client.setProperty('interpolation', blend);
      screen.blending = blend;
    } catch (error) {
      this.daemon.logger.warn('Failed to change frame blending', { monitor: screen.monitor.name, error: error.message });
    }
  }

  // Starts the next job. None while no monitor is known (at start, or all unplugged): its size would fall back to the
  // video's own, up to four times the pixels a 1080p screen shows; the next load starts it again.
  kick() {
    if (this.running || this.daemon.stopping || !this.queue.size || this.daemon.load.level !== 'normal' || !this.enabled) return;
    if (!this.daemon.monitors.size) return;
    const [id, queued] = this.queue.entries().next().value;
    this.queue.delete(id);
    // The item as it is now: its speed may have changed while it waited
    const media = this.daemon.database.getMedia(id) ?? queued;
    if (!this.needs(media)) {
      this.kick();
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.encoding = id;
    this.running = this.make(media, controller.signal)
      .catch(error => this.daemon.logger.warn('Smoothing failed', { mediaId: id, error: error.message }))
      .finally(() => {
        this.running = null;
        this.controller = null;
        this.encoding = null;
        this.kick();
      });
  }

  async make(media, signal) {
    const { paths, display } = this.settings;
    const dir = paths.smooth;
    const size = smoothSize(media, [...this.daemon.monitors.values()]);
    if (!smoothedReady(media, dir)) {
      const made = await this.daemon.smoothVideo(media, { dir, size, target: this.target, rife: display.smooth_rife, signal });
      if (signal.aborted) return this.requeue(media);
      if (!made) {
        // A rating moves the file under a running job: try again from where it is
        const now = this.daemon.database.getMedia(media.id);
        if (now?.path && now.path !== media.path) {
          this.daemon.logger.info('Smoothing again: the file moved while it was being smoothed', { mediaId: media.id });
          return this.requeue(now);
        }
        this.failed.add(media.id);
        return;
      }
    }
    if (bounces(media, display) && !smoothedReversedReady(media, dir)) {
      const fps = media.fps * smoothFactor(media.fps, media.speed, this.target);
      const copy = { id: `${media.id}@${media.speed}.reversed`, kind: media.kind, path: smoothedPath(media, dir), duration: media.duration, fps, ...size };
      const reversed = await this.daemon.reverse(copy, { signal, dir });
      if (signal.aborted) return this.requeue(media);
      if (!reversed || reversed !== smoothedReversedPath(media, dir)) this.daemon.logger.warn('No reversed smoothed copy', { mediaId: media.id });
    }
    await this.daemon.enqueue(async () => {
      this.daemon.bounce.pending.add(media.id);
      await this.daemon.bounce.swap(this.daemon.bounce.pending);
    });
  }

  requeue(media) {
    if (!this.daemon.stopping) this.queue = new Map([[media.id, media], ...this.queue]);
  }

  pause() {
    this.controller?.abort();
  }

  async stop() {
    this.queue.clear();
    this.controller?.abort();
    await this.running;
  }

  // An item's speed or bounce changed: stale copies go, its entries are swapped and it is queued first if it needs work
  async changed(mediaId) {
    const media = this.daemon.database.getMedia(mediaId);
    if (!media) return;
    this.failed.delete(mediaId);
    await this.prune();
    this.want(media, { first: true });
  }

  // display.smooth* changed: copies are pruned, every entry checked, and the backlog queued again
  async reconfigure() {
    if (!this.enabled) {
      this.queue.clear();
      this.controller?.abort();
    }
    await this.prune();
    await this.daemon.bounce.swap(null);
    for (const screen of this.daemon.screens.values()) await this.applyBlend(screen, screen.media, screen.filename);
    this.backlog();
  }

  // Deletes copies no longer wanted: smoothing off, the item gone, skipped, at another speed or no longer slowed, and a
  // reversed copy of an item that no longer bounces, and the kept work of jobs for them. Copies of what plays now stay. Their entries go back to what the
  // item loads now. Returns the ids whose copies were deleted.
  async prune() {
    const { paths, display } = this.settings;
    if (!paths.smooth) return [];
    const playing = new Set([...this.daemon.screens.values()].map(screen => screen.media?.id).filter(Boolean));
    const removed = new Set();
    for (const copy of await listSmoothed(paths.smooth)) {
      if (playing.has(copy.id)) continue;
      const media = this.daemon.database.getMedia(copy.id);
      const wanted = display.smooth && media?.path && media.status !== 'skipped' && media.speed === copy.speed
        && wantsSmoothing(media, this.target) && (!copy.reversed || bounces(media, display));
      if (wanted) continue;
      await fs.remove(copy.file).catch(error => this.daemon.logger.warn('Failed to delete a smoothed copy', { file: copy.file, error: error.message }));
      removed.add(copy.id);
    }
    // A stopped job's chunks stay only while its item still wants that copy (the job running now keeps its own)
    for (const work of await listSmoothWork(paths.smooth)) {
      if (work.id === this.encoding) continue;
      const media = this.daemon.database.getMedia(work.id);
      const wanted = display.smooth && media?.path && media.status !== 'skipped' && media.speed === work.speed && wantsSmoothing(media, this.target);
      if (!wanted) await fs.remove(work.file).catch(error => this.daemon.logger.warn('Failed to delete smoothing work', { file: work.file, error: error.message }));
    }
    if (removed.size) {
      this.daemon.logger.info('Pruned smoothed copies', { items: removed.size });
      await this.daemon.bounce.swap(removed);
    }
    return [...removed];
  }
}

