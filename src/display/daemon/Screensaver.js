import fs from 'fs-extra';
import { screensaverPath } from '../runtimeFiles.js';
import { enterWorkspaces, DEFAULT_WORKSPACE } from '../../utils/workspace.js';
import { run as defaultRun } from '../Monitors.js';
import { TrackWatcher } from '../trackWatcher.js';
import { SleevedWatcher, hasLyrics } from '../../visualizer/sleeved.js';

// The i3 binding mode the config defines for this, holding Escape and the keys that still work: only a binding
// can catch Escape with no window focused
export const I3_MODE = 'screensaver';
export const IDLE_CHECK_MS = 15_000;
// How long entering waits for sleeved to say whether the song has lyrics, so the first look is the right one
export const LYRICS_WAIT_MS = 500;

// The screensaver's own looks (screensaver.preset and preset_without_lyrics), kept for it: no preset switch picks
// them while the screensaver is off, so the plain desktop never shows them. settings is the whole config; active
// whether the screensaver is on.
export function reservedPresets(settings, active) {
  if (active) return [];
  const { preset = null, preset_without_lyrics: withoutLyrics = null } = settings.screensaver ?? {};
  return [preset, withoutLyrics].filter(Boolean);
}

export const reservedMessage = name => `${name} is the screensaver's look and shows only in it (backdrop screensaver on)`;

const runHooks = async (commands, run, logger) => {
  for (const command of commands ?? []) {
    try {
      await run('sh', ['-c', command]);
    } catch (error) {
      logger?.warn('Screensaver command failed', { command, error: error.message });
    }
  }
};

// Puts the desktop back from what a daemon recorded on entering, for a daemon that is gone: the workspaces, the
// i3 mode and on_leave. Resolves to whether there was anything to put back.
export async function restoreDesktop(runtimeDir, { run = defaultRun, logger } = {}) {
  const file = screensaverPath(runtimeDir);
  const saved = await fs.readJson(file).catch(() => null);
  if (!saved) return false;
  await run('i3-msg', ['mode', 'default']).catch(error => logger?.debug('No i3 mode to leave', { error: error.message }));
  await runHooks(saved.onLeave, run, logger);
  if (saved.restore) await run('i3-msg', [saved.restore]).catch(error => logger?.warn('Failed to restore i3 workspaces', { error: error.message }));
  await fs.remove(file);
  return true;
}

// Screensaver mode, for a Daemon (passed in): an empty workspace on every output with nothing but the daemon's
// layers, its own visualizer preset, and the i3 mode that keeps only a few keys. It ends only by asking (Escape
// or the toggle in that mode), so rating from a menu cannot end it. What it changed is recorded in a file, so a
// crashed daemon's next start, or `backdrop screensaver off` without one, can put the desktop back. While it runs,
// a media player starting another song moves every monitor to its next item (screensaver.next_on_song).
export class Screensaver {
  constructor(daemon, { watchTracks = options => new TrackWatcher(options), followLyrics = options => new SleevedWatcher(options), lyricsWait = LYRICS_WAIT_MS } = {}) {
    this.daemon = daemon;
    this.active = null;
    this.saved = null;
    this.watchTracks = watchTracks;
    this.tracks = null;
    this.followLyrics = followLyrics;
    this.lyricsWait = lyricsWait;
    this.lyricsWatcher = null;
    // Whether the song has lyrics, from sleeved: null until it says
    this.lyrics = null;
    // The preset it shows, preset or preset_without_lyrics
    this.shown = null;
  }

  // The look for what sleeved last said: preset_without_lyrics for a song without lyrics (sleeved not running
  // included), else preset
  lookFor(lyrics) {
    const { preset, preset_without_lyrics: withoutLyrics } = this.settings;
    return lyrics === false && withoutLyrics ? withoutLyrics : preset;
  }

  // Follows sleeved while on; resolves once it has said whether the song has lyrics, or after lyricsWait
  startLyrics() {
    this.lyrics = null;
    return new Promise(resolve => {
      let entering = true;
      const entered = () => {
        entering = false;
        resolve();
      };
      const timer = setTimeout(entered, this.lyricsWait);
      // While entering, the answer only picks the first look, which enter shows
      const decided = lyrics => {
        if (entering) {
          this.lyrics = lyrics;
          clearTimeout(timer);
          entered();
          return undefined;
        }
        return this.daemon.enqueue(() => this.lyricsChanged(lyrics));
      };
      this.lyricsWatcher = this.followLyrics({
        logger: this.daemon.logger,
        onMessage: message => {
          const lyrics = hasLyrics(message);
          if (lyrics === true || lyrics === false) decided(lyrics);
        },
        onClose: () => decided(false)
      });
      this.lyricsWatcher.start();
    });
  }

  // Switches between the two looks as the song's lyrics come and go; a lookup still out changes nothing
  async lyricsChanged(lyrics) {
    if (!this.active || this.daemon.stopping) return;
    this.lyrics = lyrics;
    const look = this.lookFor(lyrics);
    if (!look || look === this.shown) return;
    this.daemon.logger.info('Screensaver look', { preset: look, lyrics });
    this.shown = look;
    try {
      await this.daemon.visualizers.setPreset(look);
    } catch (error) {
      this.daemon.logger.error('Screensaver visualizer failed', { preset: look, error: error.message });
    }
  }

  get settings() {
    return this.daemon.config.get().screensaver ?? {};
  }

  summary() {
    return this.active ? { active: true, ...this.active } : { active: false };
  }

  async begin() {
    await restoreDesktop(this.daemon.runtimeDir, { run: this.daemon.exec, logger: this.daemon.logger });
  }

  async apply(action) {
    if (action === 'on' || (action === 'toggle' && !this.active)) return this.enter('key');
    return this.leave();
  }

  async enter(trigger) {
    if (this.active) return;
    const { exec: run, logger, visualizers, runtimeDir } = this.daemon;
    const { workspace, preset, on_enter: onEnter, on_leave: onLeave } = this.settings;
    const restore = await enterWorkspaces(workspace ?? DEFAULT_WORKSPACE, { run, logger });
    this.saved = { preset: visualizers.presetOverride, wasOn: visualizers.active };
    await fs.writeJson(screensaverPath(runtimeDir), { restore, onLeave: onLeave ?? [] });
    this.active = { trigger, since: this.daemon.now() };
    logger.info('Screensaver on', { trigger, preset });
    await run('i3-msg', ['mode', I3_MODE]).catch(error => logger.warn('No i3 mode for the screensaver, so Escape will not end it', { error: error.message }));
    await runHooks(onEnter, run, logger);
    this.followSongs();
    // The first look is the one for the song playing, when sleeved says in time
    if (preset && this.settings.preset_without_lyrics) await this.startLyrics();
    this.shown = preset ? this.lookFor(this.lyrics) : null;
    try {
      if (!visualizers.active) await visualizers.setEnabled(true);
      // Each screensaver starts at the looks' own colors
      visualizers.resetCycle?.();
      if (this.shown) await visualizers.setPreset(this.shown);
    } catch (error) {
      logger.error('Screensaver visualizer failed', { preset: this.shown, error: error.message });
    }
  }

  async leave() {
    if (!this.active) return;
    const { exec: run, logger, visualizers, runtimeDir, stopping } = this.daemon;
    const { preset, wasOn } = this.saved;
    this.active = null;
    this.saved = null;
    this.tracks?.stop();
    this.tracks = null;
    this.lyricsWatcher?.stop();
    this.lyricsWatcher = null;
    this.lyrics = null;
    this.shown = null;
    logger.info('Screensaver off');
    await restoreDesktop(runtimeDir, { run, logger });
    // A daemon on its way out stops them anyway
    if (stopping) return;
    try {
      if (this.settings.preset) await visualizers.setPreset(preset);
      if (!wasOn) await visualizers.setEnabled(false);
    } catch (error) {
      logger.error('Screensaver visualizer failed', { error: error.message });
    }
  }

  // Follows songs for as long as it runs; next_on_song is read on each song, so turning it off or on applies at once
  followSongs() {
    const { spawn, logger } = this.daemon;
    this.tracks = this.watchTracks({ spawn, logger, onTrack: song => this.daemon.enqueue(() => this.nextOnSong(song)) });
    this.tracks.start();
  }

  // Every monitor showing the wallpaper moves to its next item, as `backdrop next` does on one
  async nextOnSong(song) {
    if (!this.active || this.settings.next_on_song === false || this.daemon.stopping) return;
    const { logger, screens } = this.daemon;
    logger.info('New song, next wallpaper', { player: song.player, title: song.title });
    for (const screen of screens.values()) {
      try {
        await screen.client.command('playlist-next', 'force');
      } catch (error) {
        logger.warn('Failed to change the wallpaper for a new song', { monitor: screen.monitor?.name, error: error.message });
      }
    }
  }

  // Starts it once the desktop has been idle for idle_minutes, with screensaver.idle on and the load under max_load
  async checkIdle() {
    const { idle, idle_minutes: minutes, max_load: maxLoad } = this.settings;
    const { logger, load } = this.daemon;
    if (!idle || this.active || this.daemon.stopping) return;
    let idleMs;
    try {
      idleMs = Number(await this.daemon.exec('xprintidle', []));
    } catch (error) {
      logger.debug('Cannot read how long the desktop has been idle', { error: error.message });
      return;
    }
    if (!(idleMs >= minutes * 60_000) || load.off) return;
    if (typeof maxLoad === 'number' && load.governor.read() > maxLoad) return;
    await this.enter('idle');
  }
}
