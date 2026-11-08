import fs from 'fs';
import { readState } from '../display/Daemon.js';
import { MpvClient } from '../display/MpvClient.js';

// Live updates for the pages (docs/specs/web.md, D4): one server-sent event stream per page, each event the whole
// snapshot (snapshot(), what GET /api/state answers), sent when anything that shows changes: state.json (the daemon
// starting, stopping, a part or the load changing), or on any monitor's mpv socket a new file, speed or contrast
// (a timer advance, `backdrop next`, the menu). Changes within settle ms are sent as one.
const SETTLE_MS = 150;
const HEARTBEAT_MS = 25000;
// Properties observed on each mpv socket; ids are this hub's own
const OBSERVED = ['path', 'speed', 'contrast'];

export class EventHub {
  constructor({
    runtimeDir, snapshot, logger,
    watch = (dir, listener) => fs.watch(dir, listener),
    connect = socketPath => MpvClient.connect(socketPath, { attempts: 1 }),
    settle = SETTLE_MS, heartbeat = HEARTBEAT_MS
  }) {
    this.runtimeDir = runtimeDir;
    this.snapshot = snapshot;
    this.logger = logger;
    this.watchFiles = watch;
    this.connect = connect;
    this.settle = settle;
    this.heartbeatMs = heartbeat;
    this.streams = new Set();
    // socket path -> MpvClient
    this.sockets = new Map();
    this.timer = null;
    this.watcher = null;
    this.beat = null;
    this.syncing = Promise.resolve();
  }

  async start() {
    try {
      this.watcher = this.watchFiles(this.runtimeDir, (event, name) => {
        if (name === 'state.json') this.changed({ state: true });
      });
      this.watcher.on?.('error', error => this.logger.warn('Runtime folder watch failed', { error: error.message }));
    } catch (error) {
      // The runtime folder appears with the first daemon; until then only the requests' own updates go out
      this.logger.warn('Not watching the runtime folder', { dir: this.runtimeDir, error: error.message });
    }
    if (this.heartbeatMs) this.beat = setInterval(() => this.write(': keep-alive\n\n'), this.heartbeatMs);
    await this.syncSockets();
  }

  async stop() {
    clearTimeout(this.timer);
    clearInterval(this.beat);
    this.watcher?.close();
    for (const client of this.sockets.values()) client.close();
    this.sockets.clear();
    for (const response of this.streams) response.end();
    this.streams.clear();
  }

  // A page's stream: the snapshot now, then one on each change
  async add(response) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    this.streams.add(response);
    response.on('close', () => this.streams.delete(response));
    await this.send([response]);
  }

  // Something changed; state: state.json did, so the sockets are checked again
  changed({ state = false } = {}) {
    if (state) this.syncing = this.syncing.then(() => this.syncSockets());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.syncing.then(() => this.send([...this.streams]));
    }, this.settle);
  }

  // Observes the sockets state.json lists and lets go of the rest
  async syncSockets() {
    const state = await readState(this.runtimeDir).catch(() => null);
    const wanted = new Set((state?.monitors ?? []).map(monitor => monitor.socket).filter(Boolean));
    for (const [socketPath, client] of this.sockets) {
      if (wanted.has(socketPath)) continue;
      client.close();
      this.sockets.delete(socketPath);
    }
    for (const socketPath of wanted) {
      if (this.sockets.has(socketPath)) continue;
      try {
        const client = await this.connect(socketPath);
        client.on('property-change', () => this.changed());
        client.on('error', () => {});
        client.on('close', () => {
          if (this.sockets.get(socketPath) === client) this.sockets.delete(socketPath);
        });
        for (const [index, name] of OBSERVED.entries()) await client.observeProperty(index + 1, name);
        this.sockets.set(socketPath, client);
      } catch (error) {
        // mpv restarting: the daemon rewrites state.json when it is back, which tries again
        this.logger.warn('Not watching a wallpaper', { socket: socketPath, error: error.message });
      }
    }
  }

  async send(streams) {
    if (!streams.length) return;
    let data;
    try {
      data = JSON.stringify(await this.snapshot());
    } catch (error) {
      this.logger.warn('Failed to read the state for the page', { error: error.message });
      return;
    }
    for (const response of streams) response.write(`event: state\ndata: ${data}\n\n`);
  }

  write(text) {
    for (const response of this.streams) response.write(text);
  }
}
