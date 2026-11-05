import fs from 'fs-extra';
import { validVideoDuration } from '../Playlist.js';
import { controlPath, controlRequestPath, CONTROL_REQUEST, nextFiltersPath } from '../runtimeFiles.js';

// How many handled request ids state.json lists: more than can be waiting at once
const HANDLED_KEPT = 32;

// Control requests from the CLI (request files and SIGUSR1: parts on and off, a visualizer preset or menu change,
// durations, a restack) and the durations they set, for a Daemon (passed in), whose state they read and change.
export class ControlRequests {
  constructor(daemon) {
    this.daemon = daemon;
  }

  // SIGUSR1: applies every pending request, oldest first: one file per request (control-<id>.json, written by
  // sendControl) and the single control.json of CLIs before 2.38.2. Each is { pid, wallpaper, visualizer,
  // durations, preset, ... }, each part optional, and is applied only when pid is this daemon's. The ids of
  // handled requests go into state.json for the CLIs waiting on them; a request that fails is left out, so its
  // CLI reports that the daemon did not answer. With neither part left on, the daemon stops.
  async apply() {
    if (this.daemon.stopping) return;
    const pending = await this.pending();
    for (const { id, file } of pending) {
      let request = {};
      try {
        const { pid, ...rest } = await fs.readJson(file);
        if (pid === process.pid) request = rest;
      } catch {
        // Unreadable: handled as empty, so its CLI does not wait for nothing
      }
      await fs.remove(file);
      try {
        await this.applyRequest(request);
      } catch (error) {
        this.daemon.logger.error('Control request failed', { error: error.message });
        continue;
      }
      this.daemon.controlGeneration++;
      if (id) this.daemon.handledRequests = [...this.daemon.handledRequests, id].slice(-HANDLED_KEPT);
      if (this.daemon.stopping) return;
    }
    // A signal without a request still moves the generation, which CLIs before 2.38.2 wait on
    if (!pending.length) this.daemon.controlGeneration++;
    if (!this.daemon.wallpaper && !this.daemon.visualizers.active) {
      this.daemon.logger.info('Wallpaper and visualizer are off, stopping');
      await this.daemon.stop();
      return;
    }
    await this.daemon.writeState();
  }

  // The request files waiting, oldest first: control.json, then control-<id>.json in name order
  async pending() {
    const names = await fs.readdir(this.daemon.runtimeDir).catch(() => []);
    const requests = names.map(name => CONTROL_REQUEST.exec(name)?.[1]).filter(Boolean).sort()
      .map(id => ({ id, file: controlRequestPath(this.daemon.runtimeDir, id) }));
    const legacy = controlPath(this.daemon.runtimeDir);
    return names.includes('control.json') ? [{ id: null, file: legacy }, ...requests] : requests;
  }

  // Requests left by an earlier daemon, removed on start and stop
  async clear() {
    for (const { file } of await this.pending()) await fs.remove(file);
  }

  async applyRequest(request) {
    if (typeof request.wallpaper === 'boolean') await this.setWallpaper(request.wallpaper);
    if (request.durations) await this.applyDurations();
    // From the visualizer menu: re-read the section (a preset it just saved), drop its changes, or apply one
    if (request.reload_config) await this.daemon.reloadConfig().catch(error => this.daemon.logger.error('Config reload failed', { error: error.message }));
    if (request.visualizer_reset) {
      await this.daemon.visualizers.setLive(null, { reload: request.preset === undefined })
        .catch(error => this.daemon.logger.error('Visualizer reset failed', { error: error.message }));
    }
    if (request.visualizer_set) {
      try {
        await this.daemon.visualizers.setLive(request.visualizer_set);
        this.daemon.logger.info('Visualizer changed from the menu', { change: request.visualizer_set });
      } catch (error) {
        this.daemon.logger.error('Visualizer change refused', { error: error.message });
      }
    }
    if (request.preset !== undefined) {
      await this.daemon.visualizers.setPreset(request.preset);
      this.daemon.logger.info('Visualizer preset', this.daemon.visualizers.summary());
    }
    if (request.screensaver) await this.daemon.screensaver.apply(request.screensaver);
    if (typeof request.visualizer === 'boolean') {
      await this.daemon.visualizers.setEnabled(request.visualizer);
      this.daemon.logger.info(request.visualizer ? 'Visualizer on' : 'Visualizer off', this.daemon.visualizers.summary());
    }
    // `backdrop restack`: look for overlay windows on every monitor and stack everything again
    if (request.restack) await this.daemon.visualizers.restackAll({ scan: true });
  }

  // `backdrop start/stop --wallpaper`: wallpapers on every active monitor, or none. Running visualizers are
  // placed above the new wallpaper windows.
  async setWallpaper(on) {
    if (on === this.daemon.wallpaper || this.daemon.stopping) return;
    this.daemon.wallpaper = on;
    if (!on) await this.stopWallpapers();
    // Held off for the system load or by the preset: the wallpaper starts when that ends
    else if (this.daemon.showsWallpaper) {
      await this.startWallpapers();
      await this.daemon.visualizers.restackAll();
    }
    this.daemon.logger.info(on ? 'Wallpaper on' : 'Wallpaper off');
  }

  async startWallpapers() {
    for (const monitor of [...this.daemon.monitors.values()]) {
      if (this.daemon.stopping) return;
      if (!this.daemon.screens.has(monitor.name)) await this.daemon.startWallpaper(monitor);
    }
  }

  async stopWallpapers() {
    const screens = [...this.daemon.screens.values()];
    this.daemon.screens.clear();
    await Promise.all(screens.map(screen => this.daemon.stopScreen(screen)));
  }

  // Re-reads the durations next and the menu stored and applies them to what plays now: the image's
  // display time, and the video's end, counted from when it started
  async applyDurations() {
    try {
      const { pid, image_duration: image, video_duration: video } = await fs.readJson(nextFiltersPath(this.daemon.runtimeDir));
      this.daemon.durations = pid === process.pid ? Object.fromEntries(Object.entries({ image_duration: image, video_duration: video })
        .filter(([, value]) => value !== undefined)) : {};
    } catch {
      this.daemon.durations = {};
    }
    this.daemon.logger.info('Durations', { image: this.imageDuration(), video: this.videoDuration() });
    for (const screen of [...this.daemon.screens.values()]) {
      try {
        await screen.client.setProperty('image-display-duration', this.imageDuration());
      } catch (error) {
        this.daemon.logger.warn('Failed to set image duration', { monitor: screen.monitor.name, error: error.message });
      }
      if (screen.media) await this.daemon.applyLimits(screen, screen.media, { elapsed: (this.daemon.now() - (screen.loadedAt ?? this.daemon.now())) / 1000 });
    }
  }

  imageDuration() {
    return this.daemon.durations.image_duration ?? this.daemon.config.get().display.image_duration;
  }

  videoDuration() {
    return validVideoDuration(this.daemon.durations.video_duration ?? this.daemon.config.get().display.video_duration ?? 0);
  }
}
