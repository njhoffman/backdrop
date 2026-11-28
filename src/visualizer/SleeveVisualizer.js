import { run } from '../display/Monitors.js';
import { DEFAULT_VEIL, scaleVeil, veilStrength } from './palette.js';
import { SLEEVE_NO_LYRICS } from './settings.js';

// The first sleeve with --lyrics-area, --now-area, --background and --map-below
const LAYER_VERSION = [0, 36];
// The first sleeve with --style; an older one is not sent it, since it only changes how the page looks
const STYLE_VERSION = [0, 46];
// The first sleeve that takes the now-playing panel's --now-scale and --now-margin in --style; an older one refuses
// them, and the page would not start, so they are left out for it (the panel shows at its own size)
const NOW_STYLE_VERSION = [0, 49];
const NOW_STYLE_NAME = /^--now-/;
// The first sleeve with the card and strip panels and the center position; an older one refuses them and the page would
// not start, so it is given the nearest it has (OLDER_LAYOUT)
const LAYOUT_VERSION = [0, 53];
const OLDER_LAYOUT = { card: 'full', strip: 'minimal', center: 'center-left' };
// The first sleeve that leaves the lyrics out for a lyrics area of none; an older one refuses it, so the option is left
// out for it and its lyrics fill the window
const NO_LYRICS_VERSION = [0, 54];

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
    this.styled = false;
    // Until a version is known, what is set goes as it is
    this.layouts = true;
    this.noLyrics = true;
  }

  // now, nowPosition and lyricsArea as this sleeve takes them
  fitted({ now, nowPosition, lyricsArea } = {}) {
    return {
      now: now && !this.layouts ? OLDER_LAYOUT[now] ?? now : now,
      nowPosition: nowPosition && !this.layouts ? OLDER_LAYOUT[nowPosition] ?? nowPosition : nowPosition,
      lyricsArea: lyricsArea === SLEEVE_NO_LYRICS && !this.noLyrics ? null : lyricsArea
    };
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
    this.styled = Boolean(version) && atLeast(version, STYLE_VERSION);
    this.nowStyled = Boolean(version) && atLeast(version, NOW_STYLE_VERSION);
    this.layouts = !version || atLeast(version, LAYOUT_VERSION);
    this.noLyrics = !version || atLeast(version, NO_LYRICS_VERSION);
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
    const { lyricsAlign, nowArea, style, noSandbox } = this.instance.sleeve;
    const { now, nowPosition, lyricsArea } = this.fitted(this.instance.sleeve);
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
        ...(this.styled ? styleArgs(style, this.nowStyled) : []),
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
    const fitted = this.fitted(look);
    return {
      file: this.file,
      args: [
        'ctl', 'display', '--instance', this.pageName(monitor),
        ...(reset ? ['--reset'] : []),
        ...(fitted.now ? ['--preset', fitted.now] : []),
        ...(fitted.nowPosition ? ['--position', fitted.nowPosition] : []),
        ...(look?.lyricsAlign ? ['--align', look.lyricsAlign] : []),
        ...(fitted.lyricsArea ? ['--lyrics-area', fitted.lyricsArea] : []),
        ...(look?.nowArea ? ['--now-area', look.nowArea] : []),
        ...(look?.background ? ['--background', look.background] : []),
        ...(this.styled ? styleArgs(look?.style, this.nowStyled) : []),
        ...(visible === undefined ? [] : [visible ? '--show' : '--hide'])
      ]
    };
  }
}

// sleeve's --style NAME=VALUE, once for each name; an empty value drops a name an earlier change set. now: whether this
// sleeve takes the panel's names (NOW_STYLE_VERSION)
function styleArgs(style, now = true) {
  return Object.entries(style ?? {}).filter(([name]) => now || !NOW_STYLE_NAME.test(name)).flatMap(([name, value]) => [`--style=${name}=${value}`]);
}
