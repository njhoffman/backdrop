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

// display.smooth_fps when unset: 30 a second is enough for a slowed video not to stutter, and costs half the GPU
// time of 60
export const SMOOTH_FPS = 30;

// display.smooth_below when unset: a slowed video showing fewer frames a second than this stutters; 0.75 of 30 fps (22.5)
// plays well enough as it is, 0.75 of 24 (18) and 0.5 of 30 (15) do not
export const SMOOTH_BELOW = 20;

// Whether a slowed video stutters at its speed: only those get a new copy, and frame blending while it has none. A copy
// made before (another threshold) stays while wantsSmoothing holds, since it costs nothing more to keep
export function stutters(media, below = SMOOTH_BELOW) {
  return Boolean(media?.speed < 1 && media.fps > 0 && media.fps * media.speed < below);
}

// The whole factor of frames that brings a video of fps at speed to the target frames a second, or 1 when it already
// shows that many. Within 1% counts: 29.97 fps at 0.5 takes 4 (59.94 a second), not 5.
export function smoothFactor(fps, speed, target = SMOOTH_FPS) {
  if (!(fps > 0) || !(speed > 0)) return 1;
  return Math.max(1, Math.ceil((target * 0.99) / (fps * speed)));
}

// Whether an item wants a smoothed copy: a downloaded video, slowed, that shows fewer than target frames a second
export function wantsSmoothing(media, target = SMOOTH_FPS) {
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

// The folder a copy is made in, kept when a job stops so the next one carries on from its finished chunks
export function smoothWorkPath(media, dir) {
  return path.join(dir, `${media.id}@${media.speed}.smooth.work`);
}

// What a work folder's chunks were made from and how; a job resumes only one that matches all but the encoder. The
// source is its size and modification time, not its path, so a file a rating moved (renamed, same mtime) still matches.
function jobOf(media, { size, factor, perChunk, total }) {
  const stat = fs.statSync(media.path);
  return { source: { size: stat.size, mtimeMs: stat.mtimeMs }, size, factor, perChunk, total };
}

function sameJob(a, b) {
  return Boolean(a && b && JSON.stringify({ ...a, encoder: undefined }) === JSON.stringify({ ...b, encoder: undefined }));
}

async function readJob(work) {
  return fs.readJson(path.join(work, 'job.json')).catch(() => null);
}

const partName = index => `p${String(index).padStart(5, '0')}.mp4`;

// Makes the smoothed copy: returns its path, or null when it could not (logged) or signal aborted it. rife is the
// binary; size from smoothSize; target is display.smooth_fps. Work happens in smoothWorkPath: each finished chunk is
// kept there, so a job stopped by the load or a daemon restart starts again at its first missing chunk, with the
// encoder it was using. A finished copy, or a failure with every encoder, removes the folder.
export async function smoothVideo(media, dir, {
  rife, size, target = SMOOTH_FPS, exec = run, logger, signal, encoders = ENCODER_ORDER, now = Date.now, nice = true
} = {}) {
  if (!wantsSmoothing(media, target) || !rife || !size) return null;
  const factor = smoothFactor(media.fps, media.speed, target);
  const fps = media.fps * factor;
  const work = smoothWorkPath(media, dir);
  const command = (file, args) => (nice ? exec('nice', ['-n', '19', file, ...args], { signal }) : exec(file, args, { signal }));
  // Chunks start at frame numbers, sought half a frame early so the seek lands on that frame whatever the rate
  const perChunk = Math.max(2, Math.round(CHUNK_SECONDS * media.fps));
  const total = Math.max(1, Math.round(media.duration * media.fps));
  const starts = [];
  for (let frame = 0; frame < total; frame += perChunk) starts.push(Math.max(0, Math.round(((frame - 0.5) / media.fps) * 1e6) / 1e6));
  const started = now();
  await fs.ensureDir(dir);
  let job;
  try {
    job = jobOf(media, { size, factor, perChunk, total });
  } catch (error) {
    logger?.warn('Smoothing failed', { mediaId: media.id, error: error.message });
    return null;
  }
  // A matching job left behind resumes with its encoder; anything else starts afresh
  const previous = await readJob(work);
  const resumes = sameJob(previous, job) && encoders.includes(previous.encoder);
  const order = resumes ? encoders.slice(encoders.indexOf(previous.encoder)) : encoders;

  for (const [attempt, name] of order.entries()) {
    const encoder = ENCODERS[name];
    let keepWork = false;
    try {
      if (!(resumes && attempt === 0)) {
        await fs.emptyDir(work);
        await fs.writeJson(path.join(work, 'job.json'), { ...job, encoder: name });
      }
      const done = new Set((await fs.readdir(work)).filter(file => /^p\d{5}\.mp4$/.test(file)));
      if (done.size) logger?.info('Resuming smoothing', { mediaId: media.id, chunks: `${done.size} of ${starts.length}`, encoder: name });
      const parts = [];
      for (const [index, start] of starts.entries()) {
        if (signal?.aborted) {
          keepWork = true;
          return null;
        }
        const part = path.join(work, partName(index));
        if (done.has(partName(index))) {
          parts.push(path.basename(part));
          continue;
        }
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
        // Written under another name and renamed, so a chunk cut short is never taken for a finished one
        const partial = path.join(work, `partial-${partName(index)}`);
        await command('ffmpeg', ['-v', 'error', '-y', ...encoder.input, '-framerate', String(fps), '-i', path.join(out, '%08d.png'),
          '-frames:v', String(keep), '-vf', encoder.filter.replace(/^reverse,?/, '') || 'null', ...encoder.output, partial]);
        await fs.rename(partial, part);
        parts.push(path.basename(part));
      }
      if (signal?.aborted) {
        keepWork = true;
        return null;
      }
      if (!parts.length) return null;
      await fs.writeFile(path.join(work, 'parts.txt'), `${parts.map(part => `file '${part}'`).join('\n')}\n`);
      const joined = path.join(work, 'smoothed.mp4');
      await command('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'parts.txt'),
        '-c', 'copy', '-movflags', '+faststart', joined]);
      const copy = smoothedPath(media, dir);
      await fs.rename(joined, copy);
      logger?.info('Smoothed video', {
        mediaId: media.id, speed: media.speed, factor, fps, size: `${size.width}x${size.height}`, encoder: name,
        resumed: done.size, seconds: Math.round((now() - started) / 100) / 10
      });
      return copy;
    } catch (error) {
      if (signal?.aborted) {
        keepWork = true;
        return null;
      }
      logger?.warn('Smoothing failed', { mediaId: media.id, encoder: name, error: error.message.split('\n')[0] });
    } finally {
      // A stopped job keeps its chunks; a finished or failed one leaves nothing
      if (!keepWork) await fs.remove(work).catch(() => {});
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

// Work folders kept by stopped jobs, by item and speed
export async function listSmoothWork(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.map(name => {
    const match = /^(\d+)@([\d.]+)\.smooth\.work$/.exec(name);
    return match ? { id: Number(match[1]), speed: Number(match[2]), file: path.join(dir, name) } : null;
  }).filter(Boolean);
}

// Leftovers of jobs a crash ended in the middle of a step (temporary files, and the work folders of versions before
// 2.64, named for the process); kept work folders stay for their job to resume
export async function removeStaleSmoothWork(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(names.filter(name => name.endsWith('.tmp')).map(name => fs.remove(path.join(dir, name))));
}
