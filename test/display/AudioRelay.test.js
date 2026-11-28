import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { AudioRelay } from '../../src/display/daemon/AudioRelay.js';
import { audioPath } from '../../src/display/runtimeFiles.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

const PLAYING = { active: true, player: 'spotify', sink: 'bluez_output.1', volume: 54, muted: false };
const QUIET = { active: false, player: null, sink: 'alsa_output.hdmi', volume: 80, muted: false };

describe('AudioRelay', () => {
  let runtimeDir, daemon, watcher, link, pipe, sources, relay;

  const make = (settings = { enabled: true, peer: 'minerva' }) => {
    const config = makeConfig();
    config.config.audio_relay = { ...config.config.audio_relay, ...settings };
    sources = [];
    daemon = {
      config, runtimeDir, logger: silentLogger, spawn() {}, exec: async () => '', stopping: false,
      enqueue: task => Promise.resolve().then(task),
      visualizers: { setRelaySource: async source => { sources.push(source); } }
    };
    pipe = { calls: [], start: async sink => pipe.calls.push(['start', sink]), stop: async () => pipe.calls.push(['stop']), release: async () => pipe.calls.push(['release']) };
    relay = new AudioRelay(daemon, {
      hostname: () => 'charon',
      musicWatcher: options => {
        watcher = { options, start: async () => QUIET, stop() { watcher.stopped = true; } };
        return watcher;
      },
      peerLink: options => {
        link = { options, start() { link.started = true; }, stop() { link.stopped = true; } };
        return link;
      },
      relayPipe: options => {
        pipe.options = options;
        return pipe;
      }
    });
    return relay;
  };
  const status = () => fs.readJsonSync(audioPath(runtimeDir));

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdrop-relay-'));
  });

  afterEach(() => fs.removeSync(runtimeDir));

  it('does nothing but write the local role while audio_relay is off', async () => {
    await make({ enabled: false, peer: 'minerva' }).begin();
    expect(watcher).to.be.undefined;
    expect(pipe.calls).to.be.empty;
    expect(status()).to.include({ role: 'local', enabled: false, server: null });
    expect(relay.summary()).to.be.null;
  });

  it('watches here and on the peer, clearing a sink a killed daemon left', async () => {
    await make().begin();
    expect(pipe.calls).to.deep.equal([['release']]);
    expect(pipe.options).to.include({ host: 'minerva' });
    expect(watcher.options).to.include({ grace: 10_000 });
    expect(watcher.options.players).to.deep.equal(['spotify', 'mpd', 'musicman']);
    expect(link.options).to.include({ host: 'minerva', command: 'backdrop audio watch' });
    expect(link.started).to.be.true;
    expect(status()).to.include({ role: 'local', host: 'charon', peer: 'minerva', reachable: false });
  });

  it('becomes the client of a peer that plays alone, relaying its sink to the visualizer, and local again after', async () => {
    await make().begin();
    await relay.onPeer({ host: 'minerva', ...PLAYING });
    expect(pipe.calls.at(-1)).to.deep.equal(['start', 'bluez_output.1']);
    expect(sources).to.deep.equal(['backdrop_relay.monitor']);
    expect(status()).to.include({ role: 'client', server: 'minerva', player: 'spotify', volume: 54, reachable: true });
    expect(relay.summary()).to.deep.equal({ role: 'client', peer: 'minerva', server: 'minerva', reachable: true });

    // The server's volume changes: audio.json follows, the pipe and the visualizer stay
    await relay.onPeer({ host: 'minerva', ...PLAYING, volume: 70 });
    expect(pipe.calls.filter(([call]) => call === 'start')).to.have.length(1);
    expect(status()).to.include({ volume: 70 });

    // The server's player moves to another sink: the pipe follows, the visualizer keeps its source
    await relay.onPeer({ host: 'minerva', ...PLAYING, sink: 'alsa_output.usb' });
    expect(pipe.calls.at(-1)).to.deep.equal(['start', 'alsa_output.usb']);
    expect(sources).to.have.length(1);

    // Music starts here too: both local
    await relay.onLocal(PLAYING);
    expect(pipe.calls.at(-1)).to.deep.equal(['stop']);
    expect(sources).to.deep.equal(['backdrop_relay.monitor', null]);
    expect(status()).to.include({ role: 'local', server: null, player: null });
  });

  it('is the server while only it plays, with its own player and volume, and local once the peer is gone', async () => {
    await make().begin();
    await relay.onPeer({ host: 'minerva', ...QUIET });
    await relay.onLocal(PLAYING);
    expect(status()).to.include({ role: 'server', server: 'charon', peer: 'minerva', player: 'spotify', volume: 54 });
    expect(pipe.calls).to.deep.equal([['release']]);
    expect(sources).to.be.empty;
    await relay.onPeer(null);
    expect(status()).to.include({ role: 'local', reachable: false });
  });

  it('stops relaying and removes audio.json on stop, ignoring changes after', async () => {
    await make().begin();
    await relay.onPeer({ host: 'minerva', ...PLAYING });
    await relay.stop();
    expect(watcher.stopped).to.be.true;
    expect(link.stopped).to.be.true;
    expect(pipe.calls.at(-1)).to.deep.equal(['stop']);
    expect(fs.existsSync(audioPath(runtimeDir))).to.be.false;
    await relay.onPeer({ host: 'minerva', ...QUIET });
    expect(fs.existsSync(audioPath(runtimeDir))).to.be.false;
  });

  it('gives the visualizer its own source back when the settings change while a client', async () => {
    await make().begin();
    await relay.onPeer({ host: 'minerva', ...PLAYING });
    daemon.config.config.audio_relay.peer = 'nyx';
    await relay.reconfigure();
    expect(sources).to.deep.equal(['backdrop_relay.monitor', null]);
    expect(link.options.host).to.equal('nyx');
    expect(status()).to.include({ role: 'local', peer: 'nyx' });
  });
});
