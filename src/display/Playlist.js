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
export const DISPLAY_STATUSES = ['kept', 'new'];

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

export const ORDERS = ['shuffle', 'random'];

// Whether a navigation command picks a random next item: --random or --no-random when given,
// otherwise display.order. The daemon's own advances always follow the shuffled playlist.
export function randomOrder(display, requested) {
  const order = display.order ?? 'random';
  if (!ORDERS.includes(order)) {
    throw new Error(`display.order must be ${ORDERS.join(' or ')}, not ${order}`);
  }
  return requested === undefined ? order === 'random' : Boolean(requested);
}

// Moves the entry pick(candidates, current) chooses among those for other files to just after the current
// one, so the next advance plays it and prev still returns here. Candidates are indexes in playlist order.
// Returns the moved entry, or null when there is nothing to pick.
async function queueEntry(client, pick) {
  const playlist = await client.getProperty('playlist');
  const current = playlist.findIndex(entry => entry.current);
  const currentFile = playlist[current]?.filename;
  const candidates = playlist.flatMap((entry, index) => (entry.filename === currentFile ? [] : [index]));
  const index = candidates.length ? pick(candidates, current, playlist) : undefined;
  if (index === undefined) return null;
  // mpv inserts the entry before index2 (or at the end when index2 is the count), so current + 1 is right after it
  await client.command('playlist-move', index, current + 1);
  return playlist[index];
}

export async function queueRandom(client, random = Math.random) {
  return queueEntry(client, candidates => candidates[Math.floor(random() * candidates.length)]);
}

// Queues an entry whose file is in paths: the first after the current one in playlist order, wrapping,
// or with random any of them
export async function queueMatching(client, paths, { random = false, rng = Math.random } = {}) {
  return queueEntry(client, (candidates, current, playlist) => {
    const matching = candidates.filter(index => paths.has(playlist[index].filename));
    if (random) return matching[Math.floor(rng() * matching.length)];
    return matching.find(index => index > current) ?? matching[0];
  });
}

// --loop-playlist replays one order on every pass, so the daemon reshuffles when playback wraps from the
// last entry to the first. Entries are compared by mpv's entry id rather than position, which removals,
// appends and random moves shift between loads. The playing entry goes back to the front so the new pass
// covers every entry. Returns the id of the entry now playing, for the next call.
export async function reshuffleOnWrap(client, previousEntryId) {
  const playlist = await client.getProperty('playlist');
  const position = playlist.findIndex(entry => entry.current);
  const entryId = playlist[position]?.id ?? null;
  // With two entries a reshuffle that keeps the playing one first changes nothing
  if (position !== 0 || playlist.length < 3 || previousEntryId === undefined || previousEntryId === null
    || playlist.at(-1).id !== previousEntryId) {
    return entryId;
  }
  await client.command('playlist-shuffle');
  const shuffled = (await client.getProperty('playlist')).findIndex(entry => entry.id === entryId);
  if (shuffled > 0) await client.command('playlist-move', shuffled, 0);
  return entryId;
}

// mpv brightness for a stored dim amount (0 rather than -0 when undimmed)
export function brightnessFor(dim) {
  return dim ? -dim : 0;
}

export function modeProperties(mode, imageDuration) {
  return mode === 'video'
    ? { 'loop-file': 'inf', end: 'none' }
    : { 'loop-file': 'no', end: 'none', 'image-display-duration': imageDuration };
}

export function validVideoDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`display.video_duration must be a number of seconds, 0 to loop forever, not ${value}`);
  }
  return value;
}

// mpv properties that end a video after about `timeout` seconds of wall time. Shorter videos loop
// as many whole times as fit, so they never stop mid-clip (loop-file N plays N + 1 times); longer
// ones stop at the timeout through `end`, which is in media time and so scales with speed.
// end is a global option in mpv, so every load sets it, including images, to clear the last value.
export function playbackLimits(media, timeout) {
  if (!media || !MODE_KINDS.video.includes(media.kind)) return { end: 'none' };
  const length = media.duration / (media.speed || 1);
  if (!timeout || !(length > 0)) return { 'loop-file': 'inf', end: 'none' };
  if (length > timeout) return { 'loop-file': 'no', end: String(Math.round(timeout * media.speed * 1000) / 1000) };
  const plays = Math.floor(timeout / length);
  return { 'loop-file': plays > 1 ? plays - 1 : 'no', end: 'none' };
}

// Replaces the monitor's mpv playlist with the media for the mode; returns how many items were loaded
export async function loadPlaylist(client, { database, config, mode, monitor, runtimeDir, random, lastMediaId }) {
  const { display } = config;
  const media = orderPlaylist(
    eligibleMedia(database, mode, monitor, { allowUpscale: display.allow_upscale }),
    lastMediaId ?? database.getSetting(lastMediaKey(mode, monitor.name)),
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

// Drops the entry an end-file error refers to, so a missing or unreadable file is not retried on every
// pass of the playlist. Returns { filename, remaining }, or null if the entry is already gone.
export async function removeFailedEntry(client, entryId) {
  const playlist = await client.getProperty('playlist');
  const index = playlist.findIndex(entry => entry.id === entryId);
  if (index === -1) return null;
  await client.command('playlist-remove', index);
  return { filename: playlist[index].filename, remaining: playlist.length - 1 };
}

// Adds newly added media to a running playlist without interrupting what is playing;
// append-play starts playback if the monitor was idle. Returns how many items were added.
export async function appendToPlaylist(client, { database, config, mode, monitor, mediaIds }) {
  const wanted = new Set(mediaIds);
  if (!wanted.size) return 0;
  const existing = new Set((await client.getProperty('playlist')).map(entry => entry.filename));
  const media = eligibleMedia(database, mode, monitor, { allowUpscale: config.display.allow_upscale })
    .filter(item => wanted.has(item.id) && !existing.has(item.path));

  for (const item of shuffle(media)) {
    await client.command('loadfile', item.path, 'append-play');
  }
  return media.length;
}
