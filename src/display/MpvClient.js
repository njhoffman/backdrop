import net from 'net';
import { EventEmitter } from 'events';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// JSON IPC client for one mpv instance (--input-ipc-server). Replies are matched to requests by
// request_id; everything else mpv sends is emitted as 'event' and as the event's own name.
export class MpvClient extends EventEmitter {
  constructor(socketPath, { timeout = 5000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeout = timeout;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
  }

  static async connect(socketPath, { attempts = 1, delay = 200, timeout } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const client = new MpvClient(socketPath, { timeout });
      try {
        await client.open();
        return client;
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          await sleep(delay);
        }
      }
    }
    throw new Error(`Cannot connect to mpv at ${socketPath}: ${lastError.message}`);
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);

      socket.once('connect', () => {
        socket.off('error', reject);
        socket.on('error', error => this.emit('error', error));
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);
      socket.on('data', chunk => this.receive(chunk));
      socket.on('close', () => this.handleClose());
    });
  }

  receive(chunk) {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.handleMessage(line);
      }
    }
  }

  handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.request_id !== undefined && this.pending.has(message.request_id)) {
      const { resolve, reject, timer, command } = this.pending.get(message.request_id);
      this.pending.delete(message.request_id);
      clearTimeout(timer);
      if (message.error === 'success') {
        resolve(message.data);
      } else {
        reject(new Error(`mpv ${command[0]} failed: ${message.error}`));
      }
    } else if (message.event) {
      this.emit('event', message);
      this.emit(message.event, message);
    }
  }

  handleClose() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('mpv connection closed'));
    }
    this.pending.clear();
    this.socket = null;
    this.emit('close');
  }

  command(...command) {
    if (!this.socket) {
      return Promise.reject(new Error('mpv connection is not open'));
    }

    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`mpv ${command[0]} timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.pending.set(requestId, { resolve, reject, timer, command });
      this.socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    });
  }

  getProperty(name) {
    return this.command('get_property', name);
  }

  setProperty(name, value) {
    return this.command('set_property', name, value);
  }

  // Property changes arrive as 'property-change' events carrying { id, name, data }
  observeProperty(id, name) {
    return this.command('observe_property', id, name);
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}
