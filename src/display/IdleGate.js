import os from 'os';

// display.smooth_idle_load, smooth_idle_minutes and smooth_stop_load when unset
export const SMOOTH_IDLE_LOAD = 0.25;
export const SMOOTH_IDLE_MINUTES = 10;
export const SMOOTH_STOP_LOAD = 0.75;
// display.bounce_idle_load (null: reversing waits only for the load section), bounce_idle_minutes and bounce_stop_load
export const BOUNCE_IDLE_LOAD = null;
export const BOUNCE_IDLE_MINUTES = 10;
export const BOUNCE_STOP_LOAD = 0.75;

// How often the daemon reads a gate
export const GATE_INTERVAL_MS = 15_000;

// The display keys of each gate, with their defaults
const GATES = {
  smooth: { idle: SMOOTH_IDLE_LOAD, minutes: SMOOTH_IDLE_MINUTES, stop: SMOOTH_STOP_LOAD },
  bounce: { idle: BOUNCE_IDLE_LOAD, minutes: BOUNCE_IDLE_MINUTES, stop: BOUNCE_STOP_LOAD }
};

// Whether background encodes of one kind (smooth: RIFE, minutes of CPU per chunk; bounce: reversed copies) may run,
// from the load average per CPU, apart from the load section: it opens once the 5-minute average has stayed under
// <kind>_idle_load for <kind>_idle_minutes, and closes when the 1-minute average goes over <kind>_stop_load. The gap
// matters: RIFE on the CPU adds about two to the load by itself, so one threshold would let a job close the gate it
// opened, and open it again minutes later. <kind>_idle_load null leaves the gate open.
export class IdleGate {
  constructor({ kind, settings, loadavg = os.loadavg, cpus = os.availableParallelism(), now = Date.now }) {
    if (!GATES[kind]) throw new Error(`Unknown idle gate: ${kind}`);
    this.kind = kind;
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
    const defaults = GATES[this.kind];
    const idle = display[`${this.kind}_idle_load`];
    return {
      idle: idle === undefined ? defaults.idle : idle,
      minutes: display[`${this.kind}_idle_minutes`] ?? defaults.minutes,
      stop: display[`${this.kind}_stop_load`] ?? defaults.stop
    };
  }

  // Whether a job may run: open, or no gate (<kind>_idle_load null), which needs no reading
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
