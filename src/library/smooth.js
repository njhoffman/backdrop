import fs from 'fs-extra';
import path from 'path';
import { ENCODERS, ENCODER_ORDER, run } from './reverse.js';

// Smoothed copies of slowed videos (display.smooth): RIFE (rife-ncnn-vulkan, on the GPU through Vulkan) makes the
// frames in between, so a video slowed to a speed still shows display.smooth_fps frames a second. A copy has the same
// length as the video and a whole multiple of its frame rate, and plays at the item's stored speed as the video did;
// it is named for that speed, so a speed change leaves it stale.
//
// It is made a chunk at a time (about two seconds of video): the chunk's frames, and the first of the next so the
// motion across the join is interpolated too, go through ffmpeg to PNG, RIFE and back, so the PNGs never fill the
// disk. Frames are scaled first to cover the largest monitor (never above the video's own size): the wallpaper shows
// no more, and RIFE's time grows with the pixels.

const CHUNK_SECONDS = 2;

export function smoothedPath(media, dir) {
  return path.join(dir, `${media.id}@${media.speed}.mp4`);
}

// The reversed copy of a smoothed copy, for a bouncing video
export function smoothedReversedPath(media, dir) {
  return path.join(dir, `${media.id}@${media.speed}.reversed.mp4`);
}

function newer(file, than) {
  try {
    return fs.statSync(file).mtimeMs >= fs.statSync(than).mtimeMs;
  } catch {
    return false;
  }
}

// Whether the item's copy for its speed exists and is no older than the video
export function smoothedReady(media, dir) {
  return Boolean(media?.path && dir && newer(smoothedPath(media, dir), media.path));
}

export function smoothedReversedReady(media, dir) {
  return Boolean(media?.path && dir && newer(smoothedReversedPath(media, dir), smoothedPath(media, dir)) && smoothedReady(media, dir));
}

// The whole factor of frames that brings a video of fps at speed to the target frames a second, or 1 when it already
// shows that many. Within 1% counts: 29.97 fps at 0.5 takes 4 (59.94 a second), not 5.
export function smoothFactor(fps, speed, target = 60) {
  if (!(fps > 0) || !(speed > 0)) return 1;
  return Math.max(1, Math.ceil((target * 0.99) / (fps * speed)));
}

// Whether an item wants a smoothed copy: a downloaded video, slowed, that shows fewer than target frames a second
export function wantsSmoothing(media, target = 60) {
  return Boolean(media?.path && ['video', 'gif'].includes(media.kind) && media.speed < 1 && media.fps > 0
    && media.duration > 0 && smoothFactor(media.fps, media.speed, target) > 1);
}

// The size to make the copy at: the video scaled to cover every monitor (the largest's short side, as the wallpaper's
// panscan fills it), never above its own size, in even numbers
export function smoothSize(media, monitors = []) {
  const { width, height } = media;
  if (!(width > 0 && height > 0)) return null;
  const cover = Math.max(0, ...monitors.map(monitor => Math.max(
    (monitor.width ?? 0) / width, (monitor.height ?? 0) / height
  )));
  const scale = cover > 0 ? Math.min(1, cover) : 1;
  const even = value => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

// The RIFE model beside the binary (rife-v4.6, which takes any number of frames between two)
export function rifeModel(binary) {
  return path.join(path.dirname(binary), 'rife-v4.6');
}

// Makes the smoothed copy: returns its path, or null when it could not (logged) or signal aborted it. rife is the
// binary; size from smoothSize; target is display.smooth_fps. Work happens in <dir>/<id>.<pid>.smooth.tmp.
export async function smoothVideo(media, dir, {
  rife, size, target = 60, exec = run, logger, signal, encoders = ENCODER_ORDER, now = Date.now, nice = true
} = {}) {
  if (!wantsSmoothing(media, target) || !rife || !size) return null;
  const factor = smoothFactor(media.fps, media.speed, target);
  const fps = media.fps * factor;
  const work = path.join(dir, `${media.id}.${process.pid}.smooth.tmp`);
  const command = (file, args) => (nice ? exec('nice', ['-n', '19', file, ...args], { signal }) : exec(file, args, { signal }));
  // Chunks start at frame numbers, sought half a frame early so the seek lands on that frame whatever the rate
  const perChunk = Math.max(2, Math.round(CHUNK_SECONDS * media.fps));
  const total = Math.max(1, Math.round(media.duration * media.fps));
  const starts = [];
  for (let frame = 0; frame < total; frame += perChunk) starts.push(Math.max(0, Math.round(((frame - 0.5) / media.fps) * 1e6) / 1e6));
  const started = now();
  await fs.ensureDir(dir);

  for (const name of encoders) {
    const encoder = ENCODERS[name];
    try {
      await fs.emptyDir(work);
      const parts = [];
      for (const [index, start] of starts.entries()) {
        if (signal?.aborted) return null;
        const frames = path.join(work, 'in');
        const out = path.join(work, 'out');
        await fs.emptyDir(frames);
        await fs.emptyDir(out);
        const last = index === starts.length - 1;
        // The chunk's frames and, but for the last, the next chunk's first: its in-between frames belong to this one
        const count = perChunk + (last ? 0 : 1);
        // passthrough: the decoded frames as they are; the image muxer's constant rate would repeat one at a gap in
        // the timestamps, which plays as a stall
        await command('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-i', media.path, '-frames:v', String(count),
          '-an', '-sn', '-dn', '-vf', `scale=${size.width}:${size.height}:flags=lanczos`, '-fps_mode', 'passthrough', path.join(frames, '%06d.png')]);
        const taken = (await fs.readdir(frames)).length;
        if (!taken) break;
        // factor - 1 frames between each pair: (taken - 1) * factor + 1 in all, ending on the last frame taken
        const wanted = taken === 1 ? 1 : (taken - 1) * factor + 1;
        if (taken > 1) {
          await command(rife, ['-i', frames, '-o', out, '-m', rifeModel(rife), '-n', String(wanted), '-g', '0', '-f', '%08d.png']);
        } else {
          await fs.copy(path.join(frames, '000001.png'), path.join(out, '00000001.png'));
        }
        // The frame shared with the next chunk is that chunk's first; it is dropped here
        const keep = last ? wanted : wanted - 1;
        const part = path.join(work, `p${String(index).padStart(5, '0')}.mp4`);
        await command('ffmpeg', ['-v', 'error', '-y', ...encoder.input, '-framerate', String(fps), '-i', path.join(out, '%08d.png'),
          '-frames:v', String(keep), '-vf', encoder.filter.replace(/^reverse,?/, '') || 'null', ...encoder.output, part]);
        parts.push(path.basename(part));
      }
      if (signal?.aborted || !parts.length) return null;
      await fs.writeFile(path.join(work, 'parts.txt'), `${parts.map(part => `file '${part}'`).join('\n')}\n`);
      const joined = path.join(work, 'smoothed.mp4');
      await command('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'parts.txt'),
        '-c', 'copy', '-movflags', '+faststart', joined]);
      const copy = smoothedPath(media, dir);
      await fs.rename(joined, copy);
      logger?.info('Smoothed video', {
        mediaId: media.id, speed: media.speed, factor, fps, size: `${size.width}x${size.height}`, encoder: name,
        seconds: Math.round((now() - started) / 100) / 10
      });
      return copy;
    } catch (error) {
      if (signal?.aborted) return null;
      logger?.warn('Smoothing failed', { mediaId: media.id, encoder: name, error: error.message.split('\n')[0] });
    } finally {
      await fs.remove(work).catch(() => {});
    }
  }
  return null;
}

// Copies of items that no longer want them (another speed, gone, skipped, smoothing off) and stale work folders
export async function listSmoothed(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.map(name => {
    const match = /^(\d+)@([\d.]+)(\.reversed)?\.mp4$/.exec(name);
    return match ? { id: Number(match[1]), speed: Number(match[2]), reversed: Boolean(match[3]), file: path.join(dir, name) } : null;
  }).filter(Boolean);
}

export async function removeStaleSmoothWork(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(names.filter(name => name.endsWith('.smooth.tmp') || name.endsWith('.tmp')).map(name => fs.remove(path.join(dir, name))));
}
