import tty from 'tty';
import os from 'os';

// Shared terminal output: colors, status symbols and progress bars. Styling applies only when the
// target stream is a terminal (or FORCE_COLOR is set), so pipes, M3U exports and scripts get plain text.

export const DEFAULT_GRADIENT = ['#00c8ff', '#a050ff'];
// Status symbols plus media icons. Nerd Font glyphs are Font Awesome code points present in Nerd Fonts v2 and v3.
export const SYMBOL_SETS = {
  nerd: {
    success: '', warn: '', error: '', info: '',
    video: '', image: '', gif: '', duration: '', resolution: '', path: '',
    query: '', author: '', link: '', download: '', duplicate: '', monitor: '', tag: '',
    star: '', starEmpty: '', pending: ''
  },
  unicode: {
    success: '✓', warn: '▲', error: '✗', info: '•',
    video: '▶', image: '▣', gif: '↻', duration: '◷', resolution: '⤢', path: '↳',
    query: '⌕', author: '✎', link: '↗', download: '↓', duplicate: '≡', monitor: '▭', tag: '#',
    star: '★', starEmpty: '☆', pending: '…'
  },
  ascii: {
    success: '+', warn: '!', error: 'x', info: '-',
    video: '', image: '', gif: '', duration: '', resolution: '', path: '',
    query: '', author: '', link: '', download: '', duplicate: '', monitor: '', tag: '',
    star: '*', starEmpty: '.', pending: ''
  }
};
const SYMBOL_MODES = ['auto', ...Object.keys(SYMBOL_SETS)];
const STYLES = {
  bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39],
  blue: [34, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39]
};
const TONES = { success: 'green', warn: 'yellow', error: 'red', info: 'cyan' };

let settings = defaults();

function defaults() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    symbols: 'auto',
    gradient: DEFAULT_GRADIENT.map(parseHex),
    // false forces plain, non-interactive output regardless of the streams (used by tests)
    interactive: true
  };
}

export function parseHex(color) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (!match) throw new Error(`Invalid color "${color}"; use #rrggbb`);
  const value = parseInt(match[1], 16);
  return [value >> 16, (value >> 8) & 0xff, value & 0xff];
}

// Applies config.output and overrides; invalid settings throw so startup reports them
export function configureOutput({ config, ...overrides } = {}) {
  const output = config?.get().output ?? {};
  const next = { ...defaults(), ...overrides };
  // BACKDROP_SYMBOLS wins over the config, e.g. to use Nerd Font glyphs in one terminal only
  const fromEnv = next.env.BACKDROP_SYMBOLS || undefined;
  const symbols = fromEnv ?? output.symbols ?? next.symbols;
  if (!SYMBOL_MODES.includes(symbols)) {
    const name = fromEnv ? 'BACKDROP_SYMBOLS' : 'output.symbols';
    throw new Error(`${name} must be one of ${SYMBOL_MODES.join(', ')} (got ${symbols})`);
  }
  next.symbols = symbols;
  const gradient = output.progress_gradient ?? overrides.gradient;
  if (gradient !== undefined) {
    if (!Array.isArray(gradient) || gradient.length < 2) {
      throw new Error('output.progress_gradient must list at least two #rrggbb colors');
    }
    next.gradient = gradient.map(color => (Array.isArray(color) ? color : parseHex(color)));
  }
  settings = next;
  return settings;
}

export function resetOutput() {
  settings = defaults();
}

export function isInteractive(stream = settings.stdout) {
  return settings.interactive && Boolean(stream?.isTTY);
}

// 1, 4, 8 or 24 bits. NO_COLOR and FORCE_COLOR are honored by Node's own detection.
export function colorDepth(stream = settings.stdout) {
  if (!settings.interactive) return 1;
  const detect = tty.WriteStream.prototype.getColorDepth;
  if (stream?.isTTY) return (stream.getColorDepth ?? detect).call(stream, settings.env);
  const { FORCE_COLOR } = settings.env;
  if (FORCE_COLOR === undefined || FORCE_COLOR === '0' || FORCE_COLOR === 'false') return 1;
  return detect.call(stream ?? {}, settings.env);
}

export function symbolSet(stream = settings.stdout) {
  if (settings.symbols !== 'auto') return SYMBOL_SETS[settings.symbols];
  const { LC_ALL, LC_CTYPE, LANG } = settings.env;
  const locale = LC_ALL || LC_CTYPE || LANG || '';
  return /utf-?8/i.test(locale) && settings.env.TERM !== 'linux' && isInteractive(stream)
    ? SYMBOL_SETS.unicode
    : SYMBOL_SETS.ascii;
}

export function paint(stream, style, text) {
  const codes = STYLES[style];
  if (!codes) throw new Error(`Unknown style: ${style}`);
  return colorDepth(stream) > 1 ? `\x1b[${codes[0]}m${text}\x1b[${codes[1]}m` : String(text);
}

// Styles for text written to stdout, e.g. fmt.green('imported')
export const fmt = Object.fromEntries(Object.keys(STYLES).map(style => [style, text => paint(settings.stdout, style, text)]));

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// A status line: symbol and colored message in a terminal, the bare message otherwise
function status(tone, stream, message) {
  if (!isInteractive(stream)) return String(message);
  const symbol = symbolSet(stream)[tone];
  return `${paint(stream, TONES[tone], symbol)} ${tone === 'info' ? message : paint(stream, TONES[tone], message)}`;
}

let activeBar = null;

// With --json, stdout carries only the JSON document; every other line moves to stderr
let jsonOutput = false;

export function setJsonOutput(enabled) {
  jsonOutput = Boolean(enabled);
}

function write(method, line) {
  activeBar?.clear();
  console[jsonOutput && method === 'log' ? 'error' : method](line);
  activeBar?.render(true);
}

export const out = {
  print: (line = '') => write('log', line),
  // The --json document, always on stdout
  json: value => console.log(JSON.stringify(value, null, 2)),
  success: message => write('log', status('success', settings.stdout, message)),
  info: message => write('log', status('info', settings.stdout, message)),
  // Informational messages that should not mix with a command's stdout, e.g. first-run notices
  notice: message => write('error', status('info', settings.stderr, message)),
  warn: message => write('error', status('warn', settings.stderr, message)),
  error: message => write('error', status('error', settings.stderr, message)),
  // Secondary detail lines, dimmed and indented
  detail: message => write('log', `  ${fmt.dim(message)}`),
  // An indented line under an item, prefixed with an icon from the symbol set
  field: (iconName, value) => write('log', `    ${fmt.dim(icon(iconName))}${value}`),
  heading: text => write('log', fmt.bold(text)),
  row: (label, value) => write('log', `${fmt.dim(`${label}:`)} ${value}`)
};

// A colored status symbol and a space for composing lines; nothing in plain output
export function mark(tone, stream = settings.stdout) {
  return isInteractive(stream) ? `${paint(stream, TONES[tone], symbolSet(stream)[tone])} ` : '';
}

// Dim "backdrop vX.Y.Z" on stderr for interactive runs, so piped output stays clean
export function printVersion(version) {
  if (isInteractive(settings.stderr)) console.error(paint(settings.stderr, 'dim', `backdrop v${version}`));
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// Media running time as a clock, e.g. 0:18 or 1:02:03
export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.round(seconds);
  const minutes = Math.floor(s / 60) % 60;
  const clock = `${minutes}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${clock.padStart(5, '0')}` : clock;
}

// An icon followed by a space on a terminal; nothing in plain output or where the set has no icon
export function icon(name, stream = settings.stdout) {
  if (!isInteractive(stream)) return '';
  const symbol = symbolSet(stream)[name];
  return symbol ? `${symbol} ` : '';
}

// Replaces the home directory with ~ on a terminal; piped output keeps full paths for scripts
export function displayPath(filePath, stream = settings.stdout) {
  if (!filePath || !isInteractive(stream)) return filePath ?? '';
  const home = (settings.env.HOME || os.homedir()).replace(/\/+$/, '');
  if (!home) return filePath;
  if (filePath === home) return '~';
  return filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
}

export function formatResolution(width, height, stream = settings.stdout) {
  if (!width || !height) return '?';
  const times = isInteractive(stream) && symbolSet(stream) !== SYMBOL_SETS.ascii ? '×' : 'x';
  return `${width}${times}${height}`;
}

export function orientationName({ width, height }) {
  if (!width || !height) return null;
  if (width === height) return 'square';
  return height > width ? 'portrait' : 'landscape';
}

// One-line media summary: kind, resolution, running time for videos, orientation
export function describeMedia(media) {
  const parts = [`${icon(media.kind)}${fmt.cyan(media.kind)}`];
  parts.push(`${icon('resolution')}${fmt.bold(formatResolution(media.width, media.height))}`);
  if (media.kind !== 'image' && Number.isFinite(media.duration)) parts.push(`${icon('duration')}${formatClock(media.duration)}`);
  if (media.kind !== 'image' && media.fps) parts.push(formatFps(media.fps));
  const orientation = orientationName(media);
  if (orientation) parts.push(fmt.dim(orientation));
  return parts.join('  ');
}

// 25fps, 29.97fps; empty when unknown
export function formatFps(fps) {
  return fps ? `${Math.round(fps * 100) / 100}fps` : '';
}

// CPU use as a percentage of one core: 0.4%, 26%, 408%; '-' when unknown
export function formatCpu(percent) {
  if (!Number.isFinite(percent)) return '-';
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

// mpv's hwdec-current as hardware (the API, e.g. vaapi) or software
export function formatDecoder(hwdec) {
  if (hwdec === null || hwdec === undefined) return '';
  return hwdec === 'no' || hwdec === '' ? 'software' : hwdec;
}

// A 0-3 rating as stars on a terminal (★★☆), as "2/3" in plain output; 0 is shown as skipped
export function formatRating(rating) {
  if (!rating?.rating) return formatStars(rating);
  return `${formatStars(rating)} ${fmt.dim(rating.orientation)}`;
}

// formatRating without the orientation the rating was given in
export function formatStars(rating) {
  if (!rating) return fmt.yellow('unrated');
  if (rating.rating === 0) return fmt.red('skipped');
  const set = symbolSet();
  return fmt.green(isInteractive() && set !== SYMBOL_SETS.ascii
    ? set.star.repeat(rating.rating) + set.starEmpty.repeat(3 - rating.rating)
    : `${rating.rating}/3`);
}

// Pads styled text to a visible width; longer text is left as is
export function padVisible(text, width) {
  return text + ' '.repeat(Math.max(0, width - stripAnsi(text).length));
}

// Quoted search queries, e.g. "ocean waves", "aerial coast"
export function formatQueries(queries) {
  return queries.map(query => `"${query}"`).join(', ');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

// Gradient color at position t (0-1) across the configured stops
export function gradientAt(stops, t) {
  const scaled = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const local = scaled - index;
  return stops[index].map((channel, i) => Math.round(channel + (stops[index + 1][i] - channel) * local));
}

// Nearest xterm-256 color cube index
function ansi256([r, g, b]) {
  const level = channel => Math.round((channel / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function colorize(depth, rgb, text) {
  if (depth >= 24) return `\x1b[38;2;${rgb.join(';')}m${text}`;
  if (depth >= 8) return `\x1b[38;5;${ansi256(rgb)}m${text}`;
  return `\x1b[36m${text}`;
}

const PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// Renders the bar cells: gradient blocks in color terminals, # and - in plain or ASCII ones
export function renderBar(fraction, width, { depth = 24, stops = settings.gradient, ascii = false } = {}) {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  if (ascii) {
    const filled = Math.round(clamped * width);
    return '#'.repeat(filled) + '-'.repeat(width - filled);
  }
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const partial = PARTIALS[eighths % 8];
  const cells = [...'█'.repeat(full), ...(partial ? [partial] : [])];
  const empty = width - cells.length;
  if (depth <= 1) return cells.join('') + '░'.repeat(empty);
  const body = cells.map((cell, i) => colorize(depth, gradientAt(stops, width > 1 ? i / (width - 1) : 0), cell)).join('');
  return `${body}\x1b[90m${'░'.repeat(empty)}\x1b[39m`;
}

// A bar split into colored segments ([{ value, style }]), e.g. kept/new/skipped; # blocks in ASCII terminals.
// Segments with a value get at least one cell so small shares stay visible.
export function stackedBar(segments, width, { ascii = symbolSet() === SYMBOL_SETS.ascii } = {}) {
  const total = segments.reduce((sum, { value }) => sum + value, 0);
  if (!total) return fmt.gray((ascii ? '-' : '░').repeat(width));
  const cells = segments.map(({ value }) => (value ? Math.max(1, Math.round((value / total) * width)) : 0));
  // Rounding can overshoot or fall short; take the difference from the largest segment
  const largest = cells.indexOf(Math.max(...cells));
  cells[largest] += width - cells.reduce((sum, count) => sum + count, 0);
  return segments.map(({ style }, i) => fmt[style]((ascii ? '#' : '█').repeat(Math.max(0, cells[i])))).join('');
}

// Rows of cells as lines with columns aligned by visible width; align holds 'r' for right-aligned columns.
// Columns empty in every row (such as bars in piped output) are dropped.
export function formatTable(rows, { align = [], indent = 2, gap = 2 } = {}) {
  const cells = rows.map(row => row.map(cell => String(cell ?? '')));
  const widths = [];
  for (const row of cells) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length); });
  }
  return cells.map(row => ' '.repeat(indent) + row.flatMap((cell, i) => {
    if (!widths[i]) return [];
    const pad = ' '.repeat(widths[i] - stripAnsi(cell).length);
    return [align[i] === 'r' ? pad + cell : cell + pad];
  }).join(' '.repeat(gap)).trimEnd());
}

function truncate(text, width) {
  if (width <= 0) return '';
  return text.length <= width ? text : `…${text.slice(text.length - width + 1)}`;
}

// A single-line progress bar on stderr. It draws only when stderr is a terminal; elsewhere every
// method is a no-op, so callers do not need to check. Lines printed through `out` appear above it.
export class ProgressBar {
  constructor({ label, total, stream = settings.stderr, now = Date.now, interval = 80 } = {}) {
    this.label = label;
    this.total = total;
    this.stream = stream;
    this.now = now;
    this.interval = interval;
    this.done = 0;
    this.detail = '';
    this.started = now();
    this.lastRender = 0;
    this.enabled = isInteractive(stream);
    this.drawn = false;
    if (this.enabled) activeBar = this;
  }

  update(done, detail = this.detail) {
    this.done = done;
    this.detail = detail;
    this.render();
  }

  tick(detail) {
    this.update(this.done + 1, detail);
  }

  setDetail(detail) {
    this.detail = detail;
    this.render();
  }

  line() {
    const columns = this.stream.columns || 80;
    const total = this.total || 0;
    const fraction = total ? this.done / total : 0;
    const elapsed = (this.now() - this.started) / 1000;
    const rate = elapsed > 0 ? this.done / elapsed : 0;
    const eta = rate > 0 && total ? (total - this.done) / rate : NaN;
    const counts = `${this.done}/${total} ${String(Math.floor(fraction * 100)).padStart(3)}%`;
    const timing = this.done && total ? ` ${rate.toFixed(1)}/s eta ${formatDuration(eta)}` : '';
    const width = Math.max(10, Math.min(30, columns - this.label.length - counts.length - timing.length - 20));
    const depth = colorDepth(this.stream);
    const ascii = symbolSet(this.stream) === SYMBOL_SETS.ascii;
    const bar = renderBar(fraction, width, { depth, ascii });
    const head = `${this.label} ${bar} ${counts}${timing}`;
    const used = stripAnsi(head).length;
    const detail = this.detail ? ` ${truncate(this.detail, columns - used - 2)}` : '';
    return `${head}${depth > 1 ? `\x1b[2m${detail}\x1b[22m` : detail}`;
  }

  render(force = false) {
    if (!this.enabled) return;
    const now = this.now();
    if (!force && this.drawn && now - this.lastRender < this.interval && this.done < this.total) return;
    this.lastRender = now;
    this.stream.write(`\r\x1b[2K${this.line()}`);
    this.drawn = true;
  }

  clear() {
    if (this.enabled && this.drawn) this.stream.write('\r\x1b[2K');
  }

  // Removes the bar; the caller prints its own summary afterwards
  stop() {
    this.clear();
    this.drawn = false;
    this.enabled = false;
    if (activeBar === this) activeBar = null;
  }
}
