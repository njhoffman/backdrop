import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readState } from '../display/Daemon.js';
import { reapOrphans } from '../display/children.js';
import { sendControl } from '../display/control.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { readNextFilters, resolveNextFilters } from '../display/nextFilters.js';
import { getMode, getChosenMode, displayMode, eligibleMedia, randomOrder } from '../display/Playlist.js';
import { matchFilters, matchingMedia } from '../library/match.js';
import { formatDecoder } from '../utils/output.js';
import { readWebInfo } from '../web/info.js';
import { mediaJson } from '../utils/mediaView.js';
import { notifyCommand } from '../utils/notify.js';
import { visualizerSettings } from '../visualizer/settings.js';

const ENTRY_POINT = fileURLToPath(new URL('../index.js', import.meta.url));
const START_TIMEOUT_MS = 15_000;
export const PARTS = ['wallpaper', 'visualizer'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The daemon and what its monitors play: starting and stopping it or its parts, navigation, the mode, per-item
// speed, dim and bounce, and the status, returning data rather than printing it, for the CLI (DisplayCommand), the
// menu and the web interface (docs/specs/web.md, D6). Commands that switch what plays announce it (display.notify).
export class DisplayService {
  constructor({
    config, database, logger, control,
    kill = process.kill, spawnProcess = spawn, timeout = START_TIMEOUT_MS,
    reap = runtimeDir => reapOrphans(runtimeDir, { kill, logger })
  }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.control = control ?? new DisplayControl({ config, database });
    this.kill = kill;
    this.spawnProcess = spawnProcess;
    this.timeout = timeout;
    this.reap = reap;
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  // The parts options names (wallpaper, visualizer), or null for the whole daemon
  parts(options = {}) {
    const named = PARTS.filter(part => options[part]);
    return named.length ? named : null;
  }

  // Without parts, starts the daemon with the wallpaper and, if visualizer.enabled, the visualizer; with them,
  // starts only those, or turns them on in a running daemon.
  // Returns { action: 'running', state } | { action: 'changed', state } (null state: it stopped) | { action: 'started', state }
  async start(options = {}) {
    const parts = this.parts(options);
    const running = await readState(this.runtimeDir);
    if (running) {
      if (!parts) return { action: 'running', state: running };
      return { action: 'changed', state: await this.setParts(running, Object.fromEntries(parts.map(part => [part, true]))) };
    }
    // Checked here so a mistake shows to the caller rather than only in the daemon log
    if (parts?.includes('visualizer')) visualizerSettings(this.config.get().visualizer);

    const flags = parts
      ? [parts.includes('wallpaper') ? '--wallpaper' : '--no-wallpaper', parts.includes('visualizer') ? '--visualizer' : '--no-visualizer']
      : [];
    const child = this.spawnProcess(process.execPath, [ENTRY_POINT, 'daemon', ...flags], { detached: true, stdio: 'ignore' });
    child.unref();

    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      const state = await readState(this.runtimeDir);
      if (state) return { action: 'started', state };
      if (child.exitCode !== null) break;
      await sleep(200);
    }
    throw new Error(`Daemon did not start; see ${this.config.get().paths.logfile}`);
  }

  // Without parts, stops the daemon; with them, turns only those off (the daemon stops itself when neither is left).
  // Returns { action: 'reaped', orphans } | { action: 'not-running' } | { action: 'changed', state } | { action: 'stopped' }
  async stop(options = {}) {
    const state = await readState(this.runtimeDir);
    if (!state) {
      // Wallpapers and visualizers a crashed daemon left running are what a stop is wanted for
      const orphans = await this.reap(this.runtimeDir);
      return orphans.length ? { action: 'reaped', orphans } : { action: 'not-running' };
    }
    const parts = this.parts(options);
    if (parts) return { action: 'changed', state: await this.setParts(state, Object.fromEntries(parts.map(part => [part, false]))) };

    this.kill(state.pid, 'SIGTERM');
    await this.waitForExit(state.pid);
    return { action: 'stopped' };
  }

  async waitForExit(pid) {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline && await readState(this.runtimeDir)) {
      await sleep(100);
    }
    if (await readState(this.runtimeDir)) {
      throw new Error(`Daemon (pid ${pid}) did not stop`);
    }
  }

  // Asks the running daemon to switch parts on or off ({ wallpaper, visualizer }); returns its state afterwards, or
  // null when it stopped because nothing was left on
  async setParts(state, change) {
    if (change.visualizer) visualizerSettings(this.config.get().visualizer);
    const current = await this.send(state, change);
    if (current && change.visualizer && current.visualizer.error) throw new Error(`Visualizer off: ${current.visualizer.error}`);
    return current;
  }

  send(state, change) {
    return sendControl(this.runtimeDir, state, change, { kill: this.kill, timeout: this.timeout, logfile: this.config.get().paths.logfile });
  }

  // Stacks marked overlay windows again (`backdrop restack`); returns [{ name, overlays }] per monitor
  async restack() {
    const state = await readState(this.runtimeDir);
    if (!state) throw new Error('The daemon is not running (backdrop start)');
    const current = await this.send(state, { restack: true });
    return (current?.monitors ?? []).map(monitor => ({ name: monitor.name, overlays: monitor.overlays ?? [] }));
  }

  // The daemon, its monitors and what each plays (status --json; format in docs/specs/json.md). cpu_percent, decoder
  // and gpu_memory_bytes are the daemon's recent samples, null until it has them.
  async status() {
    const state = await readState(this.runtimeDir);
    const mode = getMode(this.database);
    const { allow_upscale: allowUpscale } = this.config.get().display;
    const monitors = [];
    for (const monitor of state?.monitors ?? []) {
      const { media, rating } = await this.control.current(monitor.name).catch(() => ({}));
      monitors.push({
        name: monitor.name, width: monitor.width, height: monitor.height,
        eligible: eligibleMedia(this.database, displayMode(this.database, monitor, { allowUpscale }), monitor, { allowUpscale }).length,
        cpu_percent: Number.isFinite(monitor.cpu) ? Math.round(monitor.cpu * 10) / 10 : null,
        decoder: formatDecoder(monitor.hwdec) || null,
        gpu_memory_bytes: Number.isFinite(monitor.gpuMemory) ? monitor.gpuMemory : null,
        visualizer: monitor.visualizer ?? null,
        visualizers: monitor.visualizers ?? (monitor.visualizer ? [monitor.visualizer] : []),
        overlays: monitor.overlays ?? [],
        playing: media ? mediaJson(this.database, media, rating) : null
      });
    }
    const daemon = {
      running: Boolean(state), pid: state?.pid ?? null,
      wallpaper: state ? state.wallpaper !== false : null,
      visualizer: state ? Boolean(state.visualizer?.enabled && !state.visualizer.error) : null,
      // Whether a compositor ran at the visualizer's last placement; null when not checked
      compositor: state?.visualizer?.compositor ?? null,
      // { level, value, window, limit, resume_below }, or null with the load section off
      load: state?.load ?? null,
      // The active preset has visualizer.wallpaper: false, so mpv is stopped whatever wallpaper says
      wallpaper_hidden: Boolean(state?.visualizer?.hidesWallpaper)
    };
    // The screensaver's state while the daemon runs; the running `backdrop web` (its port, never its token)
    const screensaver = state?.screensaver ?? null;
    const info = await readWebInfo(this.runtimeDir);
    const web = info ? { pid: info.pid, port: info.port } : null;
    return { mode, chosen_mode: getChosenMode(this.database), daemon, monitors, screensaver, web, config_warnings: this.config.warnings ?? [] };
  }

  // What options.monitor (or the monitor under the pointer) plays: { monitor, path, media, rating }
  current(options = {}) {
    return this.control.current(options.monitor);
  }

  // Plays the next item. --query, --tag and --keywords jump to a matching item instead, the playlist itself staying as
  // it was; filters, order and durations given here stay in effect until next --clear or a daemon restart.
  // Returns { playing, options }, options being the ones in effect.
  async next(options = {}) {
    // Checked before they are stored, so a mistyped query is not kept
    matchFilters(this.database, options);
    options = await resolveNextFilters(this.runtimeDir, options, {
      persist: true, kill: this.kill, timeout: this.timeout, logfile: this.config.get().paths.logfile
    });
    const random = randomOrder(this.config.get().display, options.random);
    const matches = matchingMedia(this.database, options);
    const playing = await this.control.next(options.monitor, matches ? { random, matches } : { random });
    await this.announce(playing);
    return { playing, options };
  }

  async prev(options = {}) {
    const playing = await this.control.prev(options.monitor);
    await this.announce(playing);
    return { playing, options };
  }

  // The image and video durations in force: { image, video } in seconds, each with whether next or the menu set it
  // (until next --clear or a daemon restart) or it is display.*'s
  async durations() {
    const stored = await readNextFilters(this.runtimeDir);
    const { display } = this.config.get();
    return {
      image: { seconds: stored.image_duration ?? display.image_duration, set: stored.image_duration !== undefined },
      video: { seconds: stored.video_duration ?? display.video_duration, set: stored.video_duration !== undefined }
    };
  }

  // Sets the durations as --image-duration and --video-duration do ({ imageDuration, videoDuration }, times such as
  // 90, 5m), or with clear drops them along with next's stored filters; the daemon applies a change at once.
  // Returns durations().
  async setDurations(options) {
    await resolveNextFilters(this.runtimeDir, options, {
      persist: true, kill: this.kill, timeout: this.timeout, logfile: this.config.get().paths.logfile
    });
    return this.durations();
  }

  // The desktop notification for what a monitor plays after a command switched it (display.notify)
  async announce(playing) {
    await notifyCommand(this.config, this.database, playing, { logger: this.logger });
  }

  // The playing item's speed, dim and bounce, applied now and stored for its later plays
  speed(value, options = {}) {
    return this.control.speed(value, options.monitor);
  }

  dim(value, options = {}) {
    return this.control.dim(value, options.monitor);
  }

  bounce(value, options = {}) {
    return this.control.bounce(value, options.monitor);
  }

  // Sets the mode (video, image or toggle). With the wallpaper showing, every monitor reloads and the result has what
  // the target monitor now plays; otherwise only the mode changes, the wallpaper starting in it when turned on.
  // Returns { mode, held, counts, running, playing }, playing being null when nothing reloaded.
  async mode(requested, options = {}) {
    const running = await this.control.state({ required: false });
    const shows = running && running.wallpaper !== false && running.load?.level !== 'off' && !running.visualizer?.hidesWallpaper;
    const playing = shows ? await this.control.switchTo(options.monitor, () => this.control.mode(requested)) : null;
    const { mode, held, counts } = playing?.result ?? await this.control.mode(requested);
    if (playing) await this.announce(playing);
    return { mode, held, counts, running: Boolean(running), playing };
  }
}
