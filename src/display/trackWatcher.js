import readline from 'readline';

const SETTLE_MS = 1000;
const RESTART_DELAY_MS = 5000;
const FORMAT = '{{playerName}}\t{{xesam:artist}}\t{{xesam:title}}';

// Calls onTrack when a media player (MPRIS, through `playerctl --follow`) starts another song, for
// screensaver.next_on_song. Each player's first line is the song it already had, not a change, and a line that
// repeats the player's song (a status or artwork update) is ignored. A player's metadata comes in bursts
// (title, then artist), so one change is reported once they settle. Without playerctl it logs once and stays quiet.
export class TrackWatcher {
  constructor({ spawn, logger, onTrack, settle = SETTLE_MS, restartDelay = RESTART_DELAY_MS }) {
    Object.assign(this, { spawn, logger, onTrack, settle, restartDelay });
    this.songs = new Map();
    this.child = null;
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
    clearTimeout(this.timer);
    clearTimeout(this.restartTimer);
    this.child?.kill('SIGTERM');
    this.child = null;
    this.songs.clear();
  }

  listen() {
    if (this.stopped) return;
    const child = this.spawn('playerctl', ['--all-players', '--follow', 'metadata', '--format', FORMAT], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', error => {
      if (this.warned) return;
      this.warned = true;
      this.logger.warn('Cannot follow songs with playerctl, so a new song does not change the screensaver', { error: error.message });
    });
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', line => this.line(line));
    // playerctl ended (no player bus, or killed): follow again shortly, players already seen keep their song
    child.on('exit', () => {
      if (!this.stopped && this.child === child) this.restartTimer = setTimeout(() => this.listen(), this.restartDelay);
    });
  }

  line(line) {
    const [player, artist = '', title = ''] = line.split('\t');
    if (!player || !title.trim()) return;
    const song = `${artist}\t${title}`;
    const known = this.songs.has(player);
    const before = this.songs.get(player);
    this.songs.set(player, song);
    if (!known || before === song) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.onTrack({ player, artist, title });
    }, this.settle);
  }
}
