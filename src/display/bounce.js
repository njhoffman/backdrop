import { reversedPath, reversedReady } from '../library/reverse.js';
import { SMOOTH_FPS, smoothedPath, smoothedReady, smoothedReversedPath, smoothedReversedReady, wantsSmoothing } from '../library/smooth.js';

// What mpv loads for a video: the file, or an EDL URL joining files into one timeline. A bouncing video plays to its
// end, backwards to its start and forwards again: its file and its reversed copy (src/library/reverse.js), so
// loop-file and the video duration limit work on the pair as on any file, at twice the length. A slowed video with a
// smoothed copy (src/library/smooth.js, display.smooth) plays that copy instead, alone or with its own reversed copy.
//
// mpv reports the URL as the entry's filename and path, so code that compares mpv's paths with the library's reads
// them through entryPath. A URL whose first file is not the library's carries the library path as a tag,
// edl://!global_tags,backdrop_path=%<bytes>%<path>;..., which mpv takes as metadata and ignores otherwise.

const BOUNCE_KINDS = ['video', 'gif'];
const EDL = 'edl://';
const TAG = '!global_tags,backdrop_path=';

// Whether an item bounces: its own setting, else display.video_loop
export function bounces(media, display) {
  if (!media || !BOUNCE_KINDS.includes(media.kind)) return false;
  return media.bounce ?? display?.video_loop === 'bounce';
}

function segment(file) {
  return `%${Buffer.byteLength(file)}%${file}`;
}

// The files as one timeline; with library, the item's own path rides along as a tag
export function bounceUrl(forward, backward, library = null) {
  const tag = library && library !== forward ? `${TAG}${segment(library)};` : '';
  return `${EDL}${tag}${[forward, backward].filter(Boolean).map(segment).join(';')}`;
}

export function isBounceUrl(filename) {
  return typeof filename === 'string' && filename.startsWith(EDL);
}

// A %<bytes>%<text> field at the start of rest: [text, what follows it], or null
function field(rest) {
  const match = /^%(\d+)%/.exec(rest);
  if (!match) return null;
  const bytes = Buffer.from(rest.slice(match[0].length));
  const text = bytes.subarray(0, Number(match[1])).toString();
  return [text, rest.slice(match[0].length + text.length)];
}

// The library path behind an mpv filename: the URL's tag, else its first file, else the filename itself
export function entryPath(filename) {
  if (!isBounceUrl(filename)) return filename;
  const rest = filename.slice(EDL.length);
  if (rest.startsWith(TAG)) return field(rest.slice(TAG.length))?.[0] ?? filename;
  return field(rest)?.[0] ?? filename;
}

// The first file mpv plays for a filename: a smoothed copy's path when the URL carries one
export function forwardPath(filename) {
  if (!isBounceUrl(filename)) return filename;
  let rest = filename.slice(EDL.length);
  if (rest.startsWith(TAG)) {
    const tag = field(rest.slice(TAG.length));
    if (!tag) return filename;
    rest = tag[1].replace(/^;/, '');
  }
  return field(rest)?.[0] ?? filename;
}

// Whether a filename plays a video and then its reversed copy: two files after the tag (a smoothed copy alone is one)
export function playsBounce(filename) {
  if (!isBounceUrl(filename)) return false;
  let rest = filename.slice(EDL.length);
  if (rest.startsWith(TAG)) rest = field(rest.slice(TAG.length))?.[1]?.replace(/^;/, '') ?? '';
  let count = 0;
  for (let next = field(rest); next; next = field(next[1].replace(/^;/, ''))) count++;
  return count >= 2;
}

// Whether mpv plays a smoothed copy for this filename rather than the library file
export function isSmoothedUrl(filename) {
  return isBounceUrl(filename) && forwardPath(filename) !== entryPath(filename);
}

// Whether display.smooth applies to the item and its copy for its speed is ready
export function smoothedFor(media, config) {
  const display = config?.display ?? {};
  return Boolean(display.smooth && wantsSmoothing(media, display.smooth_fps ?? SMOOTH_FPS) && smoothedReady(media, config.paths?.smooth));
}

// What mpv loads for an item: its smoothed copy when ready, and with bounce the reversed copy of what plays forward
// once that is ready too; the plain file otherwise
export function playUrl(media, config) {
  if (!config || !media?.path) return media?.path;
  const smooth = smoothedFor(media, config);
  const forward = smooth ? smoothedPath(media, config.paths.smooth) : media.path;
  let backward = null;
  if (bounces(media, config.display)) {
    if (smooth && smoothedReversedReady(media, config.paths.smooth)) backward = smoothedReversedPath(media, config.paths.smooth);
    else if (!smooth && reversedReady(media, config.paths?.bounce)) backward = reversedPath(media, config.paths.bounce);
  }
  if (forward === media.path && !backward) return media.path;
  return bounceUrl(forward, backward, media.path);
}

// Where an item's bounce stands: 'off' (it does not bounce), 'ready' (what mpv loads plays the reversed half) or
// 'reversing' (it bounces, but its reversed copy is still being made in the background)
export function bounceState(media, config) {
  if (!media || !bounces(media, config?.display)) return 'off';
  return playsBounce(playUrl(media, config)) ? 'ready' : 'reversing';
}
