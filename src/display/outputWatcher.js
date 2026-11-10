import readline from 'readline';

const SETTLE_MS = 500;
const RESTART_DELAY_MS = 5000;

// Calls onChange when the monitor layout may have changed, from i3's output events (`i3-msg -t subscribe -m
// '["output","tick"]'`): i3 sends one whenever RandR reports a change, so the daemon reads the layout only then
// instead of polling xrandr, whose every query has X re-read each monitor's EDID. Events come in bursts during a mode
// switch, so one change is reported once they settle. i3-msg -m prints events only, not the subscription's reply, so
// the tick event i3 sends to every new subscriber ({"first":true}) is what says it is live: `connected` is true from
// then until i3-msg ends, and the daemon polls again while it is false (another window manager, i3 restarting). A
// subscription that comes back after a gap reports a change, since the layout may have moved meanwhile. Ticks other
// clients send are ignored. Without i3-msg it logs once and stays disconnected.
export class OutputWatcher {
  constructor({ spawn, logger, onChange, settle = SETTLE_MS, restartDelay = RESTART_DELAY_MS }) {
    Object.assign(this, { spawn, logger, onChange, settle, restartDelay });
    this.child = null;
    this.connected = false;
    this.subscribed = 0;
    this.stopped = false;
    this.timer = null;
    this.restartTimer = null;
    this.warned = false;
  }

  start() {
    this.stopped = false;
    this.listen();
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.timer);
    clearTimeout(this.restartTimer);
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  listen() {
    if (this.stopped) return;
    const child = this.spawn('i3-msg', ['-t', 'subscribe', '-m', '["output","tick"]'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', error => {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn('Cannot follow i3 output events, so monitor changes are found by polling xrandr', { error: error.message });
    });
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', line => this.line(line));
    // i3-msg ended (i3 restarting or gone): poll meanwhile, and subscribe again shortly
    child.on('exit', () => {
      if (this.child !== child) return;
      this.connected = false;
      if (!this.stopped) this.restartTimer = setTimeout(() => this.listen(), this.restartDelay);
    });
  }

  line(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    // The tick every new subscription gets; after the first, the layout may have changed while none was live
    if (message.first === true) {
      this.connected = true;
      if (this.subscribed++ > 0) this.changed();
      return;
    }
    // A failed subscription's reply, for an i3-msg that prints it
    if (message.success === false) {
      this.connected = false;
      return;
    }
    if (this.connected && 'change' in message) this.changed();
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.onChange();
    }, this.settle);
  }
}
