import { expect } from 'chai';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { PROTOCOL } from '../../src/offload/protocol.js';
import { OffloadUnavailable, RemoteEncoder, remoteCommand, shellQuote } from '../../src/offload/RemoteEncoder.js';
import { fakeSha, makeConfig, silentLogger } from '../helpers/fakes.js';

// A child process whose behavior a test scripts: respond(child, file, args) writes output and ends it with a code
function fakeSpawn(respond) {
  const calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = null;
    child.lines = [];
    child.stdin.on('data', chunk => child.lines.push(...String(chunk).trim().split('\n').map(line => JSON.parse(line))));
    child.exit = code => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    };
    child.kill = signal => {
      child.killed = signal;
      child.exit(null);
    };
    calls.push({ file, args, child });
    setImmediate(() => respond(child, file, args));
    return child;
  };
  return { spawn, calls };
}

const answer = (child, event) => child.stdout.write(`${JSON.stringify(event)}\n`);

// Every fetched copy plays unless a test says otherwise
const playable = async () => ({ codec: 'h264', pixFmt: 'yuv420p', frames: 10 });

describe('RemoteEncoder', () => {
  let dir, config, media, logs;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-remote-'));
    config = makeConfig({ 'offload.hosts': ['gone', 'minerva'], 'offload.memory_max': '3G' });
    const file = path.join(dir, 'media', 'clip.mp4');
    await fs.outputFile(file, 'video');
    media = { id: 7, sha256: fakeSha(7), kind: 'video', path: file, duration: 10, fps: 30, width: 1920, height: 1080, speed: 1 };
    logs = [];
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  const logger = { ...silentLogger, info: (message, meta) => logs.push(['info', message, meta]), warn: (message, meta) => logs.push(['warn', message, meta]) };
  // ssh answers hello on minerva only; rsync copies; the worker does what job() says
  const host = ({ job = child => answer(child, { event: 'done', file: `${fakeSha(7)}.mp4` }), upload = 0 } = {}) => fakeSpawn(async (child, file, args) => {
    if (file === 'ssh') {
      const name = args[args.indexOf('--') - 1];
      if (name === 'gone') {
        child.stderr.write('ssh: connect to host gone port 22: No route to host\n');
        return child.exit(255);
      }
      if (args.at(-1).includes('--hello')) {
        answer(child, { event: 'hello', protocol: PROTOCOL, dir: '/home/n/.cache/backdrop/worker', smooth: true, version: '2.88.0' });
        return child.exit(0);
      }
      await new Promise(resolve => setImmediate(resolve));
      answer(child, { event: 'started' });
      const code = await job(child);
      if (code !== 'hang') child.exit(code ?? 0);
      return;
    }
    // rsync: the download writes its destination
    if (args.includes('--remove-source-files')) await fs.outputFile(args.at(-1), 'reversed');
    child.exit(args.includes('--remove-source-files') ? 0 : upload);
  });

  it('uses the first host that answers as a worker of this protocol', async () => {
    const { spawn, calls } = host();
    const remote = new RemoteEncoder({ config, logger, probe: playable, spawn });
    expect(remote.available).to.equal(false);
    const found = await remote.check();
    expect(found).to.deep.equal({ name: 'minerva', dir: '/home/n/.cache/backdrop/worker', smooth: true, version: '2.88.0' });
    expect(remote.canSmooth).to.equal(true);
    expect(calls.map(call => call.args[call.args.indexOf('--') - 1])).to.deep.equal(['gone', 'minerva']);
    expect(calls[0].args).to.include.members(['BatchMode=yes', 'ServerAliveInterval=15']);
    expect(logs.find(([, message]) => message === 'Encoding on another machine')[2]).to.include({ host: 'minerva' });
    // With no hosts, nothing is asked and nothing is used
    config.set('offload.hosts', []);
    expect(await remote.check()).to.equal(null);
    expect(calls).to.have.length(2);
    expect(remote.available).to.equal(false);
  });

  it('warns once when a host runs another backdrop version, and reports it in the summary', async () => {
    const { spawn } = host();
    const remote = new RemoteEncoder({ config, logger, probe: playable, spawn, version: '2.94.3' });
    await remote.check();
    await remote.check();
    const warned = logs.filter(([level, message]) => level === 'warn' && message.startsWith('Offload host runs another backdrop version'));
    expect(warned).to.have.length(1);
    expect(warned[0][2]).to.deep.equal({ host: 'minerva', version: '2.88.0', here: '2.94.3' });
    expect(remote.summary()).to.include({ host: 'minerva', version: '2.88.0', stale: true });
    // The same version: no warning, not stale
    const same = new RemoteEncoder({ config, logger, probe: playable, spawn, version: '2.88.0' });
    logs.length = 0;
    await same.check();
    expect(logs.filter(([level]) => level === 'warn')).to.deep.equal([]);
    expect(same.summary().stale).to.equal(false);
  });

  it('turns down a host of another protocol', async () => {
    const { spawn } = fakeSpawn((child) => {
      answer(child, { event: 'hello', protocol: PROTOCOL + 1, dir: '/w' });
      child.exit(0);
    });
    config.set('offload.hosts', ['minerva']);
    const remote = new RemoteEncoder({ config, logger, probe: playable, spawn });
    expect(await remote.check()).to.equal(null);
    expect(logs[0][2].reason).to.include(`protocol ${PROTOCOL + 1}`);
  });

  it('uploads the source, runs the worker in a memory-limited scope with heartbeats, and fetches the copy into place', async () => {
    const { spawn, calls } = host();
    const remote = new RemoteEncoder({ config, logger, probe: playable, spawn });
    await remote.check();
    const target = path.join(dir, 'bounce', `${media.sha256}.mp4`);
    expect(await remote.reverse(media, target)).to.equal(target);
    expect(await fs.readFile(target, 'utf8')).to.equal('reversed');
    const [upload, work, download] = calls.slice(2);
    expect(upload.file).to.equal('rsync');
    expect(upload.args.slice(-2)).to.deep.equal([media.path, `minerva:/home/n/.cache/backdrop/worker/in/${media.sha256}.mp4`]);
    expect(upload.args).to.include.members(['--mkpath', '--protect-args', '--partial']);
    expect(work.args.at(-1)).to.equal(remoteCommand('backdrop worker', { memoryMax: '3G' }));
    expect(work.args.at(-1)).to.include('MemoryMax=3G');
    expect(work.child.lines[0]).to.deep.include({ protocol: PROTOCOL });
    expect(work.child.lines[0].job).to.include({ kind: 'reverse', key: media.sha256, ext: '.mp4', bytes: 5 });
    expect(download.args).to.include('--remove-source-files');
    expect(download.args.slice(-2)).to.deep.equal([`minerva:/home/n/.cache/backdrop/worker/out/${media.sha256}.mp4`, `${target}.remote.tmp`]);
    expect(await fs.pathExists(`${target}.remote.tmp`)).to.equal(false);
  });

  it('keeps no fetched copy that cannot be played, as an older host may send', async () => {
    const { spawn } = host();
    const target = path.join(dir, 'bounce', `${media.sha256}.mp4`);
    for (const probe of [async () => ({ codec: 'h264', pixFmt: null, frames: 724 }), async () => { throw new Error('ffprobe failed\nmore'); }]) {
      logs.length = 0;
      const remote = new RemoteEncoder({ config, logger, probe, spawn });
      await remote.check();
      expect(await remote.reverse(media, target)).to.equal(null);
      expect(await fs.pathExists(target)).to.equal(false);
      expect(await fs.pathExists(`${target}.remote.tmp`)).to.equal(false);
      expect(logs.find(entry => entry[1] === 'Offload copy cannot be played')).to.exist;
    }
  });

  it('records a smoothed copy\'s size beside it', async () => {
    const { spawn, calls } = host({ job: child => answer(child, { event: 'done', file: `${fakeSha(7)}@0.5.mp4` }) });
    const remote = new RemoteEncoder({ config, logger, probe: playable, spawn });
    await remote.check();
    const slowed = { ...media, speed: 0.5 };
    const target = path.join(dir, 'smooth', `${media.sha256}@0.5.mp4`);
    expect(await remote.smooth(slowed, target, { size: { width: 1280, height: 720 }, fps: 30 })).to.equal(target);
    expect(await fs.readJson(path.join(dir, 'smooth', `${media.sha256}@0.5.json`))).to.deep.equal({ width: 1280, height: 720 });
    expect(calls[3].child.lines[0].job).to.deep.include({ kind: 'smooth', target: 30, size: { width: 1280, height: 720 } });
  });

  it('counts the host gone when the upload or the connection fails, and a failed job as just that', async () => {
    const target = path.join(dir, 'bounce', 'copy.mp4');
    let remote = new RemoteEncoder({ config, logger, probe: playable, spawn: host({ upload: 12 }).spawn });
    await remote.check();
    let error = null;
    await remote.reverse(media, target).catch(caught => { error = caught; });
    expect(error).to.be.instanceOf(OffloadUnavailable);
    expect(remote.available).to.equal(false);

    // ssh itself fails before the worker starts
    const unreachable = fakeSpawn((child, file, args) => {
      if (args.at(-1).includes('--hello')) {
        answer(child, { event: 'hello', protocol: PROTOCOL, dir: '/w', smooth: false });
        return child.exit(0);
      }
      if (file === 'ssh') return child.exit(255);
      child.exit(0);
    });
    config.set('offload.hosts', ['minerva']);
    remote = new RemoteEncoder({ config, logger, probe: playable, spawn: unreachable.spawn });
    await remote.check();
    error = null;
    await remote.reverse(media, target).catch(caught => { error = caught; });
    expect(error).to.be.instanceOf(OffloadUnavailable);

    remote = new RemoteEncoder({ config, logger, probe: playable, spawn: host({ job: child => answer(child, { event: 'failed', code: 'encode', error: 'no encoder' }) }).spawn });
    await remote.check();
    expect(await remote.reverse(media, target)).to.equal(null);
    expect(remote.available).to.equal(true);
    expect(logs.find(([, message]) => message === 'Offload job failed')[2]).to.include({ code: 'encode', error: 'no encoder' });
  });

  it('kills the session when the job is stopped, which stops the worker there', async () => {
    const { spawn, calls } = host({ job: () => 'hang' });
    const remote = new RemoteEncoder({ config, logger, probe: playable, spawn });
    await remote.check();
    const controller = new AbortController();
    const made = remote.reverse(media, path.join(dir, 'bounce', 'copy.mp4'), { signal: controller.signal });
    for (let i = 0; i < 50 && calls.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    expect(await made).to.equal(null);
    expect(calls[3].child.killed).to.equal('SIGTERM');
    expect(calls).to.have.length(4);
  });

  it('quotes the remote command for a login shell', () => {
    expect(shellQuote("it's")).to.equal(`'it'\\''s'`);
    expect(remoteCommand('backdrop worker', { hello: true, memoryMax: '4G' })).to.equal(`bash -lc 'exec backdrop worker --hello'`);
    expect(remoteCommand('~/bin/backdrop worker', { memoryMax: '4G' }))
      .to.equal(`bash -lc 'exec systemd-run --user --scope --quiet -p MemoryMax=4G -- ~/bin/backdrop worker'`);
    expect(remoteCommand('backdrop worker')).to.equal(`bash -lc 'exec backdrop worker'`);
  });
});

describe('Daemon.reverseAnywhere', () => {
  it('reverses on the host when there is one, here when it is gone, unless the job may not run here', async () => {
    const { Daemon } = await import('../../src/display/Daemon.js');
    const { UNAVAILABLE } = await import('../../src/display/daemon/Bounce.js');
    const calls = [];
    const fake = available => ({
      offload: {
        available,
        reverse: async (media, target) => {
          calls.push(['remote', target]);
          if (available === 'gone') throw new OffloadUnavailable('gone');
          return target;
        }
      },
      reverse: async (media, { dir }) => {
        calls.push(['local', dir]);
        return 'local copy';
      }
    });
    const reverseAnywhere = (self, options) => Daemon.prototype.reverseAnywhere.call(self, { id: 1 }, '/c/x.mp4', { dir: '/c', ...options });
    expect(await reverseAnywhere(fake(true))).to.equal('/c/x.mp4');
    expect(await reverseAnywhere(fake(false))).to.equal('local copy');
    expect(await reverseAnywhere(fake('gone'))).to.equal('local copy');
    expect(await reverseAnywhere(fake('gone'), { local: false })).to.equal(UNAVAILABLE);
    expect(calls).to.deep.equal([['remote', '/c/x.mp4'], ['local', '/c'], ['remote', '/c/x.mp4'], ['local', '/c'], ['remote', '/c/x.mp4']]);
  });
});
