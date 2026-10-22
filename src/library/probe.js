import { run } from '../display/Monitors.js';

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v'];
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

const PROBE_ARGS = [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,codec_name:stream_side_data=rotation:format=duration,format_name',
  '-of', 'json'
];

// Single-frame formats ffprobe reports as image2 or <codec>_pipe
function isStillImageFormat(formatName) {
  return formatName === 'image2' || formatName.endsWith('_pipe');
}

// Turns ffprobe JSON into { kind, width, height, duration }, or null when there is no picture
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
  return { kind, width, height, duration };
}

export async function probeMedia(file, exec = run) {
  return parseProbe(await exec('ffprobe', [...PROBE_ARGS, file]));
}

// Long side against the larger minimum, short side against the smaller, so portrait media
// is held to the same standard as landscape
export function meetsMinimum({ width, height }, minWidth, minHeight) {
  const [longSide, shortSide] = width >= height ? [width, height] : [height, width];
  const [longMin, shortMin] = minWidth >= minHeight ? [minWidth, minHeight] : [minHeight, minWidth];
  return longSide >= longMin && shortSide >= shortMin;
}
