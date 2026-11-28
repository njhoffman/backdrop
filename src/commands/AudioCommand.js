import { spawn as spawnProcess, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';
import { MusicWatcher } from '../audio/MusicWatcher.js';
import { WATCH_PROTOCOL } from '../audio/PeerLink.js';
import { audioPath } from '../display/runtimeFiles.js';
import { setJsonOutput } from '../utils/output.js';

const execFileAsync = promisify(execFile);
const defaultExec = async (file, args) => (await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 })).stdout;

export const AUDIO_ACTIONS = ['status', 'watch'];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// What a running daemon wrote to audio.json, or the local role when no daemon runs or the relay is off
export function readAudioStatus(runtimeDir) {
  try {
    const status = JSON.parse(fs.readFileSync(audioPath(runtimeDir), 'utf8'));
    if (Number.isInteger(status.pid) && alive(status.pid)) return { running: true, ...status };
  } catch {
    // No daemon, or a file being replaced: the local role
  }
  return { running: false, enabled: false, role: 'local', server: null, peer: null, reachable: false, player: null, volume: null, muted: false };
}

// One line for a person: the role, the other machine, and the server's player and volume
export function describeAudio(status) {
  const level = status.muted ? 'muted' : status.volume === null || status.volume === undefined ? null : `${status.volume}%`;
  const playing = [status.player, level].filter(Boolean).join(' ');
  if (status.role === 'server') return `server for ${status.peer}${playing ? `: ${playing}` : ''}`;
  if (status.role === 'client') return `client of ${status.server}${playing ? `: ${playing}` : ''}`;
  if (!status.running) return 'local (daemon not running)';
  if (!status.enabled) return 'local (audio_relay off)';
  return status.reachable ? 'local' : `local (${status.peer} unreachable)`;
}

// `backdrop audio`: status prints the role audio.json holds (once, or again on each change with --follow); watch,
// which the daemon on audio_relay.peer runs here over SSH, prints what the music players here play as JSON lines
// until its stdin closes
export class AudioCommand {
  constructor(config, database, logger, {
    spawn = spawnProcess, exec = defaultExec, input = process.stdin, output = process.stdout,
    watch = fs.watch, musicWatcher = options => new MusicWatcher(options), hostname = () => config.hostname?.() ?? os.hostname()
  } = {}) {
    Object.assign(this, { config, logger, spawn, exec, input, output, watch, musicWatcher, hostname });
  }

  run(action = 'status', options = {}) {
    if (action === 'watch') return this.watchMusic();
    return this.status(options);
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  line(status, json) {
    return json ? JSON.stringify(status) : describeAudio(status);
  }

  async status({ json = false, follow = false } = {}) {
    if (json) setJsonOutput(true);
    let last = this.line(readAudioStatus(this.runtimeDir), json);
    this.output.write(`${last}\n`);
    if (!follow) return 0;
    // The runtime dir, not the file: the daemon replaces audio.json by renaming, and removes it on stop
    return new Promise(resolve => {
      let watcher;
      const changed = name => {
        if (name && name !== 'audio.json') return;
        const next = this.line(readAudioStatus(this.runtimeDir), json);
        if (next === last) return;
        last = next;
        this.output.write(`${next}\n`);
      };
      try {
        fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
        watcher = this.watch(this.runtimeDir, (event, name) => changed(name));
      } catch (error) {
        this.logger.warn('Cannot follow audio.json', { error: error.message });
        resolve(1);
        return;
      }
      // A daemon that dies leaves the file behind: notice the pid gone
      const timer = setInterval(() => changed(), 5000);
      const end = () => {
        clearInterval(timer);
        watcher?.close();
        process.off('SIGTERM', end);
        process.off('SIGINT', end);
        resolve(0);
      };
      this.output.on?.('error', end);
      this.output.on?.('close', end);
      process.once('SIGTERM', end);
      process.once('SIGINT', end);
    });
  }

  async watchMusic() {
    setJsonOutput(true);
    const { players, grace } = this.config.get().audio_relay;
    const host = this.hostname();
    const watcher = this.musicWatcher({
      players, grace: grace * 1000, spawn: this.spawn, exec: this.exec, logger: this.logger,
      onChange: snapshot => this.output.write(`${JSON.stringify({ v: WATCH_PROTOCOL, host, ...snapshot })}\n`)
    });
    await watcher.start();
    // The daemon's side keeps stdin open: its end, or a closed stdout, is the session gone
    await new Promise(resolve => {
      const end = () => resolve();
      this.input.on('end', end);
      this.input.on('close', end);
      this.input.on('error', end);
      this.output.on?.('error', end);
      this.input.resume?.();
    });
    watcher.stop();
    this.input.destroy?.();
    return 0;
  }
}
