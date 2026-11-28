import fs from 'fs-extra';
import os from 'os';
import { MusicWatcher } from '../../audio/MusicWatcher.js';
import { PeerLink } from '../../audio/PeerLink.js';
import { RelayPipe } from '../../audio/RelayPipe.js';
import { decideRole, serverHost } from '../../audio/roles.js';
import { RELAY_SINK } from '../../audio/streams.js';
import { audioPath } from '../runtimeFiles.js';

// audio_relay (docs/specs/audio-relay.md), for a Daemon: follows what the music players here play (MusicWatcher) and
// on audio_relay.peer (PeerLink, `backdrop audio watch` there over SSH), and decides which machine is the audio
// server (roles.js). As the client this machine relays the server's music into a null sink (RelayPipe), which the
// visualizer reads in place of source: auto. Each change of role or of the server's volume is written to audio.json in
// the runtime dir, which `backdrop audio status`, polybar and the i3 audio keys read.
export class AudioRelay {
  constructor(daemon, {
    musicWatcher = options => new MusicWatcher(options),
    peerLink = options => new PeerLink(options),
    relayPipe = options => new RelayPipe(options),
    hostname = () => daemon.config.hostname?.() ?? os.hostname()
  } = {}) {
    Object.assign(this, { daemon, musicWatcher, peerLink, relayPipe, hostname });
    this.reset();
  }

  reset() {
    this.watcher = null;
    this.link = null;
    this.pipe = null;
    this.peer = null;
    this.local = null;
    this.remote = null;
    this.role = 'local';
    this.since = null;
    this.relaying = null;
    this.deciding = Promise.resolve();
  }

  get settings() {
    return this.daemon.config.get().audio_relay ?? {};
  }

  get enabled() {
    return Boolean(this.settings.enabled && this.settings.peer);
  }

  async begin() {
    const { peer, players, grace, watch_command: command } = this.settings;
    const { spawn, exec, logger } = this.daemon;
    this.peer = peer ?? null;
    this.since = Date.now();
    if (!this.enabled) {
      await this.write();
      return;
    }
    // A daemon killed as a client leaves its sink; one that is not a client has no use for it
    this.pipe = this.relayPipe({ host: peer, spawn, exec, logger });
    await this.pipe.release();
    this.watcher = this.musicWatcher({
      players, grace: grace * 1000, spawn, exec, logger,
      onChange: snapshot => this.onLocal(snapshot)
    });
    this.local = await this.watcher.start();
    this.link = this.peerLink({ host: peer, command, spawn, logger, onState: snapshot => this.onPeer(snapshot) });
    this.link.start();
    logger.info('Audio relay watching', { peer, players });
    await this.write();
  }

  async stop() {
    // A decision still queued finds no watcher and changes nothing
    const { watcher, link } = this;
    this.watcher = null;
    watcher?.stop();
    link?.stop();
    await this.deciding;
    await this.pipe?.stop();
    await fs.remove(audioPath(this.daemon.runtimeDir)).catch(() => {});
    this.reset();
  }

  // A saved change to audio_relay: everything starts again with the new settings
  async reconfigure() {
    const wasClient = this.role === 'client';
    await this.stop();
    if (wasClient) await this.useSource(null);
    await this.begin();
  }

  onLocal(snapshot) {
    this.local = snapshot;
    return this.decide();
  }

  onPeer(snapshot) {
    this.remote = snapshot;
    return this.decide();
  }

  // Decisions run one at a time, in the order the changes came
  decide() {
    this.deciding = this.deciding.then(() => this.apply()).catch(error => this.daemon.logger.error('Audio relay failed', { error: error.message }));
    return this.deciding;
  }

  async apply() {
    if (!this.watcher) return;
    const role = decideRole(this.local, this.remote);
    if (role !== this.role) {
      this.daemon.logger.info('Audio role', { role, peer: this.peer, from: this.role });
      this.role = role;
      this.since = Date.now();
    }
    const sink = role === 'client' ? this.remote?.sink : null;
    if (sink !== this.relaying) {
      if (sink) await this.pipe.start(sink);
      else await this.pipe.stop();
      // The visualizer changes source only when it starts or stops relaying, not when the server's sink moves
      if (Boolean(sink) !== Boolean(this.relaying)) await this.useSource(sink ? `${RELAY_SINK}.monitor` : null);
      this.relaying = sink;
    }
    await this.write();
  }

  async useSource(source) {
    if (this.daemon.stopping) return;
    await this.daemon.enqueue(() => this.daemon.visualizers.setRelaySource(source));
  }

  // What audio.json holds: the role, the host whose speakers play, and that host's player, volume and mute
  status() {
    const server = serverHost(this.role, this.hostname(), this.peer);
    const playing = this.role === 'client' ? this.remote : this.local;
    return {
      pid: process.pid,
      host: this.hostname(),
      peer: this.peer,
      enabled: this.enabled,
      role: this.role,
      server,
      reachable: this.remote !== null,
      player: server ? playing?.player ?? null : null,
      sink: playing?.sink ?? null,
      volume: playing?.volume ?? null,
      muted: Boolean(playing?.muted),
      since: this.since,
      local: this.local,
      remote: this.remote
    };
  }

  // For state.json
  summary() {
    if (!this.enabled) return null;
    const { role, peer, server, reachable } = this.status();
    return { role, peer, server, reachable };
  }

  async write() {
    const file = audioPath(this.daemon.runtimeDir);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeJson(temporary, this.status());
      await fs.rename(temporary, file);
    } catch (error) {
      this.daemon.logger.warn('Failed to write audio.json', { error: error.message });
    }
  }
}
