import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';

// A reversed copy of a video, which a bouncing video plays after the original (src/display/bounce.js).
// ffmpeg's reverse filter holds every frame it is given, so the video is reversed in short chunks, each
// read from its start (-ss before -i is frame accurate when re-encoding), and the chunks are joined in
// reverse order without encoding again. The chunk length keeps the raw frames of one chunk near CHUNK_BYTES.

const execFileAsync = promisify(execFile);

// execFile with an AbortSignal, which kills ffmpeg when the daemon stops or the load rises
export const run = async (file, args, { signal } = {}) => (await execFileAsync(file, args, { signal })).stdout;

const CHUNK_BYTES = 256 * 1024 * 1024;
const MIN_CHUNK = 0.25;
const MAX_CHUNK = 2;
// For frame sizes and rates not recorded yet
const DEFAULT_FPS = 60;

// Encoders tried in order: VAAPI where the GPU has it, libx264 everywhere else. Every chunk of one copy
// comes from the same encoder, since joining them without encoding needs matching streams.
export const ENCODERS = {
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

export function reversedPath(media, dir) {
  return path.join(dir, `${media.id}.mp4`);
}

// Whether the reversed copy exists and is no older than the video (download --upgrade replaces it)
export function reversedReady(media, dir) {
  if (!media?.path || !dir) return false;
  try {
    return fs.statSync(reversedPath(media, dir)).mtimeMs >= fs.statSync(media.path).mtimeMs;
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

// Chunk start times; none starts within half a frame of the end, where it would hold no frame
export function chunkStarts(duration, chunk, fps = DEFAULT_FPS) {
  const starts = [];
  for (let index = 0; index * chunk < duration - 0.5 / fps; index++) starts.push(Math.round(index * chunk * 1e6) / 1e6);
  return starts;
}

function chunkName(index) {
  return `c${String(index).padStart(5, '0')}.mp4`;
}

// Makes the reversed copy, trying each encoder in turn; returns its path, or null when none could make it or
// signal aborted it. Work happens in <dir>/<id>.<pid>.tmp, renamed into place only when complete.
export async function reverseVideo(media, dir, { exec = run, logger, nice = true, signal, encoders = ENCODER_ORDER, now = Date.now } = {}) {
  if (!media?.path || !(media.duration > 0)) return null;
  const target = reversedPath(media, dir);
  const work = path.join(dir, `${media.id}.${process.pid}.tmp`);
  const chunk = chunkSeconds(media);
  const starts = chunkStarts(media.duration, chunk, media.fps || DEFAULT_FPS);
  const ffmpeg = args => (nice ? exec('nice', ['-n', '19', 'ffmpeg', ...args], { signal }) : exec('ffmpeg', args, { signal }));
  await fs.ensureDir(dir);

  for (const name of encoders) {
    const encoder = ENCODERS[name];
    const started = now();
    try {
      await fs.emptyDir(work);
      for (const [index, start] of starts.entries()) {
        if (signal?.aborted) return null;
        await ffmpeg(['-v', 'error', '-y', ...encoder.input, '-ss', String(start), '-t', String(chunk), '-i', media.path,
          '-an', '-sn', '-dn', '-vf', encoder.filter, ...encoder.output, path.join(work, chunkName(index))]);
      }
      // Relative names resolve against the list's own folder
      const list = starts.map((start, index) => `file '${chunkName(index)}'`).reverse().join('\n');
      await fs.writeFile(path.join(work, 'chunks.txt'), `${list}\n`);
      const joined = path.join(work, 'reversed.mp4');
      await ffmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'chunks.txt'),
        '-c', 'copy', '-movflags', '+faststart', joined]);
      await fs.rename(joined, target);
      logger?.info('Reversed video for bounce', { mediaId: media.id, encoder: name, chunks: starts.length, seconds: Math.round((now() - started) / 100) / 10 });
      return target;
    } catch (error) {
      if (signal?.aborted) return null;
      logger?.warn('Reverse encode failed', { mediaId: media.id, encoder: name, error: error.message.split('\n')[0] });
    } finally {
      await fs.remove(work).catch(() => {});
    }
  }
  return null;
}

// Work folders a daemon left when it died mid-encode
export async function removeStaleWork(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(names.filter(name => name.endsWith('.tmp')).map(name => fs.remove(path.join(dir, name))));
}

// The finished copies in dir: { id, file, size, mtimeMs }, oldest first. Work folders and other names are left out.
export async function listReversed(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  const copies = [];
  for (const name of names) {
    const match = /^(\d+)\.mp4$/.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) copies.push({ id: Number(match[1]), file, size: stat.size, mtimeMs: stat.mtimeMs });
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
  if (!dir) return;
  await fs.remove(reversedPath(media, dir));
}
