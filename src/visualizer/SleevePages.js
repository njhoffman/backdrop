import { DEFAULT_VEIL, scaleVeil, veilStrength } from './palette.js';

// sleeve's pages as VisualizerManager runs them: what each shows (`sleeve ctl display`), the veil worked out from
// the wallpaper for a `background: auto`, a still color for a cover while the system is busy, and hiding the lyrics
// in silence unless sleeved says a song plays (on another device). Given the manager, whose state (entries,
// lightened, songPlaying, sleeved) stays on it; its methods forward here.

// What sleeve can change on a running page; an option set at its start and now unset cannot be, since a
// reset goes back to the start options
const SLEEVE_LOOK = ['now', 'nowPosition', 'lyricsAlign', 'lyricsArea', 'nowArea', 'background'];
// style is a map that sleeve merges name by name: compared by its content, and each name a start option of its own
const sameStyle = (from, to) => JSON.stringify(Object.entries(from ?? {}).sort()) === JSON.stringify(Object.entries(to ?? {}).sort());
export const changedLook = (from, to) => SLEEVE_LOOK.some(key => from?.[key] !== to?.[key]) || !sameStyle(from?.style, to?.style);
export const lostStartOption = (started, next) => SLEEVE_LOOK.some(key => started?.[key] && !next?.[key])
  || Object.keys(started?.style ?? {}).some(name => !next?.style?.[name]);
// The style to send for a change from one look to the next: the next one's, and an empty value for each name it drops,
// since sleeve keeps a name an earlier change set until told otherwise
export function styleChange(from, to) {
  const dropped = Object.keys(from ?? {}).filter(name => !(name in (to ?? {})));
  const style = { ...Object.fromEntries(dropped.map(name => [name, ''])), ...to };
  return Object.keys(style).length ? style : null;
}

// What a cover becomes while the system is loaded: a moving cover can cost a sixth of the GPU, a color a fraction of that
const STILL_BACKGROUND = '#0a0f1a';
export function stillBackground(background) {
  const blend = /^cover@(.+)$/.exec(background ?? '');
  if (blend) return `${STILL_BACKGROUND}${Math.round(Number(blend[1]) * 255).toString(16).padStart(2, '0')}`;
  return background === 'cover' ? STILL_BACKGROUND : background;
}

export class SleevePages {
  constructor(manager) {
    this.manager = manager;
  }

  get sleeveEntries() {
    return [...this.manager.entries.values()].filter(entry => entry.instance.engine === 'sleeve');
  }

  // An instance's sleeve settings as they should show now
  shownLook(sleeve, entry) {
    const strength = veilStrength(sleeve.background);
    if (strength !== null) return { ...sleeve, background: scaleVeil(entry.veil ?? DEFAULT_VEIL, strength) };
    return this.manager.lightened ? { ...sleeve, background: stillBackground(sleeve.background) } : sleeve;
  }

  // The system load turned the lightened state on or off: covers become a still color, or move again
  lighten(on) {
    for (const entry of this.manager.entries.values()) {
      const background = entry.instance.sleeve?.background;
      if (background?.startsWith('cover')) this.display(entry, { look: { background: on ? stillBackground(background) : background } });
    }
  }

  // Watches sleeved while a sleeve instance can run: when it restarts it has forgotten what it was told
  watch() {
    const manager = this.manager;
    const wanted = manager.active && !manager.stopping && (manager.settings?.instances ?? []).some(instance => instance.engine === 'sleeve');
    if (!wanted) {
      manager.sleeved?.stop();
      manager.songPlaying = false;
      return;
    }
    manager.sleeved ??= manager.sleevedWatcher({
      onHello: () => manager.remindSleeved(), logger: manager.logger,
      onMessage: message => {
        if (message?.type === 'playback') manager.noteSong(message.playback?.state === 'playing');
      },
      onClose: () => manager.noteSong(false)
    });
    manager.sleeved.start();
  }

  // sleeved said whether a song plays: in silence that shows or hides the lyrics
  noteSong(playing) {
    if (playing === this.manager.songPlaying) return;
    this.manager.songPlaying = playing;
    if (this.manager.silenced) this.show();
  }

  // Shows or hides every running sleeve page for sleeveShown, when that changed since it was last told
  show() {
    const shown = this.manager.sleeveShown;
    for (const entry of this.sleeveEntries) {
      if (entry.shown === shown) continue;
      entry.shown = shown;
      this.display(entry, { visible: shown });
    }
  }

  // Sends sleeved what it should know of each running page: the look, which it forgets on a restart, and hidden for
  // silence. Harmless when it has forgotten nothing, as at the first hello.
  remind() {
    for (const entry of this.sleeveEntries) {
      entry.shown = this.manager.sleeveShown;
      this.display(entry, { look: this.shownLook(entry.instance.sleeve, entry), ...(entry.shown ? {} : { visible: false }) });
    }
  }

  // A page just started: sleeved outlives its pages and remembers changes by their name, which would win over the
  // start options, so it is reset, hidden in silence, and given a still cover while the system is busy
  started(entry) {
    const { instance } = entry;
    const covered = this.manager.lightened && instance.sleeve.background?.startsWith('cover');
    entry.shown = this.manager.sleeveShown;
    this.display(entry, { reset: true, ...(entry.shown ? {} : { visible: false }), ...(covered ? { look: this.shownLook(instance.sleeve, entry) } : {}) });
  }

  // Tells a running sleeve page about a change. In the background and best effort: without sleeved there is
  // nothing on the page to change (status 2), and it starts with the start options when sleeved appears. One at a
  // time per page, in the order sent: sleeved's hello and the playing song arrive together, and a --hide from the
  // first landing after the --show from the second would leave the lyrics hidden through the song.
  display(entry, change) {
    const { file, args } = entry.adapter.display(entry.monitor, change);
    entry.displaying = (entry.displaying ?? Promise.resolve()).then(() => this.manager.exec(file, args)).catch(error => {
      if (error.code === 2) this.manager.logger.debug('sleeved is not running', { instance: entry.instance.name });
      else this.manager.logger.warn('sleeve ctl display failed', { instance: entry.instance.name, error: error.message });
    });
    return entry.displaying;
  }

  // Works out a sleeve `auto` background again; a list of what to wait for, empty when it stays as it is
  reveil(entry) {
    const strength = veilStrength(entry.instance.sleeve?.background);
    if (strength === null) return [];
    const veil = this.manager.veilFor(entry.monitor, entry.geometry, entry.instance.sleeve.lyricsArea);
    if (!veil || veil === entry.veil) return [];
    entry.veil = veil;
    this.manager.logger.info('Visualizer veil', { monitor: entry.monitor.name, instance: entry.instance.name, veil });
    return [this.display(entry, { look: { background: scaleVeil(veil, strength) } })];
  }
}
