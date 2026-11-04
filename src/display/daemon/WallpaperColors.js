import { mainColors, paletteColors, shownAverage, stripPixels } from '../../visualizer/palette.js';
import { resolveArea } from '../../visualizer/settings.js';

const hex = color => `#${color.map(value => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')).join('')}`;

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
    // sleeve picks its own text colors from what is behind the lyrics, in the shape an overlay gets
    if (instance.engine === 'sleeve') {
      const { lyricsArea } = instance.sleeve;
      return this.overlayColors(monitor, lyricsArea ? resolveArea(lyricsArea, geometry) : geometry);
    }
    // A fixed palette pipes its own colors
    if (instance.palette && instance.palette.source !== 'wallpaper') return null;
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

  // What an overlay window has behind it, for the program drawing it to pick readable colors:
  // { background, main: [{ color, share }] }, background being the average shown under the window (after the
  // current dim) and main the wallpaper's main colors there, largest share first, as #rrggbb. null while
  // nothing is known, as for colorsFor (sampling starts and the state is written again once it is done).
  overlayColors(monitor, geometry) {
    const media = this.daemon.screens.get(monitor.name)?.media;
    if (!media) return null;
    const cached = this.daemon.samples.get(monitor.name);
    if (cached?.mediaId !== media.id) {
      this.sampleScreen(monitor.name);
      return null;
    }
    const brightness = this.daemon.screens.get(monitor.name)?.brightness;
    const dim = typeof brightness === 'number' ? Math.max(0, -brightness) : cached.sample.dim;
    const pixels = stripPixels(cached.sample, monitor, geometry);
    if (!pixels.length) return null;
    return {
      background: hex(shownAverage(pixels, dim)),
      main: mainColors(pixels).map(({ color, share }) => ({ color: hex(color), share: Math.round(share * 1000) / 1000 }))
    };
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
