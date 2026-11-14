import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { scaledDefines, shaderDefines, GlavaVisualizer, applyDefines } from '../../src/visualizer/GlavaVisualizer.js';
import { createVisualizer } from '../../src/visualizer/index.js';
import { visualizerSettings } from '../../src/visualizer/settings.js';

describe('GlavaVisualizer', () => {
  let dir, shaders;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-glava-'));
    shaders = path.join(dir, 'shaders');
    await fs.outputFile(path.join(shaders, 'rc.glsl'), '#request mod bars\n');
    await fs.outputFile(path.join(shaders, 'bars.glsl'), '/* width */\n#define BAR_WIDTH 5\n  #define AMPLIFY 300\n#define FLIP 0\n');
    await fs.outputFile(path.join(shaders, 'bars', '1.frag'), 'void main() {}\n');
  });
  afterEach(async () => { await fs.remove(dir); });

  const settings = section => visualizerSettings({ enabled: true, glava: { shader_dir: shaders }, ...section });
  const glava = (section, options) => {
    const normalized = settings(section);
    return new GlavaVisualizer(normalized, normalized.instances[0], options);
  };

  it('replaces the defines a module file has and appends the rest', () => {
    expect(applyDefines('#define A 1\n  #define B 2\n#define AB 3', { B: 5, C: '"x"' }))
      .to.equal('#define A 1\n  #define B 5\n#define AB 3\n\n/* Added by backdrop */\n#define C "x"');
    expect(applyDefines('#define A 1', {})).to.equal('#define A 1');
  });

  it('builds a config root linking the installed shaders, with the module file rewritten', async () => {
    const root = path.join(dir, 'run', 'visualizer', 'main');
    await fs.outputFile(path.join(root, 'stale'), 'old');
    const normalized = settings({ bars: { width: 9 }, reference_height: null });
    const visualizer = createVisualizer(normalized, normalized.instances[0], { runtimeDir: path.join(dir, 'run') });
    expect(visualizer).to.be.instanceOf(GlavaVisualizer);
    await visualizer.prepare();
    expect(await fs.pathExists(path.join(root, 'stale'))).to.be.false;
    expect(await fs.readlink(path.join(root, 'glava', 'rc.glsl'))).to.equal(path.join(shaders, 'rc.glsl'));
    expect(await fs.readlink(path.join(root, 'glava', 'bars'))).to.equal(path.join(shaders, 'bars'));
    const bars = await fs.readFile(path.join(root, 'glava', 'bars.glsl'), 'utf8');
    expect(bars).to.include('#define BAR_WIDTH 9\n  #define AMPLIFY 200\n#define FLIP 0').and.include('#define USE_ALPHA 1');
    expect((await fs.lstat(path.join(root, 'glava', 'bars.glsl'))).isSymbolicLink()).to.be.false;
  });

  it('scales the installed shader\'s own sizes where the config leaves them unset', async () => {
    await fs.outputFile(path.join(shaders, 'wave.glsl'), '#define MIN_THICKNESS 1\n#define MAX_THICKNESS 6\n#define AMPLIFY 500\n');
    const root = path.join(dir, 'root');
    await glava({ module: 'wave', placement: { anchor: 'fill' }, wave: { max_thickness: 4 } }, { root }).prepare();
    const wave = await fs.readFile(path.join(root, 'glava', 'wave.glsl'), 'utf8');
    expect(wave).to.equal('#define MIN_THICKNESS (1.0 * float(screen.y) / 1440.0)\n#define MAX_THICKNESS (4.0 * float(screen.y) / 1440.0)\n'
      + '#define AMPLIFY (500.0 * float(screen.y) / 1440.0)\n');
  });

  it('fails clearly when the shaders are not where shader_dir says', async () => {
    let caught;
    try {
      await glava({ module: 'wave' }, { root: path.join(dir, 'root') }).prepare();
    } catch (error) { caught = error; }
    expect(caught.message).to.equal(`GLava shaders not found in ${shaders} (no wave.glsl); set visualizer.glava.shader_dir`);
  });

  it('launches an unmanaged, click-through, transparent window at the geometry, with its own config root', () => {
    const visualizer = glava({ audio: 'fifo', source: '/tmp/mpd.fifo', requests: ['setframerate 60'], glava: { shader_dir: shaders, args: ['-v'] } },
      { root: '/run/bd/visualizer' });
    const { file, args, env } = visualizer.command({ name: 'DP-3' }, { x: 1920, y: 1080, width: 2560, height: 360 },
      { PATH: '/bin', XDG_CONFIG_HOME: '/home/u/.config' });
    expect(file).to.equal('glava');
    expect(args.slice(0, 2)).to.deep.equal(['--audio=fifo', '--force-mod=bars']);
    const requests = args.filter((arg, index) => args[index - 1] === '-r');
    expect(requests).to.include.members([
      'setopacity "native"', 'setxwintype "!-"', 'setclickthrough true', 'setbg 00000000',
      'setgeometry 1920 1080 2560 360', 'settitle "backdrop-visualizer-DP-3-main"', 'setsource "/tmp/mpd.fifo"'
    ]);
    // User requests come after backdrop's, so they win
    expect(requests.at(-1)).to.equal('setframerate 60');
    // A one-speaker instance reads the remap source the manager made
    visualizer.channelSource = 'backdrop_left';
    const own = visualizer.command({ name: 'DP-3' }, { x: 0, y: 0, width: 10, height: 10 }, {}).args;
    expect(own).to.include('setsource "backdrop_left"');
    expect(args.at(-1)).to.equal('-v');
    expect(env).to.deep.equal({ PATH: '/bin', XDG_CONFIG_HOME: '/run/bd/visualizer', PULSE_COOKIE: '/home/u/.config/pulse/cookie' });
    expect(visualizer.command({ name: 'DP-3' }, { x: 0, y: 0, width: 1, height: 1 }, { PULSE_COOKIE: '/c' }).env.PULSE_COOKIE).to.equal('/c');
  });

  it('reads the piped colors from stdin when there are any', () => {
    const args = section => glava(section, { root: '/r' }).command({ name: 'DP-3' }, { x: 0, y: 0, width: 1, height: 1 }, {}).args;
    expect(args({ module: 'radial' }).filter(arg => arg.startsWith('--pipe'))).to.deep.equal([]);
    expect(args({}).filter(arg => arg.startsWith('--pipe'))).to.deep.equal(['--pipe=fg:vec4']);
    expect(args({ palette: { source: 'wallpaper' }, bars: { colors: ['#000000', '#ffffff'] } }).filter(arg => arg.startsWith('--pipe')))
      .to.deep.equal(['--pipe=fg:vec4', '--pipe=fg2:vec4']);
  });

  describe('sizes for the monitor', () => {
    const { layout } = visualizerSettings({ placement: { anchor: 'bottom', width: '100%', height: '25%' } }).instances[0];

    it('writes them against the window\'s height on a monitor of the reference height', () => {
      const defines = scaledDefines({ AMPLIFY: 300, COLOR: '#fff' }, { scaled: ['AMPLIFY'], layout }, 1440);
      expect(defines).to.deep.equal({ AMPLIFY: '(300.0 * float(screen.y) / 360.0)', COLOR: '#fff' });
    });

    it('takes sizes already written as floats', () => {
      const defines = scaledDefines({ C_RADIUS: '150.0', BAR_WIDTH: '4.5' }, { scaled: ['C_RADIUS', 'BAR_WIDTH'], layout }, 1440);
      expect(defines).to.deep.equal({ C_RADIUS: '(150.0 * float(screen.y) / 360.0)', BAR_WIDTH: '(4.5 * float(screen.y) / 360.0)' });
    });

    it('scales a size the config leaves unset from the shader\'s default, and leaves other values alone', () => {
      const source = '#define GRADIENT 95\n  #define C_LINE 2.5\n#define ROTATE (PI / 2)\n#define COLOR @fg:#fff';
      expect(shaderDefines(source)).to.deep.equal({ GRADIENT: '95', C_LINE: '2.5', ROTATE: '(PI / 2)', COLOR: '@fg:#fff' });
      const defines = scaledDefines({ C_RADIUS: '150.0' }, { scaled: ['C_RADIUS', 'C_LINE', 'GRADIENT', 'ROTATE', 'NBARS'], layout }, 1440, source);
      expect(defines).to.deep.equal({
        C_RADIUS: '(150.0 * float(screen.y) / 360.0)', C_LINE: '(2.5 * float(screen.y) / 360.0)', GRADIENT: '(95.0 * float(screen.y) / 360.0)'
      });
    });

    it('leaves them alone with no reference height', () => {
      const defines = { AMPLIFY: 300 };
      expect(scaledDefines(defines, { scaled: ['AMPLIFY'], layout }, null)).to.equal(defines);
    });
  });
});
