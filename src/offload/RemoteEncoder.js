import { spawn as spawnProcess } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import { copyProblem, probeVideo } from '../library/reverse.js';
import { smoothedSizePath } from '../library/smooth.js';
import { HEARTBEAT_MS, PROTOCOL, checkJob, inputName } from './protocol.js';

// The daemon's side of `backdrop worker` (src/offload/worker.js) on the machines in offload.hosts: reversed and
// smoothed copies made there instead of here. A job rsyncs the source to the host, runs the worker over SSH with the
// job on stdin and a heartbeat after it, and rsyncs the copy back into place. Stopping the job (the signal) kills the
// SSH session, which closes the worker's stdin and stops it there; the heartbeat covers a session that dies without
// closing. The first host that answers `--hello` with this protocol is used until a job finds it gone; hosts are
// checked again every CHECK_MS.

export const CHECK_MS = 5 * 60 * 1000;
const HELLO_TIMEOUT_MS = 20_000;
// ssh's own exit status for a connection or authentication failure, as opposed to the remote command's
const SSH_FAILED = 255;

// The host cannot be reached or does not answer as a worker: the job goes back to the queue, to run here
export class OffloadUnavailable extends Error {}

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

// A word for a POSIX shell, quoted
export function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

// What ssh runs on the host for the worker: a login shell (so PATH has node, as the user's shell sets it), and with
// memoryMax a systemd scope that kills a job past that much memory instead of letting it swap the host to a halt
export function remoteCommand(workerCommand, { memoryMax = null, hello = false } = {}) {
  const command = `${workerCommand}${hello ? ' --hello' : ''}`;
  const inner = memoryMax && !hello ? `exec systemd-run --user --scope --quiet -p MemoryMax=${memoryMax} -- ${command}` : `exec ${command}`;
  return `bash -lc ${shellQuote(inner)}`;
}

// The job for an item: what the worker needs of it, no paths but the names checkJob allows
export function jobFor(kind, media, { size = null, target = null } = {}) {
  const ext = path.extname(media.path).toLowerCase() || '.mp4';
  const job = {
    kind, key: media.copyKey ?? media.sha256, ext, bytes: fs.statSync(media.path).size,
    media: { kind: media.kind, duration: media.duration, fps: media.fps ?? null, width: media.width ?? null, height: media.height ?? null, speed: media.speed ?? 1 }
  };
  if (kind === 'smooth') Object.assign(job, { size, target });
  return checkJob(job);
}

export class RemoteEncoder {
  constructor({ config, logger, spawn = spawnProcess, now = Date.now, ssh = 'ssh', rsync = 'rsync', probe = probeVideo }) {
    this.config = config;
    this.probe = probe;
    this.logger = logger;
    this.spawn = spawn;
    this.now = now;
    this.ssh = ssh;
    this.rsync = rsync;
    // The host jobs go to: { name, dir, smooth, version }, or null
    this.host = null;
    this.checkedAt = null;
    this.checking = null;
  }

  get settings() {
    return this.config.get().offload ?? {};
  }

  get hosts() {
    return this.settings.hosts ?? [];
  }

  // Whether reversals go to a host now, and smoothing (which needs RIFE there)
  get available() {
    return Boolean(this.host);
  }

  get canSmooth() {
    return Boolean(this.host?.smooth);
  }

  // For state.json: the host and whether it smooths, or null
  summary() {
    return this.host ? { host: this.host.name, smooth: this.host.smooth, version: this.host.version } : null;
  }

  // Runs file with args, resolving { code, stdout, stderr }; signal kills it
  exec(file, args, { signal, timeout = null } = {}) {
    return new Promise(resolve => {
      const child = this.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      const kill = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', kill, { once: true });
      const timer = timeout ? setTimeout(kill, timeout) : null;
      child.on('error', error => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message });
      });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  // Asks each host in turn and keeps the first that answers as a worker of this protocol; resolves to the host or null
  async check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const before = this.host?.name ?? null;
      let found = null;
      for (const name of this.hosts) {
        const result = await this.exec(this.ssh, [...SSH_OPTIONS, name, '--', remoteCommand(this.settings.worker_command ?? 'backdrop worker', { hello: true })], { timeout: HELLO_TIMEOUT_MS });
        let answer = null;
        try {
          answer = JSON.parse(result.stdout.trim().split('\n').at(-1));
        } catch {
          // Not a worker, or none at all
        }
        if (answer?.event === 'hello' && answer.protocol === PROTOCOL && typeof answer.dir === 'string' && answer.dir.startsWith('/')) {
          found = { name, dir: answer.dir, smooth: Boolean(answer.smooth), version: answer.version ?? null };
          break;
        }
        const why = answer?.event === 'hello' ? `it speaks protocol ${answer.protocol}, this daemon ${PROTOCOL}` : (result.stderr.trim().split('\n').at(-1) || `exit ${result.code}`);
        if (before === name || this.checkedAt === null) this.logger.info('Offload host not available', { host: name, reason: why });
      }
      this.host = found;
      this.checkedAt = this.now();
      if ((found?.name ?? null) !== before) {
        if (found) this.logger.info('Encoding on another machine', { host: found.name, smooth: found.smooth, version: found.version });
        else if (before) this.logger.info('Encoding here again: no offload host answers', { was: before });
      }
      return found;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  // A job found the host gone: here until the next check finds one
  lost(host, reason) {
    if (this.host?.name !== host.name) return;
    this.logger.warn('Offload host lost, encoding here until it answers again', { host: host.name, reason });
    this.host = null;
  }

  // The reversed copy of media (or of a smoothed copy, with copyKey) made on the host and placed at target; resolves
  // to target, or null when the host could not make it. Throws OffloadUnavailable when the host is gone.
  reverse(media, target, { signal } = {}) {
    return this.run(jobFor('reverse', media), media, target, { signal });
  }

  // The smoothed copy at size, placed at target with its size recorded beside it
  async smooth(media, target, { size, fps, signal } = {}) {
    const made = await this.run(jobFor('smooth', media, { size, target: fps }), media, target, { signal });
    if (made) await fs.writeJson(smoothedSizePath(media, path.dirname(target)), { width: size.width, height: size.height });
    return made;
  }

  async run(job, media, target, { signal } = {}) {
    const host = this.host;
    if (!host) throw new OffloadUnavailable('no offload host');
    await fs.ensureDir(path.dirname(target));
    const remote = (folder, name) => `${host.name}:${path.posix.join(host.dir, folder, name)}`;
    const rsync = [this.rsync, ['--times', '--partial', '--mkpath', '--protect-args', '-e', `${this.ssh} ${SSH_OPTIONS.join(' ')}`]];
    const started = this.now();

    const upload = await this.exec(rsync[0], [...rsync[1], '--', media.path, remote('in', inputName(job))], { signal });
    if (signal?.aborted) return null;
    if (upload.code !== 0) {
      this.lost(host, `upload failed: ${upload.stderr.trim().split('\n').at(-1) || `exit ${upload.code}`}`);
      throw new OffloadUnavailable(`upload to ${host.name} failed`);
    }

    const outcome = await this.work(host, job, { signal });
    if (signal?.aborted) return null;
    if (outcome.unavailable) {
      this.lost(host, outcome.error);
      throw new OffloadUnavailable(outcome.error);
    }
    if (!outcome.file) {
      this.logger.warn('Offload job failed', { host: host.name, kind: job.kind, mediaId: media.id, code: outcome.code, error: outcome.error });
      return null;
    }

    // Fetched beside the copy under a temporary name (cleared by the queues' removeStale* on start), then renamed
    const partial = `${target}.remote.tmp`;
    const download = await this.exec(rsync[0], [...rsync[1], '--remove-source-files', '--', remote('out', outcome.file), partial], { signal });
    if (signal?.aborted || download.code !== 0) {
      await fs.remove(partial).catch(() => {});
      if (!signal?.aborted) this.logger.warn('Offload copy could not be fetched', { host: host.name, file: outcome.file, error: download.stderr.trim().split('\n').at(-1) });
      return null;
    }
    // A host on an older version does not check what it makes, so a copy is probed here before it replaces anything
    let problem;
    try {
      problem = copyProblem(await this.probe(partial));
    } catch (error) {
      problem = error.message.split('\n')[0];
    }
    if (problem) {
      await fs.remove(partial).catch(() => {});
      this.logger.warn('Offload copy cannot be played', { host: host.name, kind: job.kind, mediaId: media.id, problem });
      return null;
    }
    await fs.rename(partial, target);
    this.logger.info(job.kind === 'reverse' ? 'Reversed video on another machine' : 'Smoothed video on another machine', {
      host: host.name, mediaId: media.id, seconds: Math.round((this.now() - started) / 100) / 10
    });
    return target;
  }

  // Runs the worker for job: { file } when it made the copy, { code, error } when it could not, { unavailable, error }
  // when the host did not run it at all
  work(host, job, { signal } = {}) {
    const { worker_command: command = 'backdrop worker', memory_max: memoryMax = null } = this.settings;
    return new Promise(resolve => {
      const child = this.spawn(this.ssh, [...SSH_OPTIONS, host.name, '--', remoteCommand(command, { memoryMax })], { stdio: ['pipe', 'pipe', 'pipe'] });
      let result = null;
      let started = false;
      let stderr = '';
      const write = line => {
        if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(line)}\n`);
      };
      write({ protocol: PROTOCOL, job });
      const beat = setInterval(() => write({ ping: true }), HEARTBEAT_MS);
      const stop = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', stop, { once: true });
      child.stdin?.on('error', () => {});
      child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
      const lines = child.stdout ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
      lines?.on('line', line => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.event === 'started') started = true;
        else if (event.event === 'waiting') this.logger.info('Offload host busy, the job waits there', { host: host.name, holder: event.holder });
        else if (event.event === 'done' && typeof event.file === 'string' && /^[\w@.-]+$/.test(event.file)) result = { file: event.file };
        else if (event.event === 'failed') result = { code: event.code, error: event.error };
        // The job is over: no more heartbeats, and the closed stdin lets the worker exit
        if (result) {
          clearInterval(beat);
          child.stdin?.end();
        }
      });
      const finish = code => {
        clearInterval(beat);
        signal?.removeEventListener('abort', stop);
        lines?.close();
        if (result) return resolve(result);
        const last = stderr.trim().split('\n').at(-1) || `exit ${code}`;
        // Nothing answered: the connection, or the worker itself, never ran
        if (!started && (code === SSH_FAILED || code === 127 || code === -1)) return resolve({ unavailable: true, error: last });
        resolve({ code: 'exit', error: last });
      };
      child.on('error', error => finish(-1, error));
      child.on('close', code => finish(code ?? -1));
    });
  }
}
