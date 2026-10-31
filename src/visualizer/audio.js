import readline from 'readline';

const RECHECK_DELAY_MS = 100;
const RESTART_DELAY_MS = 2000;

// Whether the visualizer's audio source is playing, for visualizer.only_while_playing. Follows the sound
// server through `pactl subscribe` (PulseAudio, or PipeWire's pulse server) and checks the output's state on
// every sink, source or server change: RUNNING means sound. Sound is reported at once; silence only after
// grace milliseconds of it, so a pause between tracks does not stop the visualizer. When the state cannot be
// read, sound is assumed, so a missing pactl leaves the visualizer running rather than gone.
export class AudioWatcher {
  constructor({ source = 'auto', grace = 10_000, spawn, exec, logger, onChange, restartDelay = RESTART_DELAY_MS, recheckDelay = RECHECK_DELAY_MS }) {
    Object.assign(this, { source, grace, spawn, exec, logger, onChange, restartDelay, recheckDelay });
    this.playing = null;
    this.child = null;
    this.stopped = false;
    this.silenceTimer = null;
    this.recheckTimer = null;
    this.warned = false;
  }

  // Resolves to whether the source plays now, then keeps watching
  async start() {
    this.playing = await this.check();
    this.listen();
    return this.playing;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.recheckTimer);
    this.child?.kill('SIGTERM');
  }

  listen() {
    if (this.stopped) return;
    const child = this.spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', error => this.warn('Cannot watch audio with pactl', error));
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', line => {
        if (/\b(sink|source|server)\b/.test(line)) this.recheck();
      });
    }
    // The sound server restarted or pactl failed: watch again shortly
    child.on('exit', () => {
      if (!this.stopped) setTimeout(() => this.listen(), this.restartDelay);
    });
  }

  // Events come in bursts, so the state is read once they settle
  recheck() {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(async () => this.update(await this.check()), this.recheckDelay);
  }

  update(playing) {
    if (this.stopped) return;
    if (playing) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      if (this.playing !== true) {
        this.playing = true;
        this.onChange(true);
      }
      return;
    }
    if (this.playing === false || this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.stopped) return;
      this.playing = false;
      this.onChange(false);
    }, this.grace);
  }

  // RUNNING state of the source: the default output for auto, else the named sink (a sink's .monitor source
  // names the sink) or source
  async check() {
    try {
      const name = this.source === 'auto'
        ? (await this.exec('pactl', ['get-default-sink'])).trim()
        : this.source.replace(/\.monitor$/, '');
      for (const kind of ['sinks', 'sources']) {
        const row = (await this.exec('pactl', ['list', 'short', kind])).split('\n')
          .map(line => line.split('\t'))
          .find(fields => fields[1] === name || fields[1] === this.source);
        if (row) return row.at(-1).trim() === 'RUNNING';
      }
      this.warn('Audio source not found, assuming it plays', new Error(`no sink or source named ${name}`));
      return true;
    } catch (error) {
      this.warn('Cannot read the audio state, assuming it plays', error);
      return true;
    }
  }

  warn(message, error) {
    if (this.warned) return;
    this.warned = true;
    this.logger?.warn(message, { source: this.source, error: error.message });
  }
}
