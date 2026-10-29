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
export async function thumbnailFor(media, dir, { exec = run, logger } = {}) {
  if (!media?.path) return null;
  const target = path.join(dir, `${media.id}.jpg`);
  try {
    const [source, existing] = await Promise.all([fs.stat(media.path), fs.stat(target).catch(() => null)]);
    if (existing && existing.mtimeMs >= source.mtimeMs) return target;
    await fs.ensureDir(dir);
    const seek = media.kind === 'image' ? [] : ['-ss', String(Math.min(1, (media.duration || 2) / 2))];
    const partial = `${target}.${process.pid}.jpg`;
    await exec('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', media.path, '-frames:v', '1', '-vf', COVER, partial]);
    await fs.rename(partial, target);
    return target;
  } catch (error) {
    logger?.warn('Thumbnail failed', { mediaId: media.id, error: error.message });
    return null;
  }
}
