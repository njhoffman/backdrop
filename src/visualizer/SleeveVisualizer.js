// sleeve's synced lyrics behind the visualizer adapter, for one instance of the visualizer section; the
// contract is docs/specs/sleeve.md. Only the options set are passed, since an option given wins over the
// user's ~/.config/sleeve/style.css.
export class SleeveVisualizer {
  constructor(settings, instance) {
    this.settings = settings;
    this.instance = instance;
  }

  title(monitor) {
    return `backdrop-visualizer-${monitor.name}-${this.instance.name}`;
  }

  // Nothing to build: the shell is installed apart from backdrop
  async prepare() {}

  // The name `sleeve ctl display --instance` knows this window by, unique across monitors
  pageName(monitor) {
    return `${monitor.name}-${this.instance.name}`;
  }

  get file() {
    return this.instance.sleeve.command ?? 'sleeve';
  }

  // geometry is absolute in the root window: { x, y, width, height }
  command(monitor, { x, y, width, height }) {
    const { now, nowPosition, lyricsAlign, noSandbox } = this.instance.sleeve;
    return {
      file: this.file,
      args: [
        'shell', '--managed', '--geometry', `${width}x${height}+${x}+${y}`,
        '--title', this.title(monitor), '--instance', this.pageName(monitor),
        ...(now ? ['--now', now] : []),
        ...(nowPosition ? ['--now-position', nowPosition] : []),
        ...(lyricsAlign ? ['--lyrics-align', lyricsAlign] : []),
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
        ...(visible === undefined ? [] : [visible ? '--show' : '--hide'])
      ]
    };
  }
}
