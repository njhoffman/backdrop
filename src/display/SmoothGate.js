import os from 'os';

// display.smooth_idle_load, smooth_idle_minutes and smooth_stop_load when unset
export const SMOOTH_IDLE_LOAD = 0.25;
export const SMOOTH_IDLE_MINUTES = 10;
export const SMOOTH_STOP_LOAD = 0.75;

// Whether smoothing (RIFE, minutes of CPU per chunk) may run, from the load average per CPU, apart from the load
// section: it opens once the 5-minute average has stayed under smooth_idle_load for smooth_idle_minutes, and closes
// when the 1-minute average goes over smooth_stop_load. The gap matters: RIFE on the CPU adds about two to the load
// by itself, so one threshold would let a job close the gate it opened, and open it again minutes later.
// smooth_idle_load null leaves the gate open.
export class SmoothGate {
  constructor({ settings, loadavg = os.loadavg, cpus = os.availableParallelism(), now = Date.now }) {
    this.settings = settings;
    this.loadavg = loadavg;
    this.cpus = Math.max(1, cpus);
    this.now = now;
    this.open = false;
    // Since when the 5-minute average has been under the idle threshold, while closed
    this.lowSince = null;
    // The last reading, per CPU: { one, five }
    this.load = null;
  }

  get limits() {
    const display = this.settings();
    return {
      idle: display.smooth_idle_load === undefined ? SMOOTH_IDLE_LOAD : display.smooth_idle_load,
      minutes: display.smooth_idle_minutes ?? SMOOTH_IDLE_MINUTES,
      stop: display.smooth_stop_load ?? SMOOTH_STOP_LOAD
    };
  }

  // Whether a job may run: open, or no gate (smooth_idle_load null), which needs no reading
  get allowed() {
    return this.open || this.limits.idle === null;
  }

  // One reading; returns whether the gate is open after it
  check() {
    const { idle, minutes, stop } = this.limits;
    const [one, five] = this.loadavg();
    this.load = { one: one / this.cpus, five: five / this.cpus };
    if (idle === null) {
      this.open = true;
      this.lowSince = null;
      return this.open;
    }
    if (this.open) {
      if (this.load.one > stop) this.open = false;
      return this.open;
    }
    if (this.load.five >= idle) {
      this.lowSince = null;
      return this.open;
    }
    const at = this.now();
    this.lowSince ??= at;
    if (at - this.lowSince >= minutes * 60_000) {
      this.open = true;
      this.lowSince = null;
    }
    return this.open;
  }

  // For state.json: whether it is open, since when the load has been low while closed, the last reading per CPU and
  // the thresholds (per CPU)
  summary() {
    const { idle, minutes, stop } = this.limits;
    return { open: this.open, low_since: this.lowSince, load: this.load, cpus: this.cpus, idle_load: idle, idle_minutes: minutes, stop_load: stop };
  }
}
