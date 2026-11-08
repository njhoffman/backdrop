import fs from 'fs-extra';
import path from 'path';
import { run } from '../display/Monitors.js';

// The panel menu's banner (728x200) at twice its size for HiDPI screens, cropped from the middle
const WIDTH = 1456;
const HEIGHT = 400;
const COVER = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}`;

// A cached JPEG banner of a library item: a frame a second in (or halfway through short clips) for
// videos and GIFs, the picture itself for images. It is rebuilt when the file is newer, e.g. after
// download --upgrade. Returns the thumbnail path, or null when ffmpeg cannot make one.
// nice runs ffmpeg at the lowest CPU priority, for the daemon making them ahead of time.
export function thumbnailFor(media, dir, options = {}) {
  return cachedFrame(media, dir, { ...options, name: `${media?.id}.jpg`, filter: COVER });
}

// The notification's picture (display.notify): a 16:9 still, 320x180 like a video's poster, cropped from the middle,
// a frame a second in for videos as the banner. Notification servers draw it small (deadd within 75 px by default),
// so a 16:9 frame keeps more of the picture than the banner's strip. Same cache and rebuild rule as thumbnailFor.
const STILL = 'scale=320:180:force_original_aspect_ratio=increase,crop=320:180';

export function stillFor(media, dir, options = {}) {
  return cachedFrame(media, dir, { ...options, name: `${media?.id}.still.jpg`, filter: STILL });
}

async function cachedFrame(media, dir, { exec = run, logger, nice = false, name, filter }) {
  if (!media?.path) return null;
  const target = path.join(dir, name);
  try {
    const [source, existing] = await Promise.all([fs.stat(media.path), fs.stat(target).catch(() => null)]);
    if (existing && existing.mtimeMs >= source.mtimeMs) return target;
    await fs.ensureDir(dir);
    const seek = media.kind === 'image' ? [] : ['-ss', String(Math.min(1, (media.duration || 2) / 2))];
    const partial = `${target}.${process.pid}.jpg`;
    const args = ['-v', 'error', '-y', ...seek, '-i', media.path, '-frames:v', '1', '-vf', filter, partial];
    await (nice ? exec('nice', ['-n', '19', 'ffmpeg', ...args]) : exec('ffmpeg', args));
    await fs.rename(partial, target);
    return target;
  } catch (error) {
    logger?.warn('Thumbnail failed', { mediaId: media.id, error: error.message });
    return null;
  }
}
