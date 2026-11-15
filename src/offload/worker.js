import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { defaultEncoders, reverseVideo } from '../library/reverse.js';
import { RifeTimeoutError, smoothVideo, smoothedSizePath } from '../library/smooth.js';
import { FileLock } from '../utils/fileLock.js';
import { HEARTBEAT_TIMEOUT_MS, PROTOCOL, checkJob, inputName } from './protocol.js';

// `backdrop worker`: one encode for a daemon on another machine (src/offload/RemoteEncoder.js). The job comes as the
// first JSON line on input, the source already in <paths.worker>/in (rsynced there by the client); the copy is made
// in <paths.worker>/out, which keeps a stopped job's chunks so the next attempt resumes them. Events go to output as
// JSON lines: waiting (another job holds the worker), started, done { file } or failed { code, error }.
//
// The job stops when input closes or no line arrives for heartbeatMs: a client that went away must never leave an
// encode running here (an endless one filled minerva's memory on 2026-11-15). Jobs run one at a time across
// processes (worker.lock), and the client runs this under a MemoryMax scope.

// Leftovers of clients that never came back for their copy, or never sent the job, go after this long
const STALE_MS = 24 * 60 * 60 * 1000;

export function workerDirs(config) {
  const dir = config.paths.worker;
  return { dir, input: path.join(dir, 'in'), output: path.join(dir, 'out') };
}

// What `backdrop worker --hello` answers: whether the client may send jobs, and which kinds this machine can do
export function hello(config, { version, exists = fs.existsSync, encoders = defaultEncoders() } = {}) {
  const { display } = config;
  return {
    event: 'hello', protocol: PROTOCOL, version, dir: config.paths.worker, encoders,
    // smooth_rife is a command name or a path; the job fails if it cannot run, so a name is taken on trust
    smooth: Boolean(display.smooth_rife) && (!display.smooth_rife.includes('/') || exists(display.smooth_rife))
  };
}

// Files and work folders in the worker's folders untouched for STALE_MS, but for keep (the job's own input)
export async function removeStale(dirs, { now = Date.now(), keep = null } = {}) {
  for (const folder of [dirs.input, dirs.output]) {
    for (const name of await fs.readdir(folder).catch(() => [])) {
      const file = path.join(folder, name);
      if (file === keep) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > STALE_MS) await fs.remove(file).catch(() => {});
    }
  }
}

// Runs one job; resolves to the exit code. reverse and smooth are reverseVideo and smoothVideo, swapped in tests.
export async function runWorker({
  config, input = process.stdin, output = process.stdout, logger,
  reverse = reverseVideo, smooth = smoothVideo, encoders = defaultEncoders(), heartbeatMs = HEARTBEAT_TIMEOUT_MS,
  lock: makeLock = file => new FileLock(file)
}) {
  const send = event => output.write(`${JSON.stringify(event)}\n`);
  const fail = (code, error) => {
    send({ event: 'failed', code, error });
    return 1;
  };
  const controller = new AbortController();
  const { signal } = controller;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let timer = null;
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      logger?.warn('Worker heard nothing from its client, stopping the job');
      controller.abort();
    }, heartbeatMs);
  };
  let first = null;
  let firstSeen;
  const firstLine = new Promise(resolve => { firstSeen = resolve; });
  lines.on('line', line => {
    heard();
    if (first === null) {
      first = line;
      firstSeen(line);
    }
  });
  lines.on('close', () => {
    controller.abort();
    firstSeen(first);
  });
  heard();

  const dirs = workerDirs(config);
  let lock = null;
  try {
    const line = await firstLine;
    if (line === null) return 1;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return fail('invalid', 'the first line is not JSON');
    }
    if (request?.protocol !== PROTOCOL) return fail('protocol', `the worker speaks protocol ${PROTOCOL}, the client ${request?.protocol}`);
    let job;
    try {
      job = checkJob(request.job);
    } catch (error) {
      return fail('invalid', error.message);
    }
    const source = path.join(dirs.input, inputName(job));
    const stat = await fs.stat(source).catch(() => null);
    if (!stat || stat.size !== job.bytes) return fail('input', `${inputName(job)} is not in ${dirs.input} at ${job.bytes} bytes`);
    await fs.ensureDir(dirs.output);

    lock = makeLock(path.join(dirs.dir, 'worker.lock'));
    let told = false;
    const got = await lock.acquire({
      shouldStop: () => signal.aborted,
      onWait: holder => {
        if (!told) send({ event: 'waiting', holder: holder?.pid ?? null });
        told = true;
      }
    });
    if (!got || signal.aborted) return 1;
    await removeStale(dirs, { keep: source });
    send({ event: 'started' });

    const sha256 = job.key.slice(0, 64);
    const media = { id: null, sha256, copyKey: job.key, path: source, ...job.media };
    let made;
    try {
      if (job.kind === 'reverse') {
        made = await reverse(media, dirs.output, { logger, signal, encoders });
      } else {
        const { display } = config;
        if (!display.smooth_rife) return fail('unsupported', 'display.smooth_rife is not set on the worker');
        made = await smooth(media, dirs.output, {
          rife: display.smooth_rife, size: job.size, target: job.target, gpu: display.smooth_gpu, logger, signal, encoders
        });
      }
    } catch (error) {
      if (signal.aborted) return 1;
      await fs.remove(source).catch(() => {});
      return fail(error instanceof RifeTimeoutError ? 'rife-timeout' : 'encode', error.message.split('\n')[0]);
    }
    // Stopped: the input and the kept chunks stay for the next attempt, and nobody is listening
    if (signal.aborted) return 1;
    await fs.remove(source).catch(() => {});
    if (!made) return fail('encode', 'no copy was made (see the worker\'s log)');
    // The client records the size itself
    if (job.kind === 'smooth') await fs.remove(smoothedSizePath(media, dirs.output)).catch(() => {});
    send({ event: 'done', file: path.basename(made) });
    return 0;
  } finally {
    clearTimeout(timer);
    lines.close();
    lock?.release();
  }
}
