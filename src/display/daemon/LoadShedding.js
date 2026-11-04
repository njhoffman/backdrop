import { LoadGovernor } from '../LoadGovernor.js';
import { setModeHold } from '../Playlist.js';
import { notifyMode, notifyLoad } from '../../utils/notify.js';

// Videos become images and then everything stops while the system load is high (the load section), for a Daemon
// (passed in). The user's own choices stay apart from this: the saved mode (held by setModeHold) and
// daemon.wallpaper and the visualizer's enabled state, which also decide whether the daemon has anything left to
// run, so nothing here can stop the daemon or turn a part back on that was turned off by hand.
export class LoadShedding {
  constructor(daemon, { loadavg } = {}) {
    this.daemon = daemon;
    this.governor = new LoadGovernor({
      settings: () => daemon.config.get().load,
      now: () => daemon.now(),
      ...(loadavg ? { loadavg } : {})
    });
  }

  get level() {
    return this.governor.level;
  }

  // Whether the load has everything off now
  get off() {
    return this.level === 'off';
  }

  summary() {
    return this.governor.summary();
  }

  // Before anything starts: the level for the load now, which what starts next follows. A hold left by a
  // daemon that crashed is replaced here.
  async begin() {
    const level = this.governor.begin();
    this.hold(level);
    if (level === 'off') await this.daemon.visualizers.setSuspended(true);
    if (level !== 'normal') await this.announce(level);
  }

  // One reading; a change of level is applied here, so call this through the daemon's queue
  async check() {
    if (this.daemon.stopping) return;
    const previous = this.level;
    const level = this.governor.check();
    if (level !== previous) await this.apply(level, previous);
    // Keeps the reading in `status` current
    else if (this.summary()) await this.daemon.writeState();
  }

  // A saved change to the section. Turning it on starts from the load now; other changes take effect at the
  // next reading except for turning it off, which ends any restriction at once.
  async reconfigure(wasEnabled) {
    const previous = this.level;
    const level = wasEnabled ? this.governor.check() : this.governor.begin();
    if (level !== previous) await this.apply(level, previous);
    else await this.daemon.writeState();
  }

  hold(level) {
    setModeHold(this.daemon.database, level === 'normal' ? null : 'image');
  }

  clear() {
    setModeHold(this.daemon.database, null);
  }

  async apply(level, previous) {
    const { daemon } = this;
    const modes = new Map([...daemon.screens.values()].map(screen => [screen, daemon.screenMode(screen.monitor)]));
    this.hold(level);
    daemon.logger.info('Load level changed', { from: previous, to: level, ...this.summary() });

    if (level === 'off') {
      // A monitor being added could otherwise start its wallpaper after this has stopped the others
      await daemon.reconciling;
      await daemon.controls.stopWallpapers();
      await daemon.visualizers.setSuspended(true);
    } else if (previous === 'off') {
      if (daemon.wallpaper) await daemon.controls.startWallpapers();
      await daemon.visualizers.setSuspended(false);
      await daemon.visualizers.restackAll();
    } else {
      for (const [screen, mode] of modes) {
        if (daemon.stopping || daemon.screens.get(screen.monitor.name) !== screen || daemon.screenMode(screen.monitor) === mode) continue;
        try {
          await daemon.loadScreenPlaylist(screen);
        } catch (error) {
          daemon.logger.warn('Failed to change the playlist for the load', { monitor: screen.monitor.name, error: error.message });
        }
      }
    }
    await daemon.writeState();
    await this.announce(level, previous);
  }

  async announce(level, previous) {
    const { daemon } = this;
    const load = Number(this.governor.value ?? 0).toFixed(1);
    const message = {
      normal: `Load ${load}: back to normal`,
      image: previous === 'off' ? `Load ${load}: back on, images only` : `Load ${load}: images only`,
      off: `Load ${load}: wallpaper off until it falls`
    }[level];
    daemon.logger.info(message);
    let mode;
    try {
      mode = notifyMode(daemon.config.get().display);
    } catch {
      return;
    }
    if (mode !== 'off') await notifyLoad(message, { logger: daemon.logger });
  }
}
