import fs from 'fs-extra';
import { validVideoDuration } from '../Playlist.js';
import { controlPath, nextFiltersPath } from '../runtimeFiles.js';

// Control requests from the CLI (control.json and SIGUSR1: parts on and off, a visualizer preset or menu change,
// durations) and the durations they set, for a Daemon (passed in), whose state they read and change.
export class ControlRequests {
  constructor(daemon) {
    this.daemon = daemon;
  }

  // SIGUSR1: applies control.json ({ pid, wallpaper, visualizer, durations, preset }, each optional), written by
  // the CLI for this daemon's pid. With neither part left on, the daemon stops.
  async apply() {
    if (this.daemon.stopping) return;
    let request = {};
    try {
      const { pid, ...rest } = await fs.readJson(controlPath(this.daemon.runtimeDir));
      if (pid === process.pid) request = rest;
      await fs.remove(controlPath(this.daemon.runtimeDir));
    } catch {
      // No request: the generation still moves so the CLI does not wait for nothing
    }
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
    if (typeof request.visualizer === 'boolean') {
      await this.daemon.visualizers.setEnabled(request.visualizer);
      this.daemon.logger.info(request.visualizer ? 'Visualizer on' : 'Visualizer off', this.daemon.visualizers.summary());
    }
    this.daemon.controlGeneration++;
    if (!this.daemon.wallpaper && !this.daemon.visualizers.active) {
      this.daemon.logger.info('Wallpaper and visualizer are off, stopping');
      await this.daemon.stop();
      return;
    }
    await this.daemon.writeState();
  }

  // `backdrop start/stop --wallpaper`: wallpapers on every active monitor, or none. Running visualizers are
  // placed above the new wallpaper windows.
  async setWallpaper(on) {
    if (on === this.daemon.wallpaper || this.daemon.stopping) return;
    this.daemon.wallpaper = on;
    if (on) {
      for (const monitor of [...this.daemon.monitors.values()]) {
        if (!this.daemon.screens.has(monitor.name)) await this.daemon.startWallpaper(monitor);
      }
      await this.daemon.visualizers.restackAll();
    } else {
      const screens = [...this.daemon.screens.values()];
      this.daemon.screens.clear();
      await Promise.all(screens.map(screen => this.daemon.stopScreen(screen)));
    }
    this.daemon.logger.info(on ? 'Wallpaper on' : 'Wallpaper off');
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
