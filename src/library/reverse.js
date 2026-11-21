import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { inOrder } from '../utils/pool.js';

// A reversed copy of a video, which a bouncing video plays after the original (src/display/bounce.js).
// ffmpeg's reverse filter holds every frame it is given, so the video is reversed in short chunks, each
// read from its start (-ss before -i is frame accurate when re-encoding), and the chunks are joined in
// reverse order without encoding again. The chunk length keeps the raw frames of one chunk near CHUNK_BYTES.
// Chunks are cut by frame number, as smoothVideo's parts are: a chunk of seconds at 24000/1001 ends between two
// frames, and the next chunk took the frame on its boundary again (720 frames reversed to 724, 2026-11-20).
// Chunks carry the video stream alone: ffmpeg 6.1 writes a timecode (tmcd) track from a source's timecode tag even
// with -dn, and a chunk past the last frame (the container can run past it) then holds only that track. The concat
// demuxer takes its streams from the first file, the last chunk, so such a chunk once made a copy every decoder
// rejected and mpv hung on (2026-11-20). Chunks with no frames are left out, and the joined copy is probed before
// it replaces anything.

const execFileAsync = promisify(execFile);

// execFile with an AbortSignal, which kills ffmpeg when the daemon stops or the load rises
export const run = async (file, args, { signal } = {}) => (await execFileAsync(file, args, { signal })).stdout;

const CHUNK_BYTES = 256 * 1024 * 1024;
const MIN_CHUNK = 0.25;
const MAX_CHUNK = 2;
// For frame sizes and rates not recorded yet
const DEFAULT_FPS = 60;

// Encoders tried in order: NVENC on an NVIDIA card, VAAPI where the GPU has it, libx264 everywhere else. Every chunk of
// one copy comes from the same encoder, since joining them without encoding needs matching streams.
export const ENCODERS = {
  nvenc: {
    input: [],
    filter: 'reverse,format=yuv420p',
    output: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0']
  },
  vaapi: {
    input: ['-init_hw_device', 'vaapi=va', '-filter_hw_device', 'va'],
    filter: 'reverse,format=nv12,hwupload',
    output: ['-c:v', 'h264_vaapi', '-qp', '20']
  },
  x264: {
    input: [],
    filter: 'reverse',
    output: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
  }
};
export const ENCODER_ORDER = ['vaapi', 'x264'];

// Where NVIDIA's kernel driver reports itself once loaded
export const NVIDIA_DRIVER = '/proc/driver/nvidia/version';

// The encoders to try on this machine. Where NVIDIA's driver is loaded, VAAPI goes through nvidia-vaapi-driver, which
// cannot encode, so every job failed with it before falling back; libx264 goes first there. NVENC is not tried yet:
// each ffmpeg spent about 19 s starting CUDA on minerva (GTX 960, persistence mode off, 2026-11-15) against about 1 s
// for a libx264 chunk on its 12 cores, and a reversal starts one ffmpeg per chunk. VAAPI first elsewhere.
export function defaultEncoders({ exists = fs.existsSync } = {}) {
  return exists(NVIDIA_DRIVER) ? ['x264'] : ENCODER_ORDER;
}

// Copies are named for the item's content (media.sha256), not its id, so a copy means the same video in any library
// and a replaced file (download --upgrade, a new sha256) leaves its old copy unwanted instead of stale. copyKey lets a
// caller name a copy of something else: a smoothed copy's reversal is "<sha256>@<speed>.reversed".
export const SHA256 = '[0-9a-f]{64}';

export function copyKey(media) {
  return media?.copyKey ?? media?.sha256 ?? null;
}

// The reversed copy's path, or null for an item with no sha256
export function reversedPath(media, dir) {
  const key = copyKey(media);
  return key && dir ? path.join(dir, `${key}.mp4`) : null;
}

// Whether the item's reversed copy exists
export function reversedReady(media, dir) {
  const file = media?.path ? reversedPath(media, dir) : null;
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Seconds per chunk, in hundredths
export function chunkSeconds(media) {
  const frame = (media.width || 1920) * (media.height || 1080) * 1.5;
  const seconds = CHUNK_BYTES / (frame * (media.fps || DEFAULT_FPS));
  return Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.floor(seconds * 100) / 100));
}

// Recorded in a job, so work kept from another way of seeking starts afresh
export const SEEK = 'quarter-frame';

// Frames per chunk of chunk seconds
export function chunkFrames(chunk, fps = DEFAULT_FPS) {
  return Math.max(1, Math.round(chunk * fps));
}

// The -ss (before -i) that starts a re-encode on a frame: a quarter frame early, so a rounded rate (23.976 for
// 24000/1001) cannot move it off. Half a frame early, as both copies once sought, started on the frame before in a
// video muxed with one timebase tick a frame (1/30, common from Pexels): the seek rounds to a tick, and the tie goes
// down (2026-11-20, framemd5 of the frames taken).
export function seekTime(frame, fps) {
  return Math.max(0, Math.round(((frame - 0.25) / fps) * 1e6) / 1e6);
}

// Chunk start times: every chunkFrames-th frame of the round(duration * fps) the video holds
export function chunkStarts(duration, chunk, fps = DEFAULT_FPS) {
  const perChunk = chunkFrames(chunk, fps);
  const total = Math.max(1, Math.round(duration * fps));
  const starts = [];
  for (let frame = 0; frame < total; frame += perChunk) starts.push(seekTime(frame, fps));
  return starts;
}

function chunkName(index) {
  return `c${String(index).padStart(5, '0')}.mp4`;
}

// The folder a copy is made in, kept when a job stops so the next one carries on from its finished chunks. A smoothed
// copy's reversal (key "<sha256>@<speed>.reversed", in the smooth folder) gets its own.
export function reverseWorkPath(media, dir) {
  return path.join(dir, `${copyKey(media)}.reverse.work`);
}

// What a work folder's chunks were made from; a job resumes only one that matches all but the encoder. The source is
// its size and modification time, not its path, so a file a rating moved (renamed, same mtime) still matches.
function jobOf(media, chunk, starts, perChunk) {
  const stat = fs.statSync(media.path);
  // perChunk: chunks cut by frame count; work kept from chunks cut by seconds (before 2.89.2) has none and starts afresh.
  // seek: how chunks were sought, so chunks one frame off (2.89.1) are not resumed either
  return { source: { size: stat.size, mtimeMs: stat.mtimeMs }, chunk, chunks: starts.length, perChunk, seek: SEEK };
}

function sameJob(a, b) {
  return Boolean(a && b && JSON.stringify({ ...a, encoder: undefined }) === JSON.stringify({ ...b, encoder: undefined }));
}

// Makes the reversed copy, trying each encoder in turn; returns its path, or null when none could make it or
// signal aborted it. Work happens in reverseWorkPath: each finished chunk is kept there, so a job stopped by the load
// or a daemon restart starts again at its first missing chunk, with the encoder it was using. A finished copy, or a
// failure with every encoder, removes the folder.
export async function reverseVideo(media, dir, {
  exec = run, probe = probeVideo, logger, nice = true, signal, encoders = ENCODER_ORDER, now = Date.now
} = {}) {
  if (!media?.path || !(media.duration > 0) || !copyKey(media)) return null;
  const target = reversedPath(media, dir);
  const work = reverseWorkPath(media, dir);
  const chunk = chunkSeconds(media);
  const fps = media.fps || DEFAULT_FPS;
  const starts = chunkStarts(media.duration, chunk, fps);
  const perChunk = chunkFrames(chunk, fps);
  const ffmpeg = args => (nice ? exec('nice', ['-n', '19', 'ffmpeg', ...args], { signal }) : exec('ffmpeg', args, { signal }));
  await fs.ensureDir(dir);
  let job;
  try {
    job = jobOf(media, chunk, starts, perChunk);
  } catch (error) {
    logger?.warn('Reverse encode failed', { mediaId: media.id, error: error.message });
    return null;
  }
  // A matching job left behind resumes with its encoder; anything else starts afresh
  const previous = await fs.readJson(path.join(work, 'job.json')).catch(() => null);
  const resumes = sameJob(previous, job) && encoders.includes(previous.encoder);
  const order = resumes ? encoders.slice(encoders.indexOf(previous.encoder)) : encoders;

  for (const [attempt, name] of order.entries()) {
    const encoder = ENCODERS[name];
    const started = now();
    let keepWork = false;
    try {
      if (!(resumes && attempt === 0)) {
        await fs.emptyDir(work);
        await fs.writeJson(path.join(work, 'job.json'), { ...job, encoder: name });
      }
      const done = new Set((await fs.readdir(work)).filter(file => /^c\d{5}\.mp4$/.test(file)));
      if (done.size) logger?.info('Resuming reverse', { mediaId: media.id, chunks: `${done.size} of ${starts.length}`, encoder: name });
      for (const [index, start] of starts.entries()) {
        if (signal?.aborted) {
          keepWork = true;
          return null;
        }
        if (done.has(chunkName(index))) continue;
        // Written under another name and renamed, so a chunk cut short is never taken for a finished one
        const partial = path.join(work, `partial-${chunkName(index)}`);
        // trim takes the chunk's frames before reverse holds them; -t, a frame longer, only bounds what is read
        await ffmpeg(['-v', 'error', '-y', ...encoder.input, '-ss', String(start), '-t', String(Math.round(((perChunk + 1) / fps) * 1e6) / 1e6),
          '-i', media.path, '-map', '0:v:0', '-vf', `trim=end_frame=${perChunk},${encoder.filter}`, ...encoder.output, '-write_tmcd', '0', partial]);
        await fs.rename(partial, path.join(work, chunkName(index)));
      }
      if (signal?.aborted) {
        keepWork = true;
        return null;
      }
      // A chunk that starts past the last frame holds none and is left out of the join
      const videos = await Promise.all(starts.map((start, index) => probe(path.join(work, chunkName(index)))));
      const kept = videos.flatMap((video, index) => (video?.frames > 0 ? [index] : []));
      if (!kept.length) throw new Error('no chunk holds a frame');
      // Relative names resolve against the list's own folder
      const list = kept.map(index => `file '${chunkName(index)}'`).reverse().join('\n');
      await fs.writeFile(path.join(work, 'chunks.txt'), `${list}\n`);
      const joined = path.join(work, 'reversed.mp4');
      await ffmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'chunks.txt'),
        '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', joined]);
      const frames = kept.reduce((sum, index) => sum + videos[index].frames, 0);
      const problem = copyProblem(await probe(joined), frames);
      if (problem) throw new Error(`the joined copy cannot be played: ${problem}`);
      // A count apart from the source's plays, with a frame held or skipped at a seam; it is only reported, since a
      // container's count can be off (none at all in Matroska)
      const source = await probe(media.path).catch(() => null);
      if (source?.frames && source.frames !== frames) {
        logger?.warn('Reversed copy has another frame count than the video', { mediaId: media.id, frames, source: source.frames });
      }
      await fs.rename(joined, target);
      logger?.info('Reversed video for bounce', {
        mediaId: media.id, encoder: name, chunks: starts.length, resumed: done.size, seconds: Math.round((now() - started) / 100) / 10
      });
      return target;
    } catch (error) {
      if (signal?.aborted) {
        keepWork = true;
        return null;
      }
      // A rating moved the file (inbox to library, or to the trash): no encoder can read it there; the chunks stay
      // (a rename keeps the size and time the job is matched by) and the bounce job tries again from its new path
      if (!await fs.pathExists(media.path)) {
        keepWork = true;
        logger?.info('Reverse stopped: the file moved', { mediaId: media.id });
        return null;
      }
      logger?.warn('Reverse encode failed', { mediaId: media.id, encoder: name, error: error.message.split('\n')[0] });
    } finally {
      // A stopped job keeps its chunks; a finished or failed one leaves nothing
      if (!keepWork) await fs.remove(work).catch(() => {});
    }
  }
  return null;
}

// A file's first video stream as { codec, pixFmt, frames }, or null when it has none. frames is the container's count
// (no decoding); pixFmt is null when ffprobe cannot tell it, as for a stream whose parameters are missing.
export async function probeVideo(file, { exec = run } = {}) {
  const output = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,pix_fmt,nb_frames', '-of', 'json', file]);
  const stream = JSON.parse(output || '{}').streams?.[0];
  if (!stream) return null;
  const pixFmt = stream.pix_fmt && stream.pix_fmt !== 'unknown' ? stream.pix_fmt : null;
  return { codec: stream.codec_name ?? null, pixFmt, frames: Number(stream.nb_frames) || 0 };
}

// Why a made copy cannot be played (probeVideo's result), or null when it can; frames, when given, is the count it
// must hold
export function copyProblem(video, frames = null) {
  if (!video) return 'no video stream';
  if (!video.pixFmt) return 'the video stream has no pixel format';
  if (!video.frames) return 'no frames';
  if (frames !== null && video.frames !== frames) return `${video.frames} frames where ${frames} were joined`;
  return null;
}

// Removes the copies ({ file }, as listReversed and listSmoothed give them) that cannot be played, so they are made
// again; returns those removed. Copies are probed before they are put in place, but one made before 2.89.1, damaged
// on disk or put there by hand is not, and mpv hangs on a copy no decoder takes. A copy ffprobe cannot read at all
// (or no ffprobe) is kept: deleting on an error would empty the cache wherever ffprobe fails, and mpv fails to load
// such a file rather than hanging, which drops its entry.
export async function removeBrokenCopies(copies, { probe = probeVideo, logger, concurrency = 4 } = {}) {
  const removed = [];
  for await (const { item, result, error } of inOrder(copies, copy => probe(copy.file), { concurrency })) {
    if (error) {
      logger?.debug('Cannot probe a copy', { file: item.file, error: error.message.split('\n')[0] });
      continue;
    }
    const problem = copyProblem(result);
    if (!problem) continue;
    try {
      await fs.remove(item.file);
      removed.push(item);
      logger?.warn('Removed a copy that cannot be played', { file: item.file, problem });
    } catch (removeError) {
      logger?.warn('Failed to remove a copy that cannot be played', { file: item.file, error: removeError.message });
    }
  }
  return removed;
}

// Work folders kept by stopped jobs: { key, file }, key the copy's name before the suffix ("<sha256>", or
// "<sha256>@0.5.reversed" for a smoothed copy's reversal)
export async function listReverseWork(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  return names.map(name => {
    const match = /^(.+)\.reverse\.work$/.exec(name);
    return match ? { key: match[1], file: path.join(dir, name) } : null;
  }).filter(Boolean);
}

// Work folders a daemon of a version before 2.80 left when it died mid-encode (named for its pid); kept work folders
// stay for their job to resume
export async function removeStaleWork(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(names.filter(name => name.endsWith('.tmp')).map(name => fs.remove(path.join(dir, name))));
}

// The finished copies in dir: { sha256, file, size, mtimeMs }, oldest first. Work folders and other names are left out.
export async function listReversed(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const copies = [];
  const pattern = new RegExp(`^(${SHA256})\\.mp4$`);
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) copies.push({ sha256: match[1], file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return copies.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// Encodes counted per day in the settings table, for `doctor`: { 'YYYY-MM-DD': { count, seconds } }, the last week
const ENCODES_KEY = 'bounce_encodes';
const ENCODE_DAYS = 7;

function dayOf(date) {
  return date.toISOString().slice(0, 10);
}

export function recordEncode(database, now, seconds) {
  const days = database.getSetting(ENCODES_KEY, {});
  const day = dayOf(now);
  const today = days[day] ?? { count: 0, seconds: 0 };
  days[day] = { count: today.count + 1, seconds: Math.round((today.seconds + seconds) * 10) / 10 };
  const kept = Object.keys(days).sort().slice(-ENCODE_DAYS);
  database.setSetting(ENCODES_KEY, Object.fromEntries(kept.map(key => [key, days[key]])));
}

// { today, yesterday }, each { count, seconds } (UTC days)
export function encodeCounts(database, now = new Date()) {
  const days = database.getSetting(ENCODES_KEY, {});
  const empty = { count: 0, seconds: 0 };
  return { today: days[dayOf(now)] ?? empty, yesterday: days[dayOf(new Date(now.getTime() - 86400000))] ?? empty };
}

// Drops an item's reversed copy (purged, or its file replaced)
export async function removeReversed(media, dir) {
  const file = reversedPath(media, dir);
  if (file) await fs.remove(file);
}
