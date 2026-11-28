import { AUTO_RULES, choosePreset, imageStats, imageTags } from '../../visualizer/autoRules.js';
import { sampleCover } from '../../visualizer/palette.js';
import { SleevedWatcher, hasLyrics } from '../../visualizer/sleeved.js';
import { WorkspaceWatcher } from '../workspaceWatcher.js';

// The settings that keep automatic preset picking on or off and the image it follows, across restarts
export const AUTO_SETTING = 'visualizer_auto';
export const PREFER_SETTING = 'visualizer_prefer';
export const DEFAULT_PREFER = 'wallpaper';

// Picks the visualizer preset by itself while on (`backdrop visualizer auto`, off by default), for a Daemon (passed
// in): from the moment (full screen, meaning the screensaver or no window on any monitor's visible workspace; else
// behind windows), whether the song has timed lyrics (sleeved), the image preferred (the cover or the wallpaper,
// `backdrop visualizer prefer`) and what that image is like, through the rules in autoRules.js (the config's
// visualizer.auto.rules first). It switches only when the pick changes. A preset kept in the menu's load holds until
// the next song or the next change between full screen and behind windows; presets only tried there, or set from the
// CLI, do not. While on, the screensaver leaves its looks to it.
export class AutoPreset {
  constructor(daemon, {
    watchWorkspaces = options => new WorkspaceWatcher(options),
    followLyrics = options => new SleevedWatcher(options),
    coverUrl = async () => (await daemon.exec('playerctl', ['metadata', 'mpris:artUrl'])).trim(),
    sampleArt = url => sampleCover(url)
  } = {}) {
    Object.assign(this, { daemon, watchWorkspaces, followLyrics, coverUrl, sampleArt });
    this.workspaces = null;
    this.lyricsWatcher = null;
    // Outputs whose visible workspace holds a window; null until i3 has said (every monitor counts as covered)
    this.occupied = null;
    this.track = undefined;
    this.lyrics = null;
    this.cover = null;
    this.choice = null;
    this.held = null;
    this.running = false;
  }

  get enabled() {
    return this.daemon.database.getSetting(AUTO_SETTING, false) === true;
  }

  get prefer() {
    const value = this.daemon.database.getSetting(PREFER_SETTING, DEFAULT_PREFER);
    return value === 'cover' ? 'cover' : 'wallpaper';
  }

  // Starts following the moment when on; the daemon calls it once its visualizers are up
  begin() {
    if (this.running || !this.enabled) return;
    this.running = true;
    const { daemon } = this;
    this.workspaces = this.watchWorkspaces({
      spawn: daemon.spawn, exec: daemon.exec, logger: daemon.logger,
      onChange: occupied => daemon.enqueue(() => this.workspacesChanged(occupied))
    });
    this.workspaces.start();
    this.lyricsWatcher = this.followLyrics({
      logger: daemon.logger,
      onMessage: message => {
        if (message?.type !== 'lyrics') return undefined;
        const lyrics = hasLyrics(message);
        return daemon.enqueue(() => this.lyricsMessage(message.key ?? null, lyrics));
      },
      onClose: () => daemon.enqueue(() => this.lyricsMessage(this.track ?? null, false))
    });
    this.lyricsWatcher.start();
  }

  end() {
    this.running = false;
    this.workspaces?.stop();
    this.workspaces = null;
    this.lyricsWatcher?.stop();
    this.lyricsWatcher = null;
    this.occupied = null;
    this.track = undefined;
    this.lyrics = null;
    this.cover = null;
    this.choice = null;
    this.held = null;
  }

  // `backdrop visualizer auto on|off|toggle`
  async setEnabled(value) {
    const on = value === 'toggle' ? !this.enabled : value === true || value === 'on';
    this.daemon.database.setSetting(AUTO_SETTING, on);
    this.daemon.logger.info(on ? 'Automatic preset on' : 'Automatic preset off');
    if (on) {
      this.begin();
      await this.decide();
    } else {
      this.end();
    }
  }

  // `backdrop visualizer prefer cover|wallpaper|toggle`
  async setPrefer(value) {
    const prefer = value === 'toggle' ? (this.prefer === 'cover' ? 'wallpaper' : 'cover') : value;
    if (prefer !== 'cover' && prefer !== 'wallpaper') throw new Error(`prefer must be cover, wallpaper or toggle, not ${value}`);
    this.daemon.database.setSetting(PREFER_SETTING, prefer);
    this.daemon.logger.info('Automatic preset follows', { prefer });
    await this.decide();
  }

  // The view: full screen with the screensaver on or no monitor showing a window, else behind windows
  get view() {
    if (this.daemon.screensaver?.active) return 'fullscreen';
    if (!this.occupied) return 'background';
    const names = [...this.daemon.monitors.keys()];
    return names.some(name => this.occupied.has(name)) ? 'background' : 'fullscreen';
  }

  // A preset kept in the menu's load (a hold control request): it holds until the next song or a change of view
  pickedByHand(preset) {
    if (!this.running) return;
    this.held = { preset, track: this.track, view: this.view };
  }

  async workspacesChanged(occupied) {
    this.occupied = occupied;
    await this.decide();
  }

  // The screensaver came on or went off: the view may have changed
  async screensaverChanged() {
    await this.decide();
  }

  // A sleeved lyrics message: key names the song (a new one samples its cover), lyrics true, false or null (looking)
  async lyricsMessage(key, lyrics) {
    if (!this.running) return;
    const newSong = key !== this.track;
    this.track = key;
    if (lyrics === true || lyrics === false) this.lyrics = lyrics;
    else if (newSong) this.lyrics = null;
    if (newSong) await this.sampleTheCover();
    await this.decide();
  }

  // A wallpaper loaded on a monitor: sampled (once per item) when it is the image followed
  async wallpaperLoaded(name) {
    if (!this.running || this.prefer !== 'wallpaper') return;
    await this.daemon.sampleScreen(name);
    await this.decide();
  }

  async sampleTheCover() {
    this.cover = null;
    try {
      const url = await this.coverUrl();
      const pixels = url ? await this.sampleArt(url) : null;
      this.cover = pixels ? imageStats(pixels) : null;
    } catch (error) {
      this.daemon.logger.debug?.('No cover for the automatic preset', { error: error.message });
    }
  }

  // What the wallpaper is like: the first monitor's sample, or null while none is sampled
  get wallpaper() {
    for (const name of this.daemon.monitors.keys()) {
      const pixels = this.daemon.samples.get(name)?.sample?.pixels;
      if (pixels) return imageStats(pixels);
    }
    return null;
  }

  get moment() {
    const prefer = this.prefer;
    const stats = prefer === 'cover' ? this.cover : this.wallpaper;
    return { view: this.view, lyrics: this.lyrics, prefer, image: imageTags(stats), stats };
  }

  get rules() {
    return [...(this.daemon.config.get().visualizer?.auto?.rules ?? []), ...AUTO_RULES];
  }

  // Picks again, and switches when the pick is not the preset showing; a preset picked by hand holds meanwhile
  async decide() {
    const { daemon } = this;
    if (!this.running || daemon.stopping) return;
    const moment = this.moment;
    if (this.held) {
      if (this.held.track === this.track && this.held.view === moment.view) return;
      this.held = null;
    }
    const choice = choosePreset(moment, this.rules);
    this.choice = choice ? { ...choice, moment: { view: moment.view, lyrics: moment.lyrics, prefer: moment.prefer, image: moment.image } } : null;
    if (!choice || !daemon.visualizers.active || choice.preset === daemon.visualizers.presetOverride) return;
    daemon.logger.info('Automatic preset', { preset: choice.preset, reason: choice.reason, view: moment.view, lyrics: moment.lyrics, prefer: moment.prefer, image: moment.image });
    try {
      await daemon.visualizers.setPreset(choice.preset);
      await daemon.writeState();
    } catch (error) {
      daemon.logger.error('Automatic preset failed', { preset: choice.preset, error: error.message });
    }
  }

  // For state.json: on or off, the image followed, and the last pick with why
  summary() {
    return {
      enabled: this.enabled,
      prefer: this.prefer,
      preset: this.choice?.preset ?? null,
      reason: this.choice?.reason ?? null,
      held: this.held?.preset ?? null,
      moment: this.choice?.moment ?? null
    };
  }
}
