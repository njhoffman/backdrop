import readline from 'readline';
import { SSH_OPTIONS, shellQuote } from './RelayPipe.js';

const FIRST_DELAY_MS = 5000;
const MAX_DELAY_MS = 60_000;
const STEADY_MS = 60_000;

// The protocol of `backdrop audio watch`'s lines; a line of another version is ignored
export const WATCH_PROTOCOL = 1;

// What ssh runs on the peer: a login shell, so PATH has node as the user's shell sets it
export function watchCommand(command) {
  return `bash -lc ${shellQuote(`exec ${command}`)}`;
}

// What the other machine plays, from `backdrop audio watch` there over SSH: onState(snapshot) for each line it
// prints, and onState(null) when the session ends or cannot be made, after which it connects again with a delay
// that doubles up to maxDelay. stdin stays open, so the watch there ends with the session.
export class PeerLink {
  constructor({ host, command = 'backdrop audio watch', spawn, logger, onState, ssh = 'ssh', firstDelay = FIRST_DELAY_MS, maxDelay = MAX_DELAY_MS, now = Date.now }) {
    Object.assign(this, { host, command, spawn, logger, onState, ssh, firstDelay, maxDelay, now });
    this.child = null;
    this.stopped = false;
    this.timer = null;
    this.delay = firstDelay;
    this.state = null;
    this.reported = false;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  connect() {
    if (this.stopped) return;
    const child = this.spawn(this.ssh, [...SSH_OPTIONS, this.host, '--', watchCommand(this.command)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const startedAt = this.now();
    let lastError = '';
    child.stdin?.on('error', () => {});
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', line => this.receive(line));
    }
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on('line', line => { if (line.trim()) lastError = line.trim(); });
    }
    let ended = false;
    const finish = reason => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      if (this.state !== null || !this.reported) this.update(null);
      if (this.stopped) return;
      if (this.now() - startedAt >= STEADY_MS) this.delay = this.firstDelay;
      this.logger.warn('Lost the audio watch on the other machine, connecting again', { host: this.host, reason, error: lastError || undefined, delay: this.delay });
      this.timer = setTimeout(() => {
        this.timer = null;
        this.connect();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelay);
    };
    child.on('error', error => finish(error.message));
    child.on('exit', code => finish(`exit ${code}`));
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.v !== WATCH_PROTOCOL || typeof message.active !== 'boolean') return;
    const { v: _, ...snapshot } = message;
    this.update(snapshot);
  }

  update(state) {
    this.state = state;
    this.reported = true;
    this.onState(state);
  }
}
