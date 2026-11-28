import readline from 'readline';
import { readActivity } from './streams.js';

const RECHECK_DELAY_MS = 100;
const RESTART_DELAY_MS = 2000;

// Follows what this machine's music players play (streams.js) through `pactl subscribe`, reading the snapshot again
// once a burst of sink and sink input events settles, and calls onChange(snapshot) whenever it differs from the one
// reported before: music starting at once, a volume or mute change at once, but music stopping only after grace
// milliseconds of it, so a pause between tracks does not hand the audio to the other machine. A snapshot that
// cannot be read counts as nothing playing.
export class MusicWatcher {
  constructor({
    players, grace = 10_000, spawn, exec, logger, onChange,
    restartDelay = RESTART_DELAY_MS, recheckDelay = RECHECK_DELAY_MS
  }) {
    Object.assign(this, { players, grace, spawn, exec, logger, onChange, restartDelay, recheckDelay });
    this.snapshot = null;
    this.reported = null;
    this.child = null;
    this.stopped = false;
    this.silenceTimer = null;
    this.recheckTimer = null;
    this.restartTimer = null;
    this.warned = false;
  }

  // Resolves to the first snapshot, then keeps watching
  async start() {
    this.report(await this.read());
    this.listen();
    return this.snapshot;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.recheckTimer);
    clearTimeout(this.restartTimer);
    this.child?.kill('SIGTERM');
  }

  listen() {
    if (this.stopped) return;
    const child = this.spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', error => this.warn('Cannot watch the music players with pactl', error));
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', line => {
        if (/\b(sink|sink-input|server)\b/.test(line)) this.recheck();
      });
    }
    // The sound server restarted or pactl failed: watch again shortly, and read what plays now
    child.on('exit', () => {
      if (this.stopped) return;
      this.restartTimer = setTimeout(() => {
        this.listen();
        this.recheck();
      }, this.restartDelay);
    });
  }

  recheck() {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(async () => this.update(await this.read()), this.recheckDelay);
  }

  async read() {
    try {
      const snapshot = await readActivity(this.exec, { players: this.players });
      this.warned = false;
      return snapshot;
    } catch (error) {
      this.warn('Cannot read the music players, counting them as silent', error);
      return { active: false, player: null, sink: null, volume: null, muted: false };
    }
  }

  update(snapshot) {
    if (this.stopped) return;
    if (snapshot.active || !this.reported?.active) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      this.report(snapshot);
      return;
    }
    // Music stopped: the snapshot that played stands until the grace is over, unless music comes back first
    this.pending = snapshot;
    if (this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (!this.stopped) this.report(this.pending);
    }, this.grace);
  }

  report(snapshot) {
    this.snapshot = snapshot;
    if (JSON.stringify(snapshot) === JSON.stringify(this.reported)) return;
    this.reported = snapshot;
    this.onChange?.(snapshot);
  }

  warn(message, error) {
    if (this.warned) return;
    this.warned = true;
    this.logger?.warn(message, { error: error.message });
  }
}
