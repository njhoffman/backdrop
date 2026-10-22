import fs from 'fs-extra';
import path from 'path';

// GIFs are animated, so they play in video mode
export const MODE_KINDS = {
  video: ['video', 'gif'],
  image: ['image']
};
export const MODES = Object.keys(MODE_KINDS);
export const DEFAULT_MODE = 'video';

// New items are shown so they can be rated from the wallpaper; skipped ones never are
const DISPLAY_STATUSES = ['kept', 'new'];

// Remembered per mode, so toggling back resumes what that mode was showing
export function lastMediaKey(mode, monitorName) {
  return `last_media:${mode}:${monitorName}`;
}

export function modeOfKind(kind) {
  return MODES.find(mode => MODE_KINDS[mode].includes(kind));
}

export function getMode(database) {
  const mode = database.getSetting('mode', DEFAULT_MODE);
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

export function setMode(database, mode) {
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown mode: ${mode} (expected ${MODES.join(' or ')})`);
  }
  database.setSetting('mode', mode);
}

export function otherMode(mode) {
  return mode === 'video' ? 'image' : 'video';
}

// Media that fits the mode and is at least as large as the monitor, unless upscaling is allowed
export function eligibleMedia(database, mode, monitor, { allowUpscale = false } = {}) {
  const filters = { kind: MODE_KINDS[mode], status: DISPLAY_STATUSES, downloaded: true };
  if (!allowUpscale) {
    filters.minWidth = monitor.width;
    filters.minHeight = monitor.height;
  }
  return database.findMedia(filters);
}

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Shuffled order with the last item shown on this monitor first, so a restart resumes it
export function orderPlaylist(media, lastMediaId, random = Math.random) {
  const shuffled = shuffle(media, random);
  const lastIndex = shuffled.findIndex(item => item.id === lastMediaId);
  if (lastIndex > 0) {
    shuffled.unshift(...shuffled.splice(lastIndex, 1));
  }
  return shuffled;
}

export function modeProperties(mode, imageDuration) {
  return mode === 'video'
    ? { 'loop-file': 'inf' }
    : { 'loop-file': 'no', 'image-display-duration': imageDuration };
}

// Replaces the monitor's mpv playlist with the media for the mode; returns how many items were loaded
export async function loadPlaylist(client, { database, config, mode, monitor, runtimeDir, random }) {
  const { display } = config;
  const media = orderPlaylist(
    eligibleMedia(database, mode, monitor, { allowUpscale: display.allow_upscale }),
    database.getSetting(lastMediaKey(mode, monitor.name)),
    random
  );

  for (const [name, value] of Object.entries(modeProperties(mode, display.image_duration))) {
    await client.setProperty(name, value);
  }

  if (!media.length) {
    await client.command('playlist-clear');
    await client.command('stop');
    return 0;
  }

  const playlistPath = path.join(runtimeDir, `${monitor.name}.m3u`);
  await fs.writeFile(playlistPath, `${media.map(item => item.path).join('\n')}\n`);
  await client.command('loadlist', playlistPath, 'replace');
  return media.length;
}
