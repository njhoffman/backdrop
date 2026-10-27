import { expect } from 'chai';
import sinon from 'sinon';
import {
  configureOutput, colorDepth, symbolSet, SYMBOL_SETS, out, fmt, stripAnsi, printVersion, ProgressBar,
  renderBar, gradientAt, parseHex, formatDuration, formatBytes
} from '../../src/utils/output.js';
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
