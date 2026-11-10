import net from 'net';
import path from 'path';

const RETRY_MS = 5000;

// sleeved's Unix socket, where sleeve itself looks for it
export function sleevedSocket(env = process.env) {
  return path.join(env.XDG_RUNTIME_DIR ?? '', 'sleeve', 'sleeved.sock');
}

// Whether a sleeved `lyrics` message means the track has lyrics to show: true when the candidate shown has lines
// (words without times included), false when the lookup ended with none (instrumental, marked none, nothing found)
// or nothing plays, null while a lookup is still out with nothing to show yet, and undefined for any other message
export function hasLyrics(message) {
  if (message?.type !== 'lyrics') return undefined;
  if (message.key === null) return false;
  if (message.result?.best?.lyrics?.lines?.length) return true;
  return message.loading ? null : false;
}

// Stays connected to sleeved so as to notice it starting. sleeved forgets every `sleeve ctl display` change when it
// restarts, and every connection starts with a hello message, so onHello means a sleeved that may have forgotten
// them (see docs/specs/sleeve.md). A connection that fails or closes tries again every retry ms, for as long as it takes.
export class SleevedWatcher {
  // onMessage, when given, gets every message after the greeting's hello, parsed; onClose, a connection lost or
  // never made (sleeved not running)
  constructor({ onHello = () => {}, onMessage = null, onClose = () => {}, socket = sleevedSocket(), connect = net.connect, retry = RETRY_MS, logger }) {
    Object.assign(this, { onHello, onMessage, onClose, socket, connect, retry, logger });
    this.stopped = true;
    this.connection = null;
    this.timer = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.connection?.destroy();
    this.connection = null;
  }

  open() {
    if (this.stopped) return;
    const connection = this.connect(this.socket);
    this.connection = connection;
    connection.unref?.();
    let buffered = '';
    let greeted = false;
    connection.on('data', chunk => {
      if (greeted && !this.onMessage) return;
      buffered += chunk;
      for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (!greeted) {
          greeted = true;
          this.hello(line);
        } else {
          this.message(line);
        }
        if (!this.onMessage) return;
      }
    });
    // A close follows an error; only sleeved going away or never being there reaches here
    connection.on('error', () => {});
    connection.on('close', () => {
      if (this.connection !== connection || this.stopped) return;
      this.connection = null;
      this.onClose();
      this.timer = setTimeout(() => this.open(), this.retry);
      this.timer.unref?.();
    });
  }

  message(line) {
    try {
      this.onMessage(JSON.parse(line));
    } catch (error) {
      this.logger?.debug('Unreadable message from sleeved', { error: error.message });
    }
  }

  hello(line) {
    try {
      if (JSON.parse(line).type === 'hello') this.onHello();
    } catch (error) {
      this.logger?.debug('Unexpected first message from sleeved', { error: error.message });
    }
  }
}
