import { expect } from 'chai';
import { applyLive, instanceLook, layoutFor, lookAsPreset, resolveGeometry, visualizerSettings } from '../../src/visualizer/settings.js';
import { makeConfig } from '../helpers/fakes.js';

describe('visualizer settings', () => {
  const monitor = { name: 'DP-3', x: 1920, y: 0, width: 2560, height: 1440 };
  // The single instance a section without instances describes
  const main = section => visualizerSettings(section).instances[0];
  const geometry = (section, target = monitor) => resolveGeometry(target, layoutFor(main({ enabled: true, ...section }), target.name));

  it('accepts the default section, disabled, with the bars options as GLava defines', () => {
    const settings = visualizerSettings(makeConfig().get().visualizer);
    expect(settings).to.include({ enabled: false, engine: 'glava', audio: 'pulseaudio', source: 'auto', onlyWhilePlaying: false, silenceGrace: 10, preset: null });
    expect(settings.instances.map(instance => instance.name)).to.deep.equal(['main']);
    expect(settings.instances[0]).to.include({ module: 'bars', opacity: 0.8 });
    expect(settings.instances[0].defines).to.deep.equal({
      BAR_WIDTH: 20, BAR_GAP: 1, BAR_OUTLINE_WIDTH: 0, AMPLIFY: 200, GRADIENT: 80,
      COLOR: '@fg:mix(#000000, #33aacc, clamp(d / GRADIENT, 0, 1))', DIRECTION: 0, FLIP: 0, USE_ALPHA: 1
    });
    expect(settings.glava).to.deep.equal({ shaderDir: '/etc/xdg/glava', args: [] });
    expect(layoutFor(settings.instances[0], 'DP-3')).to.equal(settings.instances[0].layout);
  });

  it('applies typed bars options only to bars, and raw defines over them', () => {
    const bars = main({ bars: { colors: '#33AACC80', direction: 'outward', flip: true }, defines: { BAR_GAP: 3, C_LINE: true } });
    expect(bars.defines).to.include({ COLOR: '@fg:#33aacc80', DIRECTION: 1, FLIP: 1, BAR_GAP: 3, C_LINE: 1 });
    expect(main({ module: 'radial', defines: { C_RADIUS: 128 } }).defines).to.deep.equal({ C_RADIUS: 128 });
  });

  it('writes only the typed options given for the other modules, as their GLava defines', () => {
    expect(main({ module: 'graph', graph: { amplify: 250, colors: ['#802A2A', '#4f4f92'], direction: 'outward', outline: true, outline_color: '#262626' } }).defines)
      .to.deep.equal({ VSCALE: 250, COLOR: '@fg:mix(#802a2a, #4f4f92, clamp(pos / GRADIENT, 0, 1))', DIRECTION: -1, DRAW_OUTLINE: 1, OUTLINE: '@bg:#262626' });
    expect(main({ module: 'radial', radial: { radius: 100, line: 2.5, bars: 120, width: 4, rotate: 90, offset_y: -10 } }).defines)
      .to.deep.equal({ C_RADIUS: '100.0', C_LINE: '2.5', NBARS: 120, BAR_WIDTH: '4.0', ROTATE: '(90.0 * PI / 180.0)', CENTER_OFFSET_Y: '-10.0' });
    expect(main({ module: 'circle', circle: { color: '#33aacc', fill: true } }).defines).to.deep.equal({ OUTLINE: '@fg:#33aacc', C_FILL: 1 });
    expect(main({ module: 'wave', wave: { color: '#b33373', max_thickness: 5 }, defines: { AMPLIFY: 450 } }).defines)
      .to.deep.equal({ BASE_COLOR: '@fg:#b33373', MAX_THICKNESS: '5.0', AMPLIFY: 450 });
    expect(main({ module: 'wave' }).defines).to.deep.equal({});
  });

  it('checks every module section and rejects unknown options, so typos show', () => {
    const fails = (section, message) => expect(() => visualizerSettings(section)).to.throw(message);
    fails({ bars: { colour: '#000000' } }, 'visualizer.bars.colour must be one of the bars options (width, gap, outline');
    fails({ module: 'radial', radial: { width: 0 } }, 'visualizer.radial.width must be a number above 0');
    fails({ module: 'graph', graph: { direction: 'up' } }, 'visualizer.graph.direction must be inward, outward');
    // The section of a module not in use is checked too
    fails({ module: 'bars', circle: { radius: -1 } }, 'visualizer.circle.radius must be a number from 0');
    fails({ module: 'wave', wave: 'big' }, 'visualizer.wave must be a mapping');
  });

  it('names the key of a bad value', () => {
    const fails = (section, message) => expect(() => visualizerSettings(section)).to.throw(message);
    fails({ module: 'spiral' }, 'visualizer.module must be bars, graph, radial, circle, wave, not "spiral"');
    fails({ enabled: 'yes' }, 'visualizer.enabled must be true or false');
    fails({ opacity: 1.5 }, 'visualizer.opacity must be a number from 0 to 1');
    fails({ opacity: '80%' }, 'visualizer.opacity must be a number from 0 to 1');
    fails({ bars: { width: 0 } }, 'visualizer.bars.width must be an integer from 1');
    fails({ bars: { colors: ['#000', '#fff'] } }, 'visualizer.bars.colors[0] must be a color');
    fails({ bars: { colors: [] } }, 'visualizer.bars.colors must be one color, or two');
    fails({ placement: { height: '120%' } }, 'visualizer.placement.height must be pixels or a percentage');
    fails({ placement: { anchor: 'middle' } }, 'visualizer.placement.anchor must be bottom, top');
    fails({ rect: { x: 0, y: 0, width: 10 } }, 'visualizer.rect.height must be set when rect is used');
    fails({ defines: { bar_width: 3 } }, 'visualizer.defines.bar_width must be an upper-case GLSL name');
    fails({ requests: 'setframerate 60' }, 'visualizer.requests must be a list of strings');
    fails({ source: 'a "quoted" sink' }, 'visualizer.source must be a device');
    fails({ monitors: { 'DP-3': 'yes' } }, 'visualizer.monitors.DP-3 must be true, false or a mapping');
    fails({ visualisation: true }, 'visualizer.visualisation must be one of the visualizer settings');
    fails({ silence_grace: -1 }, 'visualizer.silence_grace must be a number from 0');
    fails({ only_while_playing: true, audio: 'fifo' }, 'visualizer.only_while_playing must be false with audio: fifo');
  });

  it('builds each instance from the shared settings and its own, in list order', () => {
    const settings = visualizerSettings({
      opacity: 0.5, placement: { anchor: 'bottom', height: '20%' }, bars: { width: 10 }, audio: 'fifo',
      instances: [
        { name: 'base' },
        { name: 'ring', module: 'radial', opacity: 1, placement: { anchor: 'center' }, radial: { bars: 90 } },
        { name: 'side', bars: { gap: 4 }, monitors: ['HDMI-1'] }
      ]
    });
    expect(settings.audio).to.equal('fifo');
    expect(settings.instances.map(item => [item.name, item.module, item.opacity])).to.deep.equal([
      ['base', 'bars', 0.5], ['ring', 'radial', 1], ['side', 'bars', 0.5]
    ]);
    // Mappings merge with the shared ones: the ring keeps the shared height, the side bars keep width 10
    expect(settings.instances[1].layout.placement).to.deep.include({ anchor: 'center', height: { percent: 20 } });
    expect(settings.instances[1].defines).to.deep.equal({ NBARS: 90 });
    expect(settings.instances[2].defines).to.include({ BAR_WIDTH: 10, BAR_GAP: 4 });
    expect(layoutFor(settings.instances[2], 'DP-3')).to.be.null;
  });

  it('names an instance in its errors and rejects shared settings, bad names and duplicates', () => {
    const fails = (instances, message) => expect(() => visualizerSettings({ instances })).to.throw(message);
    fails([{ name: 'ring', module: 'radial', radial: { width: 0 } }], 'visualizer.instances.ring.radial.width must be a number above 0');
    fails([{ name: 'ring', audio: 'fifo' }], 'visualizer.instances.ring.audio must be one of the visualizer instance settings');
    fails([{ module: 'bars' }], 'visualizer.instances[0].name must be a name of letters');
    fails([{ name: 'a' }, { name: 'a' }], 'visualizer.instances[1].name must be unique');
    fails([], 'visualizer.instances must be a list of visualizers');
  });

  it('lays the active preset over the section, from the command line first, and checks every preset', () => {
    const section = { enabled: true, opacity: 0.7, presets: { calm: { opacity: 0.3, module: 'wave' }, ring: { opacity: 0.2 } }, preset: 'calm' };
    let settings = visualizerSettings(section);
    expect(settings.preset).to.equal('calm');
    expect(settings.instances[0]).to.include({ module: 'wave', opacity: 0.3 });
    expect(settings.presets).to.deep.equal(['subtle', 'ring', 'wave', 'party', 'calm']);
    // Built-in presets bring their own instances; the section's ring replaces the built-in one
    settings = visualizerSettings(section, { preset: 'party' });
    expect(settings.instances.map(item => [item.name, item.module, item.opacity])).to.deep.equal([['base', 'bars', 0.7], ['ring', 'radial', 0.7]]);
    expect(visualizerSettings(section, { preset: 'ring' }).instances[0]).to.include({ name: 'main', opacity: 0.2 });
    expect(visualizerSettings(section, { preset: null }).preset).to.be.null;

    const fails = (value, message, options) => expect(() => visualizerSettings(value, options)).to.throw(message);
    fails(section, 'visualizer.preset must be one of the presets (subtle, ring, wave, party, calm), not "loud"', { preset: 'loud' });
    fails({ presets: { bad: { bars: { width: 0 } } } }, 'visualizer.presets.bad.bars.width must be an integer from 1');
    fails({ presets: { bad: { enabled: true } } }, 'visualizer.presets.bad.enabled must be left out of a preset');
  });

  it('places the box on the monitor by anchor, size and margin, in root coordinates', () => {
    expect(geometry({})).to.deep.equal({ x: 1920, y: 1080, width: 2560, height: 360 });
    expect(geometry({ placement: { anchor: 'top', height: 200, width: '50%' } })).to.deep.equal({ x: 2560, y: 0, width: 1280, height: 200 });
    expect(geometry({ placement: { anchor: 'left', width: '25%', height: '100%', margin: 20 } }))
      .to.deep.equal({ x: 1940, y: 20, width: 630, height: 1400 });
    expect(geometry({ placement: { anchor: 'right', width: 400, height: 400 } })).to.deep.equal({ x: 4080, y: 520, width: 400, height: 400 });
    expect(geometry({ placement: { anchor: 'center', width: 400, height: 400 } })).to.deep.equal({ x: 3000, y: 520, width: 400, height: 400 });
    expect(geometry({ placement: { anchor: 'fill', margin: '10%' } })).to.deep.equal({ x: 2176, y: 144, width: 2048, height: 1152 });
    // Sizes larger than the monitor are clamped to it
    expect(geometry({ placement: { height: 5000 } })).to.deep.equal({ x: 1920, y: 0, width: 2560, height: 1440 });
  });

  it('uses a rect over the placement, kept on the monitor', () => {
    expect(geometry({ rect: { x: '50%', y: 100, width: '50%', height: 300 } })).to.deep.equal({ x: 3200, y: 100, width: 1280, height: 300 });
    expect(geometry({ rect: { x: 2500, y: 0, width: 200, height: 10 } })).to.deep.equal({ x: 4280, y: 0, width: 200, height: 10 });
  });

  it('runs on all monitors, a list, or a mapping with per-monitor layouts', () => {
    const list = main({ enabled: true, monitors: ['DP-3'] });
    expect(layoutFor(list, 'DP-3')).to.equal(list.layout);
    expect(layoutFor(list, 'HDMI-1')).to.be.null;
    const map = main({ enabled: true, monitors: { 'DP-3': { placement: { anchor: 'top' } }, 'HDMI-1': true, 'DP-1': false } });
    expect(layoutFor(map, 'DP-3').placement.anchor).to.equal('top');
    expect(layoutFor(map, 'HDMI-1')).to.equal(map.layout);
    expect(layoutFor(map, 'DP-1')).to.be.null;
    expect(geometry({ monitors: { 'DP-3': { rect: { x: 0, y: 0, width: 100, height: 100 } } } })).to.deep.equal({ x: 1920, y: 0, width: 100, height: 100 });
  });

  describe('palette', () => {
    it('keeps the module colors in the shader by default, with nothing piped', () => {
      const instance = main({});
      expect(instance.palette).to.deep.equal({ source: 'config', pick: 'vivid', minContrast: 3 });
      expect(instance.pipe).to.equal(null);
      expect(instance.defines.COLOR).to.equal('@fg:#33aacc');
    });

    it('pipes the foreground color with source: wallpaper, sending the configured colors first', () => {
      const gradient = main({ palette: { source: 'wallpaper', pick: 'complement', min_contrast: 4.5 }, bars: { colors: ['#000000', '#33aacc80'] } });
      expect(gradient.palette).to.deep.equal({ source: 'wallpaper', pick: 'complement', minContrast: 4.5 });
      // A space before each comma: GLava reads a default up to whitespace
      expect(gradient.defines.COLOR).to.equal('mix(@fg:#000000 , @fg2:#33aacc80 , clamp(d / GRADIENT, 0, 1))');
      expect(gradient.pipe).to.deep.equal({ fg: '#000000ff', fg2: '#33aacc80' });

      const single = main({ palette: { source: 'wallpaper' } });
      expect(single.defines.COLOR).to.equal('@fg:#33aacc');
      expect(single.pipe).to.deep.equal({ fg: '#33aaccff' });
    });

    it('pipes each module\'s own foreground, with GLava\'s colors when none is set', () => {
      const piped = (module, options = {}) => main({ module, palette: { source: 'wallpaper' }, ...options });
      expect(piped('graph').defines.COLOR).to.equal('mix(@fg:#802a2a , @fg2:#4f4f92 , clamp(pos / GRADIENT, 0, 1))');
      expect(piped('radial', { radial: { colors: '#ff0000' } }).pipe).to.deep.equal({ fg: '#ff0000ff' });
      expect(piped('circle').defines.OUTLINE).to.equal('@fg:#333333');
      expect(piped('wave', { wave: { color: '#123456' } })).to.deep.include({ pipe: { fg: '#123456ff' } });
      expect(piped('wave').defines.BASE_COLOR).to.equal('@fg:#b33373');
    });

    it('applies per instance and in presets', () => {
      const settings = visualizerSettings({
        palette: { source: 'wallpaper' },
        instances: [{ name: 'low' }, { name: 'top', palette: { source: 'config' } }],
        presets: { plain: { palette: { source: 'config' } } }
      });
      expect(settings.instances.map(instance => Boolean(instance.pipe))).to.deep.equal([true, false]);
      const plain = visualizerSettings({ palette: { source: 'wallpaper' }, presets: { plain: { palette: { source: 'config' } } } }, { preset: 'plain' });
      expect(plain.instances[0].pipe).to.equal(null);
    });

    it('rejects bad values, and a raw define of the color it pipes', () => {
      expect(() => main({ palette: { source: 'album' } })).to.throw('visualizer.palette.source must be config, wallpaper, not "album"');
      expect(() => main({ palette: { pick: 'loud' } })).to.throw('visualizer.palette.pick must be vivid, dominant, complement');
      expect(() => main({ palette: { min_contrast: 30 } })).to.throw('visualizer.palette.min_contrast must be a contrast ratio from 1 to 21');
      expect(() => main({ palette: { colour: 1 } })).to.throw('visualizer.palette.colour must be one of the palette settings');
      expect(() => main({ palette: { source: 'wallpaper' }, defines: { COLOR: '#ff0000' } }))
        .to.throw('visualizer.defines.COLOR must be left out with palette.source: wallpaper (set bars.colors instead)');
      // Without the wallpaper source a raw COLOR stays allowed
      expect(main({ defines: { COLOR: '#ff0000' } }).defines.COLOR).to.equal('#ff0000');
    });
  });

  describe('menu changes (live)', () => {
    const section = {
      opacity: 0.8, bars: { amplify: 300, colors: ['#000000', '#33aacc'] },
      presets: { faint: { opacity: 0.4 }, duo: { instances: [{ name: 'low' }, { name: 'ring', module: 'radial' }] } }
    };

    it('lays changes over the section without instances, after the preset', () => {
      const live = { main: { opacity: 0.5, bars: { amplify: 120 } } };
      const settings = visualizerSettings(section, { live });
      expect(settings.instances[0]).to.include({ opacity: 0.5 });
      expect(settings.instances[0].defines.AMPLIFY).to.equal(120);
      // Colors the change left alone stay
      expect(settings.instances[0].defines.COLOR).to.equal('@fg:mix(#000000, #33aacc, clamp(d / GRADIENT, 0, 1))');
      expect(visualizerSettings(section, { preset: 'faint', live: { main: { module: 'wave' } } }).instances[0]).to.include({ opacity: 0.4, module: 'wave' });
    });

    it('lays changes over the named instances, and checks them', () => {
      const settings = visualizerSettings(section, { preset: 'duo', live: { ring: { opacity: 0.3 } } });
      expect(settings.instances.map(item => [item.name, item.module, item.opacity])).to.deep.equal([['low', 'bars', 0.8], ['ring', 'radial', 0.3]]);
      expect(() => visualizerSettings(section, { live: { main: { opacity: 3 } } })).to.throw('visualizer.opacity must be a number from 0 to 1');
      expect(() => applyLive({}, { main: { enabled: true } })).to.throw('visualizer.live.main.enabled must be one of the visualizer instance settings');
      expect(applyLive({ a: 1 }, {})).to.deep.equal({ a: 1 });
    });

    it('describes an instance as the menu shows it', () => {
      expect(instanceLook(section)).to.deep.equal({
        module: 'bars', opacity: 0.8, anchor: 'bottom', palette: { source: 'config', pick: 'vivid', min_contrast: 3 },
        amplify: 300, colors: ['#000000', '#33aacc'], colorOption: 'colors'
      });
      const ring = instanceLook(section, { preset: 'duo', live: { ring: { placement: { anchor: 'center' }, palette: { source: 'wallpaper' } } } }, 'ring');
      expect(ring).to.include({ module: 'radial', anchor: 'center', amplify: 300 });
      expect(ring.palette.source).to.equal('wallpaper');
      expect(ring.colors).to.deep.equal(['#cc3333', '#cca0a0']);
      expect(instanceLook({ module: 'wave' })).to.include({ amplify: 500, colorOption: 'color' });
    });

    it('turns the active preset and the changes into one preset to save', () => {
      expect(lookAsPreset(section, { preset: 'faint', live: { main: { bars: { amplify: 100 } } } })).to.deep.equal({ opacity: 0.4, bars: { amplify: 100 } });
      expect(lookAsPreset(section, { live: {} })).to.deep.equal({});
      expect(lookAsPreset(section, { preset: 'duo', live: { ring: { opacity: 0.3 } } })).to.deep.equal({
        instances: [{ name: 'low' }, { name: 'ring', module: 'radial', opacity: 0.3 }]
      });
    });
  });
});
