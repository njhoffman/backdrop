import { reversedPath, reversedReady } from '../library/reverse.js';

// A bouncing video plays to its end, backwards to its start and forwards again. mpv plays the video and its
// reversed copy (src/library/reverse.js) as one file through an EDL URL, edl://%<bytes>%<path>;%<bytes>%<path>,
// so loop-file and the video duration limit work on the pair as on any file, at twice the length.
// mpv reports that URL as the entry's filename and path, so code that compares mpv's paths with the
// library's reads them through entryPath.

const BOUNCE_KINDS = ['video', 'gif'];
const EDL = 'edl://';

// Whether an item bounces: its own setting, else display.video_loop
export function bounces(media, display) {
  if (!media || !BOUNCE_KINDS.includes(media.kind)) return false;
  return media.bounce ?? display?.video_loop === 'bounce';
}

function segment(file) {
  return `%${Buffer.byteLength(file)}%${file}`;
}

export function bounceUrl(forward, backward) {
  return `${EDL}${segment(forward)};${segment(backward)}`;
}

export function isBounceUrl(filename) {
  return typeof filename === 'string' && filename.startsWith(EDL);
}

// The library path behind an mpv filename: the first segment of a bounce URL, else the filename itself
export function entryPath(filename) {
  if (!isBounceUrl(filename)) return filename;
  const match = /^edl:\/\/%(\d+)%/.exec(filename);
  if (!match) return filename;
  return Buffer.from(filename.slice(match[0].length)).subarray(0, Number(match[1])).toString();
}

// What mpv loads for an item: the bounce URL once its reversed copy is ready, else the file
export function playUrl(media, config) {
  if (!config || !bounces(media, config.display) || !reversedReady(media, config.paths?.bounce)) return media.path;
  return bounceUrl(media.path, reversedPath(media, config.paths.bounce));
}
