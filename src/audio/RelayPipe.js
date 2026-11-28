import { RELAY_SINK } from './streams.js';

// The client's end of the relay: the server's music over SSH into a null sink here, whose monitor the visualizer
// reads. `parec` on the server records the monitor of the sink its player plays on; `pacat` here plays it into
// RELAY_SINK, which has no speakers, so nothing sounds twice. Both ask for a 20 ms latency: without it parec hands
// over 2-second fragments. A pipe that ends (the server's sound server restarting, the network dropping) starts
// again after a delay that doubles up to maxDelay, and back at the first once one has run for a minute.

export const FORMAT = ['--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20'];
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 30_000;
const STEADY_MS = 60_000;

export const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'Compression=no', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3'];

// A word for a POSIX shell, quoted
export function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

// What ssh runs on the server for a sink
export function recordCommand(sink) {
  return `exec parec -d ${shellQuote(`${sink}.monitor`)} ${FORMAT.join(' ')}`;
}

// The module ids of RELAY_SINK in `pactl list short modules`
export function relayModules(listing) {
  return String(listing).split('\n').map(line => line.split('\t'))
    .filter(([, name, args = '']) => name === 'module-null-sink' && new RegExp(`(^|\\s)sink_name=${RELAY_SINK}(\\s|$)`).test(args))
    .map(([id]) => id);
}

export class RelayPipe {
  constructor({ host, spawn, exec, logger, ssh = 'ssh', firstDelay = FIRST_DELAY_MS, maxDelay = MAX_DELAY_MS, now = Date.now }) {
    Object.assign(this, { host, spawn, exec, logger, ssh, firstDelay, maxDelay, now });
    this.sink = null;
    this.children = [];
    this.running = false;
    this.timer = null;
    this.delay = firstDelay;
    this.startedAt = null;
  }

  // Relays from the server's sink, starting the pipe or moving it to a new sink
  async start(sink) {
    if (this.running && sink === this.sink) return;
    this.sink = sink;
    if (!this.running) {
      this.running = true;
      await this.makeSink();
    }
    this.end();
    this.open();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.end();
    await this.release();
  }

  // Makes RELAY_SINK unless it is there already (left by a daemon that was killed)
  async makeSink() {
    try {
      if (relayModules(await this.exec('pactl', ['list', 'short', 'modules'])).length) return;
      await this.exec('pactl', ['load-module', 'module-null-sink', `sink_name=${RELAY_SINK}`, `sink_properties=device.description=${shellQuote(`relay from ${this.host}`)}`]);
    } catch (error) {
      this.logger.warn('Failed to make the relay sink', { error: error.message });
    }
  }

  // Removes RELAY_SINK, also one a killed daemon left; quiet when there is no pactl or sound server
  async release() {
    try {
      for (const id of relayModules(await this.exec('pactl', ['list', 'short', 'modules']))) await this.exec('pactl', ['unload-module', id]);
    } catch (error) {
      this.logger.debug?.('Failed to remove the relay sink', { error: error.message });
    }
  }

  open() {
    const sink = this.sink;
    const record = this.spawn(this.ssh, [...SSH_OPTIONS, this.host, '--', recordCommand(sink)], { stdio: ['ignore', 'pipe', 'ignore'] });
    const play = this.spawn('pacat', ['--playback', '-d', RELAY_SINK, '--client-name=backdrop-relay', ...FORMAT], { stdio: ['pipe', 'ignore', 'ignore'] });
    const pair = [record, play];
    this.children = pair;
    this.startedAt = this.now();
    record.stdout?.pipe(play.stdin);
    // A broken pipe on either side ends the pair; its exit restarts it
    play.stdin?.on('error', () => {});
    record.stdout?.on('error', () => {});
    let ended = false;
    const finish = (which, code) => {
      if (ended) return;
      ended = true;
      for (const child of pair) child.kill?.('SIGTERM');
      if (!this.running || this.children !== pair) return;
      this.children = [];
      if (this.now() - this.startedAt >= STEADY_MS) this.delay = this.firstDelay;
      this.logger.warn('Audio relay ended, starting it again', { host: this.host, which, code, delay: this.delay });
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.running && !this.children.length) this.open();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelay);
    };
    record.on('error', error => finish('ssh', error.message));
    play.on('error', error => finish('pacat', error.message));
    record.on('exit', code => finish('ssh', code));
    play.on('exit', code => finish('pacat', code));
    this.logger.info('Audio relay started', { host: this.host, sink });
  }

  end() {
    clearTimeout(this.timer);
    this.timer = null;
    const children = this.children;
    this.children = [];
    for (const child of children) child.kill?.('SIGTERM');
  }
}
