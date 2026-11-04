import net from 'net';
import path from 'path';

const RETRY_MS = 5000;

// sleeved's Unix socket, where sleeve itself looks for it
export function sleevedSocket(env = process.env) {
  return path.join(env.XDG_RUNTIME_DIR ?? '', 'sleeve', 'sleeved.sock');
}

// Stays connected to sleeved so as to notice it starting. sleeved forgets every `sleeve ctl display` change when it
// restarts, and every connection starts with a hello message, so onHello means a sleeved that may have forgotten
// them (see docs/specs/sleeve.md). A connection that fails or closes tries again every retry ms, for as long as it takes.
export class SleevedWatcher {
  constructor({ onHello, socket = sleevedSocket(), connect = net.connect, retry = RETRY_MS, logger }) {
    Object.assign(this, { onHello, socket, connect, retry, logger });
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
    let first = '';
    let greeted = false;
    connection.on('data', chunk => {
      if (greeted) return;
      first += chunk;
      const end = first.indexOf('\n');
      if (end === -1) return;
      greeted = true;
      this.hello(first.slice(0, end));
    });
    // A close follows an error; only sleeved going away or never being there reaches here
    connection.on('error', () => {});
    connection.on('close', () => {
      if (this.connection !== connection || this.stopped) return;
      this.connection = null;
      this.timer = setTimeout(() => this.open(), this.retry);
      this.timer.unref?.();
    });
  }

  hello(line) {
    try {
      if (JSON.parse(line).type === 'hello') this.onHello();
    } catch (error) {
      this.logger?.debug('Unexpected first message from sleeved', { error: error.message });
    }
  }
}
