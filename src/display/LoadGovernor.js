import os from 'os';

// What the system load allows, lightest restriction first: everything, images only, nothing
export const LOAD_LEVELS = ['normal', 'image', 'off'];
const WINDOWS = { 1: 0, 5: 1, 15: 2 };

const rank = level => LOAD_LEVELS.indexOf(level);

// Decides from the load average what may be shown (the load section of the config). It knows nothing of mpv:
// the wallpaper follows it through src/display/daemon/LoadShedding.js, and the screensaver is to do the same.
//
// Load has to stay over a threshold for `sustain` seconds before the level drops, straight to the worst one
// that held that long, so a short burst does nothing. It has to stay under threshold x resume_ratio for
// `resume_after` seconds before the level recovers, one step at a time with the wait starting again at each
// step, so a change that brings the load back up shows before the next one.
export class LoadGovernor {
  constructor({ settings, loadavg = os.loadavg, now = Date.now }) {
    this.settings = settings;
    this.loadavg = loadavg;
    this.now = now;
    this.level = 'normal';
    this.value = null;
    this.overSince = {};
    this.underSince = null;
  }

  threshold(level) {
    const { image_above: image, off_above: off } = this.settings();
    return { image, off }[level] ?? null;
  }

  // The levels whose thresholds the load is over now, lightest first
  levelsOver(value) {
    return ['image', 'off'].filter(level => this.threshold(level) !== null && value > this.threshold(level));
  }

  read() {
    return this.loadavg()[WINDOWS[this.settings().window]];
  }

  // The level for the load right now, ignoring how long it has been there: for a start, or a switch to enabled
  // with nothing on screen to protect from a burst
  begin() {
    this.overSince = {};
    this.underSince = null;
    if (!this.settings().enabled) {
      this.value = null;
      this.level = 'normal';
      return this.level;
    }
    this.value = this.read();
    this.level = this.levelsOver(this.value).at(-1) ?? 'normal';
    return this.level;
  }

  // The level after one reading
  check() {
    const settings = this.settings();
    if (!settings.enabled) return this.begin();
    const at = this.now();
    this.value = this.read();

    const over = this.levelsOver(this.value);
    for (const level of ['image', 'off']) {
      if (over.includes(level)) this.overSince[level] ??= at;
      else delete this.overSince[level];
    }
    const held = over.filter(level => at - this.overSince[level] >= settings.sustain * 1000).at(-1);
    if (held && rank(held) > rank(this.level)) {
      this.underSince = null;
      this.level = held;
      return this.level;
    }

    if (this.level === 'normal') return this.level;
    const threshold = this.threshold(this.level);
    if (threshold !== null && this.value >= threshold * settings.resume_ratio) {
      this.underSince = null;
      return this.level;
    }
    this.underSince ??= at;
    if (at - this.underSince >= settings.resume_after * 1000) {
      this.level = this.stepUp();
      this.underSince = null;
    }
    return this.level;
  }

  // The next lighter level with a threshold, since one without can never have been chosen for the load
  stepUp() {
    return this.level === 'off' && this.threshold('image') !== null ? 'image' : 'normal';
  }

  // For state.json and status; null with the section off
  summary() {
    const settings = this.settings();
    if (!settings.enabled) return null;
    return {
      level: this.level,
      value: this.value,
      window: settings.window,
      // The threshold that decides this level, and the one the load has to fall under to leave it
      limit: this.threshold(this.level === 'normal' ? 'image' : this.level) ?? this.threshold('off'),
      resume_below: this.level === 'normal' || this.threshold(this.level) === null ? null : Number((this.threshold(this.level) * settings.resume_ratio).toFixed(2))
    };
  }
}
