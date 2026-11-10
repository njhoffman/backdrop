import { run } from '../display/Monitors.js';
import { DEFAULT_VEIL, scaleVeil, veilStrength } from './palette.js';

// The first sleeve with --lyrics-area, --now-area, --background and --map-below
const LAYER_VERSION = [0, 36];

const atLeast = (version, [major, minor]) => {
  const [a, b] = version.split('.').map(Number);
  return a > major || (a === major && b >= minor);
};

// sleeve's synced lyrics behind the visualizer adapter, for one instance of the visualizer section; the
// contract is docs/specs/sleeve.md. Only the options set are passed, since an option given wins over the
// user's ~/.config/sleeve/style.css.
export class SleeveVisualizer {
  constructor(settings, instance, { exec = run } = {}) {
    this.settings = settings;
    this.instance = instance;
    this.exec = exec;
    this.layer = false;
  }

  title(monitor) {
    return `backdrop-visualizer-${monitor.name}-${this.instance.name}`;
  }

  // Nothing to build, since the shell is installed apart from backdrop, but an older sleeve would exit 2 on
  // the options it does not know, so that is reported here by name. Without an answer (not installed) the start
  // reports it.
  async prepare() {
    const version = await Promise.resolve().then(() => this.exec(this.file, ['--version'])).then(text => text.trim(), () => null);
    this.layer = Boolean(version) && atLeast(version, LAYER_VERSION);
    const { lyricsArea, nowArea, background, mapBelow } = this.instance.sleeve;
    if (version && !this.layer && (lyricsArea || nowArea || background || mapBelow)) {
      throw new Error(`visualizer.sleeve areas, background and map_below need sleeve ${LAYER_VERSION.join('.')}.0 or later (found ${version})`);
    }
  }

  mapsBelow(monitor, { width, height }) {
    const { mapBelow } = this.instance.sleeve;
    return mapBelow ?? (this.layer && width === monitor.width && height === monitor.height);
  }

  // The name `sleeve ctl display --instance` knows this window by, unique across monitors
  pageName(monitor) {
    return `${monitor.name}-${this.instance.name}`;
  }

  get file() {
    return this.instance.sleeve.command ?? 'sleeve';
  }

  // geometry is absolute in the root window: { x, y, width, height }
  // veil: what an `auto` background is now at full strength, when known
  command(monitor, { x, y, width, height }, veil = null) {
    const { now, nowPosition, lyricsAlign, lyricsArea, nowArea, noSandbox } = this.instance.sleeve;
    const strength = veilStrength(this.instance.sleeve.background);
    const background = strength === null ? this.instance.sleeve.background : scaleVeil(veil ?? DEFAULT_VEIL, strength);
    return {
      file: this.file,
      args: [
        'shell', '--managed', '--geometry', `${width}x${height}+${x}+${y}`,
        '--title', this.title(monitor), '--instance', this.pageName(monitor),
        ...(now ? ['--now', now] : []),
        ...(nowPosition ? ['--now-position', nowPosition] : []),
        ...(lyricsAlign ? ['--lyrics-align', lyricsAlign] : []),
        ...(lyricsArea ? ['--lyrics-area', lyricsArea] : []),
        ...(nowArea ? ['--now-area', nowArea] : []),
        ...(background ? ['--background', background] : []),
        ...(this.mapsBelow(monitor, { width, height }) ? ['--map-below'] : []),
        ...(noSandbox ? ['--no-sandbox'] : [])
      ]
    };
  }

  // sleeve takes the colors behind its window whole, one JSON object a line, and picks its text colors from them
  colorLines(colors) {
    return colors?.background ? [`${JSON.stringify(colors)}\n`] : [];
  }

  // `sleeve ctl display` for the running page: reset forgets earlier changes for it, back to its start options;
  // visible hides or shows it. look is the instance's sleeve settings to send, for those that changed.
  display(monitor, { reset = false, visible, look } = {}) {
    return {
      file: this.file,
      args: [
        'ctl', 'display', '--instance', this.pageName(monitor),
        ...(reset ? ['--reset'] : []),
        ...(look?.now ? ['--preset', look.now] : []),
        ...(look?.nowPosition ? ['--position', look.nowPosition] : []),
        ...(look?.lyricsAlign ? ['--align', look.lyricsAlign] : []),
        ...(look?.lyricsArea ? ['--lyrics-area', look.lyricsArea] : []),
        ...(look?.nowArea ? ['--now-area', look.nowArea] : []),
        ...(look?.background ? ['--background', look.background] : []),
        ...(visible === undefined ? [] : [visible ? '--show' : '--hide'])
      ]
    };
  }
}
