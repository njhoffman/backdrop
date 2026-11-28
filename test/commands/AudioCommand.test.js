import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { AudioCommand, describeAudio, readAudioStatus } from '../../src/commands/AudioCommand.js';
import { audioPath } from '../../src/display/runtimeFiles.js';
import { setJsonOutput } from '../../src/utils/output.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('AudioCommand', () => {
  let runtimeDir, config, output, written;

  const write = status => fs.writeJsonSync(audioPath(runtimeDir), { pid: process.pid, enabled: true, peer: 'minerva', reachable: true, ...status });
  const command = (options = {}) => new AudioCommand(config, null, silentLogger, { output, hostname: () => 'charon', ...options });

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdrop-audio-'));
    config = makeConfig();
    config.config.paths.runtime = runtimeDir;
    written = [];
    output = new PassThrough();
    output.on('data', chunk => written.push(...String(chunk).split('\n').filter(Boolean)));
  });

  afterEach(() => {
    setJsonOutput(false);
    fs.removeSync(runtimeDir);
  });

  it('describes each role in a line', () => {
    expect(describeAudio({ running: true, role: 'client', server: 'minerva', player: 'spotify', volume: 54 })).to.equal('client of minerva: spotify 54%');
    expect(describeAudio({ running: true, role: 'server', peer: 'minerva', player: 'mpd', volume: 40, muted: true })).to.equal('server for minerva: mpd muted');
    expect(describeAudio({ running: true, enabled: true, role: 'local', peer: 'minerva', reachable: true })).to.equal('local');
    expect(describeAudio({ running: true, enabled: true, role: 'local', peer: 'minerva', reachable: false })).to.equal('local (minerva unreachable)');
    expect(describeAudio({ running: true, enabled: false, role: 'local' })).to.equal('local (audio_relay off)');
    expect(describeAudio({ running: false, role: 'local' })).to.equal('local (daemon not running)');
  });

  it('reads the local role when the file is missing or its daemon is gone', () => {
    expect(readAudioStatus(runtimeDir)).to.include({ running: false, role: 'local' });
    write({ role: 'client', pid: 2 ** 22 + 1 });
    expect(readAudioStatus(runtimeDir)).to.include({ running: false, role: 'local' });
    write({ role: 'client', server: 'minerva' });
    expect(readAudioStatus(runtimeDir)).to.include({ running: true, role: 'client', server: 'minerva' });
  });

  it('prints the status as a line or as JSON', async () => {
    write({ role: 'client', server: 'minerva', player: 'spotify', volume: 54 });
    await command().run('status', {});
    await command().run('status', { json: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(written[0]).to.equal('client of minerva: spotify 54%');
    expect(JSON.parse(written[1])).to.include({ role: 'client', server: 'minerva', running: true });
  });

  it('follows audio.json, printing a line for each change that shows', async () => {
    let onEvent, closed = false;
    const watch = (dir, listener) => {
      expect(dir).to.equal(runtimeDir);
      onEvent = listener;
      return { close() { closed = true; } };
    };
    write({ role: 'local' });
    const done = command({ watch }).run('status', { follow: true });
    write({ role: 'server', player: 'spotify', volume: 54 });
    onEvent('rename', 'audio.json');
    onEvent('change', 'state.json');
    onEvent('change', 'audio.json');
    output.emit('close');
    expect(await done).to.equal(0);
    expect(closed).to.be.true;
    expect(written).to.deep.equal(['local', 'server for minerva: spotify 54%']);
  });

  it('watches the players for the other machine, a JSON line per change, until stdin ends', async () => {
    const input = new PassThrough();
    let watcher;
    const musicWatcher = options => {
      watcher = {
        options,
        async start() { options.onChange({ active: false, player: null, sink: 'x', volume: 50, muted: false }); },
        stop() { watcher.stopped = true; }
      };
      return watcher;
    };
    const done = command({ input, musicWatcher }).run('watch');
    await new Promise(resolve => setImmediate(resolve));
    watcher.options.onChange({ active: true, player: 'spotify', sink: 'x', volume: 50, muted: false });
    input.end();
    expect(await done).to.equal(0);
    expect(watcher.stopped).to.be.true;
    expect(watcher.options).to.include({ grace: 10_000 });
    expect(written.map(line => JSON.parse(line))).to.deep.equal([
      { v: 1, host: 'charon', active: false, player: null, sink: 'x', volume: 50, muted: false },
      { v: 1, host: 'charon', active: true, player: 'spotify', sink: 'x', volume: 50, muted: false }
    ]);
  });
});
