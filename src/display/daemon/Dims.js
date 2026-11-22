import { contrastFor } from '../Playlist.js';

// The music dim (visualizer.wallpaper_dim) fades in and out over this long, in DIM_FADE_STEPS contrast changes; mpv
// has no fade for contrast, and each step is one IPC set
export const DIM_FADE_MS = 500;
const DIM_FADE_STEPS = 10;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// What each wallpaper is dimmed by for a Daemon (passed in): an item's own dim, or the music dim while the visualizer
// has sound if that is more, set as mpv's contrast and faded when the music starts or stops (daemon.dimFade ms)
export class Dims {
  constructor(daemon) {
    this.daemon = daemon;
  }

  // The dim an item shows with: its own, or visualizer.wallpaper_dim while music plays if that is more
  shownDim(media) {
    return Math.max(media?.dim ?? 0, this.daemon.visualizers.musicDim ?? 0);
  }

  // Sets every wallpaper's contrast again when the music dim changes, with each item's dim read again
  // (`backdrop dim` may have changed it since it loaded), fading to it (fadeContrast)
  async applyDims() {
    const daemon = this.daemon;
    if (daemon.stopping) return;
    await Promise.all([...daemon.screens.values()].map(async screen => {
      if (!screen.client || !screen.media) return;
      screen.media = daemon.database.getMedia(screen.media.id) ?? screen.media;
      try {
        await this.fadeContrast(screen, contrastFor(this.shownDim(screen.media)));
      } catch (error) {
        daemon.logger.warn('Failed to set contrast', { monitor: screen.monitor.name, error: error.message });
      }
    }));
    await daemon.writeState();
  }

  // Steps a wallpaper's contrast from where mpv has it to target over dimFade ms. A later fade, or a load setting the
  // contrast at once (which clears screen.fade), ends this one where it is.
  async fadeContrast(screen, target) {
    const { dimFade } = this.daemon;
    const fade = {};
    screen.fade = fade;
    const from = screen.contrast ?? await screen.client.getProperty('contrast').catch(() => target);
    const steps = dimFade > 0 && typeof from === 'number' && from !== target ? DIM_FADE_STEPS : 1;
    for (let step = 1; step <= steps; step++) {
      if (screen.fade !== fade || this.daemon.stopping) return;
      await screen.client.setProperty('contrast', step === steps ? target : Math.round(from + (target - from) * step / steps));
      if (step < steps) await sleep(dimFade / steps);
    }
    if (screen.fade === fade) screen.fade = null;
  }
}
