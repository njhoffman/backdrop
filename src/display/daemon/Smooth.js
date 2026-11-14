import fs from 'fs-extra';
import { bounces, entryPath, isSmoothedUrl, neededSize } from '../bounce.js';
import { probeMedia } from '../../library/probe.js';
import { MODE_KINDS } from '../Playlist.js';
import { gpuTrouble, processName } from '../kernelLog.js';
import { notifyError } from '../../utils/notify.js';

const GIGABYTE = 1024 ** 3;
import {
  RifeTimeoutError, SMOOTH_BELOW, SMOOTH_FPS, SMOOTH_GPU, listSmoothWork, listSmoothed, removeStaleSmoothWork, smoothSize, smoothWorkPath, smoothedPath, smoothedReady, smoothedReversedPath,
  smoothedReversedReady, smoothedSize, smoothedSizePath, smoothFactor, staleCopy, stutters, wantsSmoothing
} from '../../library/smooth.js';

// Smoothed copies of slowed videos (display.smooth, src/library/smooth.js) for a Daemon (passed in), and mpv's frame
// blending meanwhile. One copy is made at a time, only while the load level is normal (a rise aborts it, to start
// again later): the items playing and next first, then every other slowed video, the highest rated first. A bouncing
// item's copy gets its own reversed copy after it. When an item's copies are ready its playlist entries are swapped
// (the bounce queue's swap, which also switches a playing entry at the end of its pass). Copies of items no longer
// slowed, at another speed, gone or skipped are deleted, and the rest kept within display.smooth_cache_gb (prune).
// Copies for the items playing and next are always made; the backlog only while the cache has room for another.
// Turning smoothing off stops new copies and plays the originals, but keeps the copies made (within the cache limit).
//
// RIFE runs on the CPU unless display.smooth_gpu names a device. On a GPU each job follows the kernel log, and the
// first fence timeout or GPU hang naming RIFE, or a chunk past its time limit, stops the job and moves smoothing to
// the CPU for the daemon's life (the job resumes there from its finished chunks); a kernel log this user cannot read
// keeps it on the CPU from the start. Either shows in state.json (summary), status and doctor.
export class Smooth {
  constructor(daemon) {
    this.daemon = daemon;
    // Items waiting, by id, in order
    this.queue = new Map();
    // Queued items that play now or next, made even when the cache is full
    this.urgent = new Set();
    // What the copies take, from the last prune: { bytes, items }
    this.usage = { bytes: 0, items: 0 };
    this.failed = new Set();
    this.running = null;
    this.controller = null;
    this.encoding = null;
    // Why smoothing runs on the CPU though display.smooth_gpu names a device: { reason, at }, for the daemon's life
    this.fallback = null;
    this.logReadable = null;
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

  get below() {
    return this.settings.display.smooth_below ?? SMOOTH_BELOW;
  }

  // The device display.smooth_gpu asks for, -1 for the CPU
  get gpu() {
    const gpu = this.settings.display.smooth_gpu ?? SMOOTH_GPU;
    return Number.isInteger(gpu) && gpu >= 0 ? gpu : -1;
  }

  // For state.json: the device asked for, the one in use, and why they differ
  summary() {
    return { enabled: this.enabled, gpu: this.gpu, device: this.fallback ? -1 : this.gpu, fallback: this.fallback, encoding: this.encoding };
  }

  // The device the next job runs on: the CPU after a fallback, or when the kernel log cannot be watched
  async device() {
    if (this.gpu < 0 || this.fallback) return -1;
    this.logReadable ??= await Promise.resolve(this.daemon.kernelLog?.readable()).catch(() => false);
    if (!this.logReadable) {
      await this.fallBack('the kernel log cannot be read (journalctl -k), so a GPU hang could not be caught; add yourself to the adm group', { notify: false, stop: false });
      return -1;
    }
    return this.gpu;
  }

  // Moves smoothing to the CPU for the daemon's life, stopping the job running (it is queued again, to resume there)
  async fallBack(reason, { notify = true, stop = true } = {}) {
    if (this.fallback) return;
    this.fallback = { reason, at: this.daemon.now?.() ?? Date.now() };
    this.daemon.logger.warn('Smoothing moved to the CPU', { gpu: this.gpu, reason });
    if (stop) this.controller?.abort();
    if (notify) await notifyError(`Smoothing moved to the CPU: ${reason}`, { logger: this.daemon.logger });
    if (this.daemon.writeState) await this.daemon.writeState().catch(() => {});
  }

  // While a job runs on a GPU: the kernel's first fence timeout or hang naming RIFE moves smoothing to the CPU
  watch(rife) {
    const name = processName(rife);
    return this.daemon.kernelLog.follow(line => {
      const trouble = gpuTrouble(line, name);
      if (!trouble) return;
      const what = trouble === 'hang' ? 'the GPU hung' : 'the GPU timed out a fence';
      this.fallBack(`${what} under RIFE ("${String(line).trim().slice(0, 120)}")`)
        .catch(error => this.daemon.logger.warn('Failed to move smoothing to the CPU', { error: error.message }));
    });
  }

  async begin() {
    if (!this.settings.paths.smooth) return;
    await removeStaleSmoothWork(this.settings.paths.smooth);
    await this.recordSizes();
    await this.prune();
    await this.daemon.bounce.swap(null);
    this.backlog();
  }

  // The size every monitor now needs a copy of the item at (null while none is known)
  need(media) {
    return neededSize(media, [...this.daemon.monitors.values()]);
  }

  // Copies made before their size was recorded (before 2.69.0, or a crash after the copy) are probed once, so the
  // size check can tell whether they cover the monitors; one that cannot be probed is deleted by the next prune
  async recordSizes() {
    const dir = this.settings.paths.smooth;
    const probe = this.daemon.probe ?? probeMedia;
    for (const copy of await listSmoothed(dir)) {
      const media = { id: copy.id, speed: copy.speed };
      if (copy.reversed || smoothedSize(media, dir)) continue;
      try {
        const { width, height } = await probe(copy.file);
        if (width > 0 && height > 0) await fs.writeJson(smoothedSizePath(media, dir), { width, height });
      } catch (error) {
        this.daemon.logger.warn('Failed to probe a smoothed copy', { file: copy.file, error: error.message });
      }
    }
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

  // Whether an item needs work: its smoothed copy when it stutters, or the reversed copy of a copy it has when it bounces
  needs(media) {
    if (!this.enabled || !wantsSmoothing(media, this.target)) return false;
    const dir = this.settings.paths.smooth;
    const need = this.need(media);
    // A copy smaller than the monitors need is made again at their size (a larger monitor, or download --upgrade)
    if (!smoothedReady(media, dir, need)) return stutters(media, this.below) || smoothedReady(media, dir);
    return bounces(media, this.settings.display) && !smoothedReversedReady(media, dir, need);
  }

  // first: ahead of the backlog (an item playing or next)
  want(media, { first = false, start = true } = {}) {
    if (!media || this.failed.has(media.id) || this.encoding === media.id || !this.needs(media)) return;
    if (first) {
      this.queue = new Map([[media.id, media], ...[...this.queue].filter(([id]) => id !== media.id)]);
      this.urgent.add(media.id);
    }
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
    const slowed = Boolean(media && MODE_KINDS.video.includes(media.kind) && stutters(media, this.below));
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
    const urgent = this.urgent.delete(id);
    // The item as it is now: its speed may have changed while it waited
    const media = this.daemon.database.getMedia(id) ?? queued;
    // A backlog copy made into a full cache would only be pruned again; it waits for the next backlog
    if (!this.needs(media) || (!urgent && !this.hasRoom())) {
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
    if (!smoothedReady(media, dir, size)) {
      // Awaited only for a GPU: on the CPU the job starts at once
      const gpu = this.gpu < 0 || this.fallback ? -1 : await this.device();
      if (signal.aborted) return this.requeue(media);
      const watch = gpu >= 0 ? this.watch(display.smooth_rife) : null;
      let made;
      try {
        made = await this.daemon.smoothVideo(media, { dir, size, target: this.target, rife: display.smooth_rife, gpu, signal });
      } catch (error) {
        if (!(error instanceof RifeTimeoutError)) throw error;
        // On a GPU a stalled chunk may be a hang coming; on the CPU the item is given up until the daemon restarts
        if (gpu >= 0) {
          await this.fallBack(error.message);
          return this.requeue(media);
        }
        this.failed.add(media.id);
        return;
      } finally {
        watch?.stop();
      }
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
    if (bounces(media, display) && !smoothedReversedReady(media, dir, size)) {
      const fps = media.fps * smoothFactor(media.fps, media.speed, this.target);
      const copy = { id: `${media.id}@${media.speed}.reversed`, kind: media.kind, path: smoothedPath(media, dir), duration: media.duration, fps, ...size };
      const reversed = await this.daemon.reverse(copy, { signal, dir });
      if (signal.aborted) return this.requeue(media);
      if (!reversed || reversed !== smoothedReversedPath(media, dir)) this.daemon.logger.warn('No reversed smoothed copy', { mediaId: media.id });
    }
    await this.daemon.enqueue(async () => {
      this.daemon.bounce.pending.add(media.id);
      await this.daemon.bounce.swap(this.daemon.bounce.pending);
      // The new copy is for an item playing, next, or high in the backlog
      await this.prune(new Set([media.id]));
    });
  }

  // Whether the cache has room for one more copy of the average size so far (any size while it is empty)
  hasRoom() {
    const limit = (this.settings.display.smooth_cache_gb ?? 0) * GIGABYTE;
    if (!limit) return true;
    const { bytes, items } = this.usage;
    return items ? bytes + bytes / items <= limit : bytes < limit;
  }

  requeue(media) {
    if (!this.daemon.stopping) this.queue = new Map([[media.id, media], ...this.queue]);
  }

  pause() {
    this.controller?.abort();
  }

  async stop() {
    this.queue.clear();
    this.urgent.clear();
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

  // `backdrop copies --sync`: sizes recorded for copies without one, then as for a settings change (which also
  // queues copies smaller than the monitors need)
  async resync() {
    if (this.settings.paths.smooth) await this.recordSizes();
    await this.reconfigure();
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

  // Deletes copies no longer wanted: the item gone, skipped, at another speed or no longer slowed, and a
  // reversed copy of an item that no longer bounces, and the kept work of jobs for them. Then, while the rest do not fit
  // in display.smooth_cache_gb (0 for no limit), an item's copies (forward and reversed together) of the lowest-rated
  // items, the newest first, as display.bounce_cache_gb does. Copies of what plays now and of protect stay, counted
  // toward the limit. Their entries go back to what the item loads now. Returns the ids whose copies were deleted.
  async prune(protect = new Set()) {
    const { paths, display } = this.settings;
    if (!paths.smooth) return [];
    const playing = new Set([...this.daemon.screens.values()].map(screen => screen.media?.id).filter(Boolean));
    for (const id of protect) playing.add(id);
    const removed = new Set();
    const remove = async copy => {
      try {
        await fs.remove(copy.file);
        if (!copy.reversed) await fs.remove(smoothedSizePath(copy, paths.smooth));
        removed.add(copy.id);
        return true;
      } catch (error) {
        this.daemon.logger.warn('Failed to delete a smoothed copy', { file: copy.file, error: error.message });
        return false;
      }
    };
    const kept = new Map();
    for (const copy of await listSmoothed(paths.smooth)) {
      const media = playing.has(copy.id) ? null : this.daemon.database.getMedia(copy.id);
      // A copy older than its video (download --upgrade replaced it) shows what the item no longer is
      const wanted = playing.has(copy.id) || (media?.path && media.status !== 'skipped' && media.speed === copy.speed
        && wantsSmoothing(media, this.target) && (!copy.reversed || bounces(media, display)) && !staleCopy(copy.file, media));
      if (!wanted && await remove(copy)) continue;
      const item = kept.get(copy.id) ?? { id: copy.id, copies: [], size: 0, mtimeMs: 0 };
      item.copies.push(copy);
      item.size += copy.size;
      item.mtimeMs = Math.max(item.mtimeMs, copy.mtimeMs);
      kept.set(copy.id, item);
    }
    const limit = (display.smooth_cache_gb ?? 0) * GIGABYTE;
    let total = [...kept.values()].reduce((sum, item) => sum + item.size, 0);
    const rating = id => this.daemon.database.getLatestRating(id)?.rating ?? 0;
    const order = [...kept.values()].filter(item => !playing.has(item.id))
      .map(item => ({ ...item, rating: rating(item.id) }))
      .sort((a, b) => a.rating - b.rating || b.mtimeMs - a.mtimeMs);
    let evicted = 0;
    for (const item of order) {
      if (!limit || total <= limit) break;
      let gone = 0;
      for (const copy of item.copies) {
        if (!await remove(copy)) continue;
        total -= copy.size;
        gone++;
      }
      if (gone === item.copies.length) kept.delete(item.id);
      if (gone) evicted++;
    }
    this.usage = { bytes: total, items: kept.size };
    // A stopped job's chunks stay only while its item still wants that copy (the job running now keeps its own)
    for (const work of await listSmoothWork(paths.smooth)) {
      if (work.id === this.encoding) continue;
      const media = this.daemon.database.getMedia(work.id);
      const wanted = media?.path && media.status !== 'skipped' && media.speed === work.speed && wantsSmoothing(media, this.target);
      if (!wanted) await fs.remove(work.file).catch(error => this.daemon.logger.warn('Failed to delete smoothing work', { file: work.file, error: error.message }));
    }
    if (removed.size) {
      this.daemon.logger.info('Pruned smoothed copies', { items: removed.size, overLimit: evicted, bytesKept: total });
      await this.daemon.bounce.swap(removed);
    }
    return [...removed];
  }
}

