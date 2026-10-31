import { paletteColors } from '../../visualizer/palette.js';

// Visualizer colors from the wallpaper (visualizer.palette.source: wallpaper): each monitor's item is
// sampled once per load and every instance takes its colors from the strip under it; for a Daemon (passed in).
export class WallpaperColors {
  constructor(daemon) {
    this.daemon = daemon;
  }

  // A visualizer instance's colors from the item its monitor shows, or null (its configured colors) while
  // nothing is known: no wallpaper runs, or the item is not sampled yet, in which case sampling starts and
  // the instance is recolored once it is done
  colorsFor(monitor, instance, geometry) {
    const media = this.daemon.screens.get(monitor.name)?.media;
    if (!media) return null;
    const cached = this.daemon.samples.get(monitor.name);
    if (cached?.mediaId !== media.id) {
      this.sampleScreen(monitor.name);
      return null;
    }
    // Contrast against the brightness mpv shows now (the item's dim, `backdrop dim` since, or the music dim);
    // the sample's own is the item's dim when it loaded
    const brightness = this.daemon.screens.get(monitor.name)?.brightness;
    const sample = typeof brightness === 'number' ? { ...cached.sample, dim: Math.max(0, -brightness) } : cached.sample;
    try {
      return paletteColors(sample, monitor, geometry, instance);
    } catch (error) {
      this.daemon.logger.warn('Visualizer colors failed', { monitor: monitor.name, instance: instance.name, error: error.message });
      return null;
    }
  }

  // Samples what a monitor shows (in the background, once per item) and recolors its visualizers
  sampleScreen(name) {
    const screen = this.daemon.screens.get(name);
    const media = screen?.media;
    if (!media || this.daemon.samples.get(name)?.mediaId === media.id || this.daemon.sampling.get(name)?.mediaId === media.id) {
      return this.daemon.sampling.get(name)?.done ?? Promise.resolve();
    }
    const done = (async () => {
      try {
        const sample = await this.daemon.samplePalette(media, screen.monitor);
        // A newer item may have loaded meanwhile; its own sampling recolors
        if (this.daemon.screens.get(name)?.media?.id !== media.id) return;
        this.daemon.samples.set(name, { mediaId: media.id, sample });
        await this.daemon.visualizers.recolor?.(name);
        await this.daemon.writeState();
      } catch (error) {
        this.daemon.logger.warn('Sampling the wallpaper for visualizer colors failed', { monitor: name, mediaId: media.id, error: error.message });
      } finally {
        if (this.daemon.sampling.get(name)?.mediaId === media.id) this.daemon.sampling.delete(name);
      }
    })();
    this.daemon.sampling.set(name, { mediaId: media.id, done });
    return done;
  }
}
