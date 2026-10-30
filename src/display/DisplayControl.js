import { MpvClient } from './MpvClient.js';
import { pointerMonitor, run } from './Monitors.js';
import { readState } from './Daemon.js';
import {
  MODE_KINDS, MODES, getMode, setMode, otherMode, loadPlaylist, appendToPlaylist, brightnessFor, queueRandom, queueMatching
} from './Playlist.js';

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

const DIM_STEP = /^([+-])(\d+)$/;

// 'reset', an absolute amount from 0 to 100 ('30'), or a step from the current amount ('+10', '-5').
// Steps are clamped to the range; an absolute value outside it is an error.
export function parseDim(spec, current) {
  const text = String(spec).trim();
  if (text === 'reset') return 0;
  if (DIM_STEP.test(text)) {
    const [, sign, amount] = DIM_STEP.exec(text);
    return Math.min(100, Math.max(0, current + (sign === '+' ? 1 : -1) * Number(amount)));
  }
  if (/^\d+$/.test(text) && Number(text) <= 100) return Number(text);
  throw new Error(`Invalid dim: ${spec} (use 0-100, a step like +10 or -10, or reset)`);
}

// Monitors with a running wallpaper (an mpv socket); none while the wallpaper is off or the daemon stopped
function wallpaperMonitors(state) {
  return (state?.monitors ?? []).filter(monitor => monitor.socket);
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
    if (!monitors.length) {
      throw new Error('The daemon is waiting for its configured monitors (display.monitors); none is active');
    }

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
    if (!monitor.socket) throw new Error('The wallpaper is off; turn it on with `backdrop start --wallpaper`');
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
      return this.describe(monitor, filePath);
    });
  }

  describe(monitor, filePath) {
    const media = filePath ? this.database.getMediaByPath(filePath) : null;
    const rating = media ? this.database.getLatestRating(media.id) : null;
    return { monitor, path: filePath, media, rating };
  }

  // Runs change(client, monitor), which switches what the monitor plays, and returns the new item along
  // with change's result. mpv marks the entry it switches to as current before the file loads, so this
  // reads the playlist instead of waiting for the load; an emptied playlist reports nothing playing.
  async switchTo(monitorName, change) {
    const monitor = await this.targetMonitor(monitorName);
    return this.withClient(monitor, async client => {
      const result = await change(client, monitor);
      const playlist = await client.getProperty('playlist');
      return { ...this.describe(monitor, playlist.find(entry => entry.current)?.filename ?? null), result };
    });
  }

  // What the monitor plays or is about to: the playlist's current entry, which mpv sets before the file
  // loads, so a menu redrawn right after next shows the new item rather than the one still on screen
  async selected(monitorName) {
    const { result, ...playing } = await this.switchTo(monitorName, async () => {});
    return playing;
  }

  // random first moves a random entry up to play next, so prev still returns to the item before it.
  // matches (media rows from --query/--tag/--keywords) limits that to their entries, in playlist order
  // unless random; with no other matching entry the playlist is left alone and the error says why,
  // or with fallback (the advance after a rating) it advances as without matches.
  async next(monitorName, { random = false, matches, fallback = false } = {}) {
    return this.switchTo(monitorName, async (client, monitor) => {
      if (!matches || !await queueMatching(client, new Set(matches.map(media => media.path)), { random })) {
        if (matches && !fallback) throw new Error(await this.noMatch(client, monitor, matches));
        if (random) await queueRandom(client);
      }
      await client.command('playlist-next', 'force');
    });
  }

  async noMatch(client, monitor, matches) {
    if (!matches.length) return 'No downloaded media matches the filters';
    const mode = getMode(this.database);
    const inMode = matches.filter(media => MODE_KINDS[mode].includes(media.kind));
    if (!inMode.length) {
      const other = otherMode(mode);
      return `No matching ${mode}s; ${matches.length} matching ${other}s (switch with \`backdrop mode ${other}\`)`;
    }
    const currentPath = await client.getProperty('path').catch(() => null);
    if (inMode.length === 1 && inMode[0].path === currentPath) return `Only the item playing on ${monitor.name} matches`;
    return `None of the ${inMode.length} matching ${mode}s is in the ${monitor.name} playlist besides the one playing`
      + ' (items smaller than the monitor are left out unless display.allow_upscale is set)';
  }

  async prev(monitorName) {
    return this.switchTo(monitorName, client => client.command('playlist-prev', 'force'));
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

  // Dims the playing item now and stores it for future plays; images and videos alike
  async dim(spec, monitorName) {
    const { monitor, media } = await this.current(monitorName);
    if (!media) {
      throw new Error(`Nothing from the library is playing on ${monitor.name}`);
    }

    const dim = parseDim(spec, media.dim);
    this.database.setDim(media.id, dim);
    await this.withClient(monitor, client => client.setProperty('brightness', brightnessFor(dim)));
    return { monitor, media, dim };
  }

  // Appends media to every running monitor's playlist; returns { [monitor]: count }, empty when not running
  async appendMedia(mediaIds) {
    const state = await this.state({ required: false });
    const counts = {};
    if (!mediaIds.length) {
      return counts;
    }
    const mode = getMode(this.database);
    for (const monitor of wallpaperMonitors(state)) {
      counts[monitor.name] = await this.withClient(monitor, client => appendToPlaylist(client, {
        database: this.database, config: this.config.get(), mode, monitor, mediaIds
      }));
    }
    return counts;
  }

  // Drops every reference to a file, including the playing entry, on every monitor.
  // Removing the current entry advances mpv; removing the final entry leaves it idle.
  async removeMedia(media) {
    if (!media.path) return;
    const state = await this.state({ required: false });
    for (const monitor of wallpaperMonitors(state)) {
      await this.withClient(monitor, async client => {
        const playlist = await client.getProperty('playlist');
        for (let index = playlist.length - 1; index >= 0; index--) {
          if (playlist[index].filename === media.path) {
            await client.command('playlist-remove', index);
          }
        }
      });
    }
  }

  // Rebuild affected playlists after a file move, keeping the same item selected where possible.
  async refreshMedia(previous) {
    const state = await this.state({ required: false });
    for (const monitor of wallpaperMonitors(state)) {
      await this.withClient(monitor, async client => {
        const playlist = await client.getProperty('playlist');
        if (!playlist.some(entry => entry.filename === previous.path)) return;
        const currentPath = await client.getProperty('path').catch(() => null);
        const current = currentPath === previous.path ? previous : this.database.getMediaByPath(currentPath);
        await loadPlaylist(client, {
          database: this.database, config: this.config.get(), mode: getMode(this.database),
          monitor, runtimeDir: this.config.get().paths.runtime, lastMediaId: current?.id
        });
      });
    }
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
    for (const monitor of wallpaperMonitors(state)) {
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
