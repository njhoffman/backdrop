import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { PROTOCOL, checkJob } from '../../src/offload/protocol.js';
import { hello, removeStale, runWorker, workerDirs } from '../../src/offload/worker.js';
import { RifeTimeoutError } from '../../src/library/smooth.js';
import { fakeSha, makeConfig, silentLogger } from '../helpers/fakes.js';

const KEY = fakeSha(7);
const job = (overrides = {}) => ({
  kind: 'reverse', key: KEY, ext: '.mp4', bytes: 5,
  media: { kind: 'video', duration: 10, fps: 30, width: 1920, height: 1080, speed: 1 }, ...overrides
});

describe('backdrop worker', () => {
  let dir, config, input, output, events;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-worker-'));
    config = makeConfig({ 'paths.worker': path.join(dir, 'worker') });
    input = new PassThrough();
    output = new PassThrough();
    events = [];
    output.on('data', chunk => String(chunk).trim().split('\n').forEach(line => events.push(JSON.parse(line))));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  const source = () => path.join(workerDirs(config.get()).input, `${KEY}.mp4`);
  const putSource = (text = 'video') => fs.outputFile(source(), text);
  const send = line => input.write(`${JSON.stringify(line)}\n`);
  const start = options => runWorker({ config: config.get(), input, output, logger: silentLogger, encoders: ['x264'], ...options });

  it('makes a reversed copy in its out folder, says which file, and drops the source', async () => {
    await putSource();
    let given;
    const done = start({
      reverse: async (media, out, options) => {
        given = { media, out, encoders: options.encoders };
        const file = path.join(out, `${media.copyKey}.mp4`);
        await fs.outputFile(file, 'reversed');
        return file;
      }
    });
    send({ protocol: PROTOCOL, job: job() });
    expect(await done).to.equal(0);
    expect(events.map(event => event.event)).to.deep.equal(['started', 'done']);
    expect(events[1].file).to.equal(`${KEY}.mp4`);
    expect(given.media).to.include({ sha256: KEY, copyKey: KEY, path: source(), duration: 10 });
    expect(given.out).to.equal(workerDirs(config.get()).output);
    expect(given.encoders).to.deep.equal(['x264']);
    expect(await fs.pathExists(source())).to.equal(false);
    input.end();
  });

  it('smooths with its own RIFE settings at the size asked for, leaving no size record for the client', async () => {
    config.set('display.smooth_rife', '/opt/rife/rife-ncnn-vulkan');
    config.set('display.smooth_gpu', 0);
    await putSource();
    let given;
    const done = start({
      smooth: async (media, out, options) => {
        given = options;
        const file = path.join(out, `${media.sha256}@0.5.mp4`);
        await fs.outputFile(file, 'smoothed');
        await fs.writeJson(path.join(out, `${media.sha256}@0.5.json`), options.size);
        return file;
      }
    });
    send({ protocol: PROTOCOL, job: job({ kind: 'smooth', size: { width: 1280, height: 720 }, target: 30, media: { ...job().media, speed: 0.5 } }) });
    expect(await done).to.equal(0);
    expect(given).to.include({ rife: '/opt/rife/rife-ncnn-vulkan', gpu: 0, target: 30 });
    expect(given.size).to.deep.equal({ width: 1280, height: 720 });
    expect(await fs.readdir(workerDirs(config.get()).output)).to.deep.equal([`${KEY}@0.5.mp4`]);
    input.end();
  });

  it('stops the job when its client goes away, keeping the source and chunks for the next attempt', async () => {
    await putSource();
    let aborted = false;
    const done = start({
      reverse: (media, out, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => {
        aborted = true;
        resolve(null);
      }))
    });
    send({ protocol: PROTOCOL, job: job() });
    for (let i = 0; i < 50 && !events.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    input.end();
    expect(await done).to.equal(1);
    expect(aborted).to.equal(true);
    expect(events.map(event => event.event)).to.deep.equal(['started']);
    expect(await fs.pathExists(source())).to.equal(true);
  });

  it('stops the job when no heartbeat comes, and goes on while they do', async () => {
    await putSource();
    let aborted = false;
    let beats = 0;
    const beat = setInterval(() => {
      if (beats++ < 4) send({ ping: true });
    }, 20);
    const started = Date.now();
    const done = start({
      heartbeatMs: 60,
      reverse: (media, out, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => {
        aborted = true;
        resolve(null);
      }))
    });
    send({ protocol: PROTOCOL, job: job() });
    expect(await done).to.equal(1);
    clearInterval(beat);
    expect(aborted).to.equal(true);
    // Four beats 20 ms apart kept it going past one timeout
    expect(Date.now() - started).to.be.at.least(100);
    input.end();
  });

  it('refuses another protocol, a bad job and a source that is missing or of another size', async () => {
    const results = [];
    for (const [line, setup] of [
      [{ protocol: PROTOCOL + 1, job: job() }, null],
      [{ protocol: PROTOCOL, job: job({ key: '../../etc/passwd' }) }, null],
      [{ protocol: PROTOCOL, job: job() }, null],
      [{ protocol: PROTOCOL, job: job({ bytes: 99 }) }, () => putSource()]
    ]) {
      input = new PassThrough();
      if (setup) await setup();
      events = [];
      const done = start({ reverse: async () => { throw new Error('not reached'); } });
      send(line);
      results.push([await done, events.at(-1).code]);
      input.end();
    }
    expect(results).to.deep.equal([[1, 'protocol'], [1, 'invalid'], [1, 'input'], [1, 'input']]);
  });

  it('reports a failed encode and a RIFE time-out by code, dropping the source', async () => {
    config.set('display.smooth_rife', 'rife-ncnn-vulkan');
    await putSource();
    const done = start({ smooth: async () => { throw new RifeTimeoutError(60); } });
    send({ protocol: PROTOCOL, job: job({ kind: 'smooth', size: { width: 1280, height: 720 }, target: 30, media: { ...job().media, speed: 0.5 } }) });
    expect(await done).to.equal(1);
    expect(events.at(-1)).to.include({ event: 'failed', code: 'rife-timeout' });
    expect(await fs.pathExists(source())).to.equal(false);
    input.end();
  });

  it('waits its turn while another job holds the worker, saying so once', async () => {
    await putSource();
    let tries = 0;
    const lock = () => ({
      acquire: async ({ onWait }) => {
        onWait({ pid: 42 });
        onWait({ pid: 42 });
        tries++;
        return true;
      },
      release() {}
    });
    const done = start({ lock, reverse: async () => null });
    send({ protocol: PROTOCOL, job: job() });
    await done;
    expect(tries).to.equal(1);
    expect(events.filter(event => event.event === 'waiting')).to.deep.equal([{ event: 'waiting', holder: 42 }]);
    input.end();
  });

  it('answers hello with its protocol, folder and whether it can smooth', () => {
    const answer = hello(config.get(), { version: '2.88.0', encoders: ['x264'], exists: () => false });
    expect(answer).to.include({ event: 'hello', protocol: PROTOCOL, version: '2.88.0', dir: path.join(dir, 'worker'), smooth: true });
    config.set('display.smooth_rife', '/missing/rife');
    expect(hello(config.get(), { exists: () => false }).smooth).to.equal(false);
  });

  it('clears leftovers a day old, but the job\'s own source', async () => {
    const dirs = workerDirs(config.get());
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const file of [path.join(dirs.input, 'a.mp4'), path.join(dirs.output, 'b.reverse.work', 'c00000.mp4'), source()]) {
      await fs.outputFile(file, 'x');
    }
    await fs.utimes(path.join(dirs.input, 'a.mp4'), old, old);
    await fs.utimes(path.join(dirs.output, 'b.reverse.work'), old, old);
    await fs.utimes(source(), old, old);
    await fs.outputFile(path.join(dirs.output, 'fresh.mp4'), 'x');
    await removeStale(dirs, { keep: source() });
    expect(await fs.readdir(dirs.input)).to.deep.equal([`${KEY}.mp4`]);
    expect(await fs.readdir(dirs.output)).to.deep.equal(['fresh.mp4']);
  });

  it('checks jobs strictly', () => {
    expect(checkJob(job()).key).to.equal(KEY);
    expect(checkJob(job({ key: `${KEY}@0.5.reversed` })).key).to.equal(`${KEY}@0.5.reversed`);
    for (const bad of [{ kind: 'upscale' }, { ext: '.mp4/../x' }, { bytes: 0 }, { media: { kind: 'image', duration: 1 } },
      { kind: 'smooth', key: `${KEY}@0.5.reversed`, size: { width: 2, height: 2 }, target: 30 }, { kind: 'smooth', target: 30 }]) {
      expect(() => checkJob(job(bad)), JSON.stringify(bad)).to.throw();
    }
  });
});
