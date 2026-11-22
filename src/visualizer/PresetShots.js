import fs from 'fs-extra';
import path from 'path';

// Screenshots of the visualizer presets for the rofi menu and the web page (docs/specs/visualizer.md): once a preset
// has been in force for DELAY_MS with sound playing, no menu changes over it and the visualizer showing, the daemon
// grabs a monitor that nothing but backdrop's own windows covers (dock bars cropped off) and keeps it as
// visualizer-<preset>.jpg in the thumbnail folder. A monitor covered at that point is looked at again every
// DELAY_MS for as long as the conditions hold; each preset switch takes one screenshot, replacing the last.

export const DELAY_MS = 30000;
const TICK_MS = 5000;
// 16:9 on the usual monitors, large enough for the menu's banner and the web page's cards
const WIDTH = 960;

export function presetShotPath(dir, name) {
  return path.join(dir, `visualizer-${name}.jpg`);
}

// The screenshot of a preset: { path, mtime } (mtime in ms), or null when none has been taken
export async function presetShot(dir, name) {
  const file = presetShotPath(dir, name);
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ? { path: file, mtime: Math.round(stat.mtimeMs) } : null;
}

export class PresetShots {
  // manager is the VisualizerManager; exec runs ffmpeg; display is the X display to grab ($DISPLAY)
  constructor({ manager, exec, logger, now = Date.now, delay = DELAY_MS, tick = TICK_MS, display = process.env.DISPLAY ?? ':0' }) {
    Object.assign(this, { manager, exec, logger, now, delay, tick, display });
    this.timer = null;
    // The preset the conditions hold for, since when, and when to look next
    this.key = null;
    this.since = 0;
    this.nextTry = 0;
    // The preset last captured; another capture waits for a switch away from it
    this.taken = null;
    this.busy = false;
  }

  // Whether the section asks for screenshots of the preset in force
  get wanted() {
    const settings = this.manager.settings;
    return Boolean(settings?.screenshots && settings.preset) && this.manager.active && !this.manager.stopping;
  }

  // Starts or stops the ticks as the settings want them; the manager calls it after each configure
  update() {
    if (this.wanted && !this.timer) {
      this.timer = setInterval(() => this.check(), this.tick);
      this.timer.unref?.();
    } else if (!this.wanted) {
      this.stop();
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.key = null;
  }

  // The preset the conditions hold for now, or null: wanted, not suspended for the load, no menu changes, sound
  // playing (or no way to tell, with audio: fifo) and an instance running with its window found
  current() {
    const manager = this.manager;
    if (!this.wanted || manager.suspended || Object.keys(manager.live ?? {}).length) return null;
    const playing = manager.settings.audio === 'fifo' ? manager.audio.playing !== false : manager.audio.playing === true;
    if (!playing) return null;
    return this.monitorsShowing().length ? manager.settings.preset : null;
  }

  // The monitors with a running instance whose window is found, in the daemon's order
  monitorsShowing() {
    const names = new Set([...this.manager.entries.values()].filter(entry => entry.window && this.manager.current(entry)).map(entry => entry.monitor.name));
    return [...this.manager.monitors.keys()].filter(name => names.has(name));
  }

  async check() {
    const key = this.current();
    const time = this.now();
    if (key !== this.key) {
      Object.assign(this, { key, since: time, nextTry: time + this.delay });
      // A pause leaves the mark, so the same preset is not taken again when the sound comes back
      if (key && key !== this.taken) this.taken = null;
    }
    if (!key || this.taken === key || this.busy || time < this.nextTry) return false;
    this.busy = true;
    try {
      const done = await this.capture(key);
      if (done) this.taken = key;
      else this.nextTry = this.now() + this.delay;
      return done;
    } finally {
      this.busy = false;
    }
  }

  // Grabs the first monitor nothing covers; false when every one is covered or the grab failed
  async capture(preset) {
    const manager = this.manager;
    for (const name of this.monitorsShowing()) {
      const monitor = manager.monitors.get(name);
      if (!monitor) continue;
      let area = null;
      try {
        area = await manager.x11(async x => {
          const own = new Set();
          const wallpaper = await manager.wallpaperWindow(name, x);
          if (wallpaper) own.add(wallpaper);
          for (const entry of manager.monitorEntries(name)) {
            if (entry.window && manager.current(entry)) own.add(await x.topLevel(entry.window).catch(() => entry.window));
          }
          for (const overlay of manager.overlaysOn(name)) own.add(overlay.window);
          return x.uncoveredArea(monitor, own);
        });
      } catch (error) {
        this.logger.warn('Failed to look at the monitor for a preset screenshot', { monitor: name, error: error.message });
        continue;
      }
      if (!area) continue;
      // The preset may have changed while the windows were looked at
      if (this.current() !== preset) return false;
      return this.grab(preset, name, area);
    }
    this.logger.debug('Every monitor is covered, no preset screenshot yet', { preset });
    return false;
  }

  async grab(preset, monitor, area) {
    const dir = this.manager.config.get().paths.thumbnails;
    const target = presetShotPath(dir, preset);
    const partial = `${target}.${process.pid}.jpg`;
    try {
      await fs.ensureDir(dir);
      await this.exec('nice', ['-n', '19', 'ffmpeg', '-v', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0',
        '-video_size', `${area.width}x${area.height}`, '-i', `${this.display}+${area.x},${area.y}`,
        '-frames:v', '1', '-vf', `scale=${WIDTH}:-2`, '-q:v', '3', partial]);
      await fs.rename(partial, target);
      this.logger.info('Visualizer preset screenshot taken', { preset, monitor });
      return true;
    } catch (error) {
      await fs.remove(partial).catch(() => {});
      this.logger.warn('Visualizer preset screenshot failed', { preset, monitor, error: error.message });
      return false;
    }
  }
}
