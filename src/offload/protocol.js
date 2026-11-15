// What `backdrop worker` (src/offload/worker.js) and the daemon's RemoteEncoder (src/offload/RemoteEncoder.js) agree
// on. The worker runs on another machine over SSH: `backdrop worker --hello` answers what it can do, and
// `backdrop worker` takes one job as a JSON line on stdin, then heartbeat lines, and answers with JSON event lines
// on stdout. Files travel by rsync beside it: the source into <dir>/in, the copy back from <dir>/out.

// Bumped whenever a job or an event changes shape; a client and worker that differ refuse each other
export const PROTOCOL = 1;

export const JOB_KINDS = ['reverse', 'smooth'];

// The client sends a heartbeat this often while a job runs; a worker that hears none for HEARTBEAT_TIMEOUT_MS (the
// client gone without closing the connection, a dropped network) stops its job, so nothing runs on unattended
export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;

// A copy's key (copyKey in src/library/reverse.js): a sha256, or a smoothed copy's reversal "<sha256>@<speed>.reversed"
const KEY = /^[0-9a-f]{64}(@\d+(\.\d+)?\.reversed)?$/;
const EXTENSION = /^\.[a-z0-9]{1,5}$/;

class InvalidJob extends Error {}

const number = (value, name, { min = 0, exclusive = true } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (exclusive ? value <= min : value < min)) {
    throw new InvalidJob(`${name} must be a number above ${min}`);
  }
  return value;
};

// Checks a job from the wire and returns it in the worker's shape, or throws with what is wrong. Names that reach
// the file system are checked against strict patterns, so a job can only name files in the worker's own folders.
//   { kind, key, ext, bytes, media: { kind, duration, fps, width, height, speed }, size?, target? }
export function checkJob(job) {
  if (!job || typeof job !== 'object') throw new InvalidJob('no job');
  if (!JOB_KINDS.includes(job.kind)) throw new InvalidJob(`kind must be one of ${JOB_KINDS.join(', ')}`);
  if (typeof job.key !== 'string' || !KEY.test(job.key)) throw new InvalidJob('key must be a sha256, or <sha256>@<speed>.reversed');
  if (typeof job.ext !== 'string' || !EXTENSION.test(job.ext)) throw new InvalidJob('ext must be a short file extension such as .mp4');
  if (!Number.isInteger(job.bytes) || job.bytes <= 0) throw new InvalidJob('bytes must be the source file\'s size');
  const media = job.media ?? {};
  if (!['video', 'gif'].includes(media.kind)) throw new InvalidJob('media.kind must be video or gif');
  const checked = {
    kind: job.kind, key: job.key, ext: job.ext, bytes: job.bytes,
    media: {
      kind: media.kind,
      duration: number(media.duration, 'media.duration'),
      fps: media.fps == null ? null : number(media.fps, 'media.fps'),
      width: media.width == null ? null : number(media.width, 'media.width'),
      height: media.height == null ? null : number(media.height, 'media.height'),
      speed: number(media.speed ?? 1, 'media.speed')
    }
  };
  if (job.kind === 'smooth') {
    if (job.key.includes('@')) throw new InvalidJob('a smooth job\'s key is the video\'s sha256');
    if (!checked.media.fps) throw new InvalidJob('a smooth job needs media.fps');
    const size = job.size ?? {};
    checked.size = { width: number(size.width, 'size.width'), height: number(size.height, 'size.height') };
    checked.target = number(job.target, 'target');
  }
  return checked;
}

// The source's file name in <dir>/in
export function inputName(job) {
  return `${job.key}${job.ext}`;
}
