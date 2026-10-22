import { MpvClient } from './MpvClient.js';
import { pointerMonitor, run } from './Monitors.js';
import { readState } from './Daemon.js';
import { MODE_KINDS, MODES, getMode, setMode, otherMode, loadPlaylist } from './Playlist.js';

const SPEED_STEP = /^([+-])(\d*\.?\d+)$/;

// 'reset', an absolute value ('0.8'), or a step relative to the current speed ('+0.1', '-.25')
export function parseSpeed(spec, current) {
  const text = String(spec).trim();
  let speed;

  if (text === 'reset') {
    speed = 1;
  } else if (SPEED_STEP.test(text)) {
    const [, sign, amount] = SPEED_STEP.exec(text);
    speed = current + (sign === '+' ? 1 : -1) * Number(amount);
  } else if (/^\d*\.?\d+$/.test(text)) {
    speed = Number(text);
  } else {
    throw new Error(`Invalid speed: ${spec} (use a value like 0.8, a step like +0.1, or reset)`);
  }

  return Math.round(speed * 100) / 100;
}

// Talks to the running daemon's mpv instances; the target is the monitor under the pointer
// unless one is named
export class DisplayControl {
  constructor({ config, database, exec = run, connect = MpvClient.connect }) {
    this.config = config;
    this.database = database;
    this.exec = exec;
    this.connect = connect;
  }

  async state({ required = true } = {}) {
    const state = await readState(this.config.get().paths.runtime);
    if (!state && required) {
      throw new Error('backdrop daemon is not running (start it with `backdrop start`)');
    }
    return state;
  }

  async targetMonitor(name = null) {
    const { monitors } = await this.state();

    if (name) {
      const monitor = monitors.find(m => m.name === name);
      if (!monitor) {
        throw new Error(`Monitor ${name} is not managed by the daemon (active: ${monitors.map(m => m.name).join(', ')})`);
      }
      return monitor;
    }
    if (monitors.length === 1) {
      return monitors[0];
    }
    return await pointerMonitor(monitors, this.exec)
      ?? monitors.find(m => m.primary)
      ?? monitors[0];
  }

  async withClient(monitor, fn) {
    const client = await this.connect(monitor.socket);
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  }

  async current(monitorName) {
    const monitor = await this.targetMonitor(monitorName);
    return this.withClient(monitor, async client => {
      const filePath = await client.getProperty('path').catch(() => null);
      const media = filePath ? this.database.getMediaByPath(filePath) : null;
      const rating = media ? this.database.getLatestRating(media.id) : null;
      return { monitor, path: filePath, media, rating };
    });
  }

  async next(monitorName) {
    const monitor = await this.targetMonitor(monitorName);
    await this.withClient(monitor, client => client.command('playlist-next', 'force'));
    return monitor;
  }

  async prev(monitorName) {
    const monitor = await this.targetMonitor(monitorName);
    await this.withClient(monitor, client => client.command('playlist-prev', 'force'));
    return monitor;
  }

  // Changes the playing video's speed now and stores it for future plays
  async speed(spec, monitorName) {
    const { monitor, media } = await this.current(monitorName);
    if (!media) {
      throw new Error(`Nothing from the library is playing on ${monitor.name}`);
    }
    if (!MODE_KINDS.video.includes(media.kind)) {
      throw new Error('Speed only applies to videos and GIFs');
    }

    const speed = parseSpeed(spec, media.speed);
    this.database.setSpeed(media.id, speed);
    await this.withClient(monitor, client => client.setProperty('speed', speed));
    return { monitor, media, speed };
  }

  // Sets the mode ('video', 'image' or 'toggle') and reloads every monitor if the daemon is running
  async mode(requested = 'toggle') {
    const mode = requested === 'toggle' ? otherMode(getMode(this.database)) : requested;
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown mode: ${requested} (expected video, image or toggle)`);
    }
    setMode(this.database, mode);

    const state = await this.state({ required: false });
    const counts = {};
    for (const monitor of state?.monitors ?? []) {
      counts[monitor.name] = await this.withClient(monitor, client => loadPlaylist(client, {
        database: this.database,
        config: this.config.get(),
        mode,
        monitor,
        runtimeDir: this.config.get().paths.runtime
      }));
    }
    return { mode, running: Boolean(state), counts };
  }
}
