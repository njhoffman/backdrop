import { expect } from 'chai';
import sinon from 'sinon';
import {
  configureOutput, colorDepth, symbolSet, SYMBOL_SETS, out, fmt, stripAnsi, printVersion, ProgressBar,
  renderBar, gradientAt, parseHex, formatDuration, formatBytes, formatClock, icon, displayPath, formatResolution,
  orientationName, describeMedia, formatRating, formatQueries, mark, formatStars, padVisible, formatTable, stackedBar
} from '../../src/utils/output.js';
import { formatMediaLine, formatAdjustments } from '../../src/utils/mediaView.js';
import { makeConfig } from '../helpers/fakes.js';

const TRUECOLOR = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' };

// A terminal-like stream that records what is written to it
function fakeStream({ isTTY = true, columns = 100 } = {}) {
  return { isTTY, columns, written: [], write(text) { this.written.push(text); } };
}

describe('output', () => {
  let stdout, stderr, logs;

  function setup({ env = TRUECOLOR, tty = true, config, ...overrides } = {}) {
    stdout = fakeStream({ isTTY: tty });
    stderr = fakeStream({ isTTY: tty });
    configureOutput({ stdout, stderr, env, config, ...overrides });
  }

  beforeEach(() => {
    logs = [];
    sinon.stub(console, 'log').callsFake(line => logs.push(['log', line]));
    sinon.stub(console, 'error').callsFake(line => logs.push(['error', line]));
  });

  afterEach(() => {
    sinon.restore();
    // Back to the plain test default from test/helpers/setup.js
    configureOutput({ interactive: false });
  });

  describe('color and symbol detection', () => {
    it('uses Node color depth detection for terminals, honoring NO_COLOR', () => {
      setup();
      expect(colorDepth(stdout)).to.equal(24);
      setup({ env: { TERM: 'xterm-256color' } });
      expect(colorDepth(stdout)).to.equal(8);
      setup({ env: { ...TRUECOLOR, NO_COLOR: '1' } });
      expect(colorDepth(stdout)).to.equal(1);
    });

    it('keeps pipes plain unless FORCE_COLOR is set', () => {
      setup({ tty: false });
      expect(colorDepth(stdout)).to.equal(1);
      expect(fmt.green('ok')).to.equal('ok');
      setup({ tty: false, env: { FORCE_COLOR: '3' } });
      expect(colorDepth(stdout)).to.equal(24);
      setup({ tty: false, env: { FORCE_COLOR: '0' } });
      expect(colorDepth(stdout)).to.equal(1);
    });

    it('picks unicode symbols on a UTF-8 terminal and ASCII otherwise', () => {
      setup();
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.unicode);
      setup({ env: { TERM: 'xterm', LANG: 'C' } });
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.ascii);
      setup({ env: { ...TRUECOLOR, TERM: 'linux' } });
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.ascii);
      setup({ tty: false });
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.ascii);
    });

    it('uses Nerd Font glyphs only when configured, and rejects unknown modes', () => {
      setup({ config: makeConfig({ 'output.symbols': 'nerd' }) });
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.nerd);
      expect(() => setup({ config: makeConfig({ 'output.symbols': 'fancy' }) })).to.throw('output.symbols');
    });

    it('lets BACKDROP_SYMBOLS override the configured symbols', () => {
      setup({ env: { ...TRUECOLOR, BACKDROP_SYMBOLS: 'nerd' }, config: makeConfig({ 'output.symbols': 'ascii' }) });
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.nerd);
      setup({ env: { ...TRUECOLOR, BACKDROP_SYMBOLS: '' }, config: makeConfig({ 'output.symbols': 'ascii' }) });
      expect(symbolSet(stdout)).to.equal(SYMBOL_SETS.ascii);
      expect(() => setup({ env: { BACKDROP_SYMBOLS: 'emoji' } })).to.throw('BACKDROP_SYMBOLS');
    });

    it('defines the same icons in every symbol set', () => {
      const keys = Object.keys(SYMBOL_SETS.unicode).sort();
      for (const set of Object.values(SYMBOL_SETS)) expect(Object.keys(set).sort()).to.deep.equal(keys);
      for (const glyph of Object.values(SYMBOL_SETS.nerd)) expect(glyph.codePointAt(0)).to.be.within(0xe000, 0xf8ff);
    });

    it('is plain everywhere when interactive output is turned off', () => {
      setup({ interactive: false });
      expect(colorDepth(stdout)).to.equal(1);
      out.success('done');
      expect(logs).to.deep.equal([['log', 'done']]);
    });
  });

  describe('out', () => {
    it('prefixes status lines with a colored symbol in a terminal', () => {
      setup();
      out.success('saved');
      out.warn('careful');
      out.error('broken');
      expect(logs.map(([stream]) => stream)).to.deep.equal(['log', 'error', 'error']);
      expect(logs[0][1]).to.include('\x1b[32m');
      expect(logs.map(([, line]) => stripAnsi(line))).to.deep.equal(['✓ saved', '▲ careful', '✗ broken']);
    });

    it('prints bare messages when piped so scripts see the old text', () => {
      setup({ tty: false });
      out.success('saved');
      out.error('broken');
      out.row('Mode', 'video');
      out.detail('extra');
      expect(logs).to.deep.equal([['log', 'saved'], ['error', 'broken'], ['log', 'Mode: video'], ['log', '  extra']]);
    });

    it('prints the version line only on an interactive stderr', () => {
      setup();
      printVersion('1.2.3');
      expect(stripAnsi(logs[0][1])).to.equal('backdrop v1.2.3');
      logs.length = 0;
      setup({ tty: false });
      printVersion('1.2.3');
      expect(logs).to.deep.equal([]);
    });
  });

  describe('media formatting', () => {
    const HOME = { ...TRUECOLOR, HOME: '/home/me' };
    const video = { id: 7, kind: 'video', width: 3840, height: 2160, duration: 75, source: 'pexels', speed: 0.8, dim: 20,
      path: '/home/me/media/remote-7.mp4' };
    const image = { id: 1234, kind: 'image', width: 1080, height: 1920, duration: null, source: 'local', speed: 1, dim: 0,
      path: '/home/me/media/local-1234.png' };

    it('formats one media line tab-separated when piped, with empty fields kept in place', () => {
      setup({ env: HOME, tty: false });
      expect(formatMediaLine(video, { rating: { rating: 2 } }).split('\t')).to.deep.equal(
        ['#7', 'video', '3840x2160', '1:15', 'landscape', '2/3', 'pexels', 'speed 0.8, dim 20', '/home/me/media/remote-7.mp4']
      );
      expect(formatMediaLine(image, { rating: null }).split('\t')).to.deep.equal(
        ['#1234', 'image', '1080x1920', '', 'portrait', 'unrated', 'local', '', '/home/me/media/local-1234.png']
      );
    });

    it('aligns styled media lines on a terminal so separate lines share columns', () => {
      setup({ env: HOME });
      const lines = [formatMediaLine(video, { rating: { rating: 3 } }), formatMediaLine(image, { rating: { rating: 0 } })]
        .map(stripAnsi);
      expect(lines[0]).to.match(/^#7 {7}▶ video {2}3840×2160 {2}1:15 {5}landscape {2}★★★ {6}pexels {4}speed 0\.8, dim 20 {2}~\/media\/remote-7\.mp4$/);
      expect(lines[1].indexOf('~/media')).to.equal(lines[0].indexOf('~/media'));
      expect(lines[1].indexOf('skipped')).to.equal(lines[0].indexOf('★★★'));
    });

    it('aligns table columns by visible width and drops columns empty in every row', () => {
      setup();
      expect(formatTable([[fmt.bold('a'), 10, ''], ['bbb', 2, '']], { align: ['l', 'r'] }).map(stripAnsi))
        .to.deep.equal(['  a    10', '  bbb   2']);
    });

    it('splits stacked bars by share, keeping small segments visible', () => {
      setup();
      const bar = stripAnsi(stackedBar([{ value: 98, style: 'green' }, { value: 1, style: 'cyan' }, { value: 0, style: 'red' }], 10));
      expect(bar).to.equal('██████████');
      expect(stackedBar([{ value: 98, style: 'green' }, { value: 1, style: 'cyan' }], 10)).to.include('\x1b[36m█\x1b[39m');
      expect(stripAnsi(stackedBar([{ value: 0, style: 'green' }], 4))).to.equal('░░░░');
      expect(stripAnsi(stackedBar([{ value: 1, style: 'green' }, { value: 1, style: 'red' }], 4, { ascii: true }))).to.equal('####');
    });

    it('pads by visible width and formats stars and adjustments', () => {
      setup();
      expect(stripAnsi(padVisible(fmt.red('ab'), 4))).to.equal('ab  ');
      expect(padVisible('abcdef', 4)).to.equal('abcdef');
      expect(stripAnsi(formatStars({ rating: 1 }))).to.equal('★☆☆');
      expect(formatAdjustments(image)).to.equal('');
      expect(formatAdjustments({ speed: 1, dim: 30 })).to.equal('dim 30');
    });

    it('shortens home paths to ~ on a terminal only', () => {
      setup({ env: HOME });
      expect(displayPath('/home/me/.local/share/backdrop/a.mp4')).to.equal('~/.local/share/backdrop/a.mp4');
      expect(displayPath('/home/me')).to.equal('~');
      expect(displayPath('/home/mention/a.mp4')).to.equal('/home/mention/a.mp4');
      expect(displayPath('/srv/a.mp4')).to.equal('/srv/a.mp4');
      expect(displayPath(null)).to.equal('');
      setup({ env: HOME, tty: false });
      expect(displayPath('/home/me/a.mp4')).to.equal('/home/me/a.mp4');
    });

    it('formats running time as a clock', () => {
      expect([0, 9.6, 61, 3599, 3723].map(formatClock)).to.deep.equal(['0:00', '0:10', '1:01', '59:59', '1:02:03']);
      expect(formatClock(null)).to.equal('--');
    });

    it('uses icons and × on a terminal, plain text otherwise', () => {
      setup();
      expect(icon('video')).to.equal('▶ ');
      expect(formatResolution(1920, 1080)).to.equal('1920×1080');
      expect(stripAnsi(mark('success'))).to.equal('✓ ');
      setup({ env: { TERM: 'xterm', LANG: 'C' } });
      expect(icon('video')).to.equal('');
      expect(formatResolution(1920, 1080)).to.equal('1920x1080');
      setup({ tty: false });
      expect(icon('video')).to.equal('');
      expect(mark('success')).to.equal('');
      expect(formatResolution(null, 1080)).to.equal('?');
    });

    it('describes media with kind, resolution, duration for videos and orientation', () => {
      setup({ tty: false });
      expect(describeMedia({ kind: 'video', width: 1080, height: 1920, duration: 18.2 })).to.equal('video  1080x1920  0:18  portrait');
      expect(describeMedia({ kind: 'image', width: 2000, height: 2000, duration: null })).to.equal('image  2000x2000  square');
      expect(describeMedia({ kind: 'gif', width: null, height: null })).to.equal('gif  ?');
      expect(orientationName({ width: 3, height: 2 })).to.equal('landscape');
      setup();
      expect(stripAnsi(describeMedia({ kind: 'video', width: 3840, height: 2160, duration: 75 })))
        .to.equal('▶ video  ⤢ 3840×2160  ◷ 1:15  landscape');
    });

    it('shows ratings as stars on a terminal and as n/3 in plain output', () => {
      setup();
      expect(stripAnsi(formatRating({ rating: 2, orientation: 'landscape' }))).to.equal('★★☆ landscape');
      setup({ tty: false });
      expect(formatRating({ rating: 2, orientation: 'portrait' })).to.equal('2/3 portrait');
      expect(formatRating({ rating: 0, orientation: 'portrait' })).to.equal('skipped');
      expect(formatRating(null)).to.equal('unrated');
      expect(formatQueries(['ocean', 'night city'])).to.equal('"ocean", "night city"');
    });
  });

  describe('gradient bar', () => {
    it('parses colors and interpolates between stops', () => {
      expect(parseHex('#00c8ff')).to.deep.equal([0, 200, 255]);
      expect(() => parseHex('blue')).to.throw('#rrggbb');
      const stops = [[0, 0, 0], [200, 100, 50]];
      expect(gradientAt(stops, 0)).to.deep.equal([0, 0, 0]);
      expect(gradientAt(stops, 0.5)).to.deep.equal([100, 50, 25]);
      expect(gradientAt(stops, 1)).to.deep.equal([200, 100, 50]);
      expect(gradientAt([[0, 0, 0], [100, 0, 0], [100, 100, 0]], 0.75)).to.deep.equal([100, 50, 0]);
    });

    it('renders truecolor, 256-color, plain and ASCII bars of the requested width', () => {
      const stops = [[0, 200, 255], [160, 80, 255]];
      const truecolor = renderBar(0.5, 10, { depth: 24, stops });
      expect(truecolor).to.include('\x1b[38;2;0;200;255m');
      expect(stripAnsi(truecolor)).to.equal('█████░░░░░');
      expect(renderBar(0.5, 10, { depth: 8, stops })).to.match(/\x1b\[38;5;\d+m/);
      expect(renderBar(0.55, 10, { depth: 1, stops })).to.equal('█████▌░░░░');
      expect(renderBar(0.5, 10, { ascii: true })).to.equal('#####-----');
      expect(stripAnsi(renderBar(2, 4, { depth: 24, stops }))).to.equal('████');
    });

    it('takes the gradient from config and rejects invalid ones', () => {
      setup({ config: makeConfig({ 'output.progress_gradient': ['#ff0000', '#0000ff'] }) });
      const bar = new ProgressBar({ label: 'Test', total: 2 });
      bar.update(2);
      expect(stderr.written.join('')).to.include('38;2;255;0;0m');
      bar.stop();
      expect(() => setup({ config: makeConfig({ 'output.progress_gradient': ['#ff0000'] }) })).to.throw('at least two');
      expect(() => setup({ config: makeConfig({ 'output.progress_gradient': ['#ff0000', 'nope'] }) })).to.throw('#rrggbb');
    });
  });

  describe('ProgressBar', () => {
    it('draws counts, rate and the current item on stderr, throttling redraws', () => {
      setup();
      let now = 0;
      const bar = new ProgressBar({ label: 'Importing', total: 4, now: () => now });
      now = 1000;
      bar.update(1, 'a.jpg');
      bar.update(2, 'b.jpg');
      expect(stderr.written).to.have.length(1);
      const line = stripAnsi(stderr.written[0]);
      expect(line).to.include('Importing').and.include('1/4  25%').and.include('1.0/s eta 3s').and.include('a.jpg');
      now = 2000;
      bar.update(4, 'd.jpg');
      expect(stripAnsi(stderr.written.at(-1))).to.include('4/4 100%');
      bar.stop();
      expect(stderr.written.at(-1)).to.equal('\r\x1b[2K');
    });

    it('keeps printed lines above the bar by clearing and redrawing around them', () => {
      setup();
      const bar = new ProgressBar({ label: 'Importing', total: 2 });
      bar.update(1, 'a.jpg');
      const before = stderr.written.length;
      out.print('imported a.jpg');
      expect(stderr.written[before]).to.equal('\r\x1b[2K');
      expect(stripAnsi(stderr.written[before + 1])).to.include('1/2');
      bar.stop();
      out.print('summary');
      expect(stderr.written.at(-1)).to.equal('\r\x1b[2K');
    });

    it('shortens long item names to the terminal width', () => {
      setup();
      stderr.columns = 60;
      const bar = new ProgressBar({ label: 'Importing', total: 1 });
      bar.update(0, `${'x'.repeat(100)}.jpg`);
      const line = stripAnsi(stderr.written[0]).replace('\r\x1b[2K', '');
      expect(line.length).to.be.at.most(60);
      expect(line).to.include('…').and.include('.jpg');
      bar.stop();
    });

    it('does nothing when stderr is not a terminal', () => {
      setup({ tty: false });
      const bar = new ProgressBar({ label: 'Importing', total: 3 });
      bar.update(1, 'a.jpg');
      out.print('line');
      bar.stop();
      expect(stderr.written).to.deep.equal([]);
      expect(logs).to.deep.equal([['log', 'line']]);
    });
  });

  it('formats durations and sizes', () => {
    expect(formatDuration(5)).to.equal('5s');
    expect(formatDuration(125)).to.equal('2m05s');
    expect(formatDuration(3720)).to.equal('1h02m');
    expect(formatDuration(NaN)).to.equal('--');
    expect(formatBytes(512)).to.equal('512 B');
    expect(formatBytes(1536)).to.equal('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).to.equal('5.0 MB');
  });
});
