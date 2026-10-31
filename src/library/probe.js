import fs from 'fs/promises';
import { run } from '../display/Monitors.js';

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v'];
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

const PROBE_ARGS = [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,codec_name,avg_frame_rate:stream_side_data=rotation:format=duration,format_name',
  '-of', 'json'
];

// Single-frame formats ffprobe reports as image2 or <codec>_pipe
function isStillImageFormat(formatName) {
  return formatName === 'image2' || formatName.endsWith('_pipe');
}

// ffprobe frame rates are fractions such as 30000/1001; 0/0 means unknown. Rounded to 3 decimals.
export function parseFrameRate(rate) {
  const [numerator, denominator = 1] = String(rate ?? '').split('/').map(Number);
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

// Turns ffprobe JSON into { kind, width, height, duration, fps }, or null when there is no picture
export function parseProbe(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const stream = data.streams?.[0];
  const formatName = data.format?.format_name ?? '';
  if (!stream?.width || !stream?.height) {
    return null;
  }

  let { width, height } = stream;
  const rotation = Math.abs(Number(stream.side_data_list?.find(item => 'rotation' in item)?.rotation ?? 0));
  if (rotation === 90 || rotation === 270) {
    [width, height] = [height, width];
  }

  let kind;
  if (formatName.split(',').includes('gif')) {
    kind = 'gif';
  } else if (isStillImageFormat(formatName)) {
    kind = 'image';
  } else {
    kind = 'video';
  }

  const duration = kind === 'image' ? null : Number(data.format?.duration) || null;
  const fps = kind === 'image' ? null : parseFrameRate(stream.avg_frame_rate);
  return { kind, width, height, duration, fps };
}

// A probe that found nothing playable, with the reason (Importer records it as the file's detail)
export class UnsupportedMedia extends Error {}

// `backdrop doctor` lists files skipped for this and how to convert them
export const ANIMATED_WEBP = 'animated WebP, which this FFmpeg cannot decode';

// Animated WebP sets the animation flag (0x02) of the extended format chunk: RIFF....WEBPVP8X, flags at byte 20
export function isAnimatedWebp(header) {
  return header.length >= 21 && header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 16) === 'WEBPVP8X'
    && (header[20] & 0x02) !== 0;
}

async function readHeader(file, length = 21) {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// FFmpeg before 8 has no animated WebP decoder: ffprobe reports a 0x0 picture and mpv cannot play it,
// so such a file is rejected with that reason. One FFmpeg can decode plays as an animation, like a GIF.
export async function probeMedia(file, exec = run, header = readHeader) {
  const info = parseProbe(await exec('ffprobe', [...PROBE_ARGS, file]));
  if (!/\.webp$/i.test(file)) return info;
  const animated = isAnimatedWebp(await header(file));
  if (animated && !info) throw new UnsupportedMedia(ANIMATED_WEBP);
  return animated ? { ...info, kind: 'gif' } : info;
}

// Long side against the larger minimum, short side against the smaller, so portrait media
// is held to the same standard as landscape
export function meetsMinimum({ width, height }, minWidth, minHeight) {
  const [longSide, shortSide] = width >= height ? [width, height] : [height, width];
  const [longMin, shortMin] = minWidth >= minHeight ? [minWidth, minHeight] : [minHeight, minWidth];
  return longSide >= longMin && shortSide >= shortMin;
}
