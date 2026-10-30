import { expect } from 'chai';
import { layoutFor, resolveGeometry, visualizerSettings } from '../../src/visualizer/settings.js';
import { makeConfig } from '../helpers/fakes.js';

describe('visualizer settings', () => {
  const monitor = { name: 'DP-3', x: 1920, y: 0, width: 2560, height: 1440 };
  const geometry = (section, target = monitor) => resolveGeometry(target, layoutFor(visualizerSettings({ enabled: true, ...section }), target.name));

  it('accepts the default section, disabled, with the bars options as GLava defines', () => {
    const settings = visualizerSettings(makeConfig().get().visualizer);
    expect(settings).to.include({ enabled: false, engine: 'glava', module: 'bars', audio: 'pulseaudio', source: 'auto' });
    expect(settings.defines).to.deep.equal({
      BAR_WIDTH: 20, BAR_GAP: 1, BAR_OUTLINE_WIDTH: 0, AMPLIFY: 200, GRADIENT: 80,
      COLOR: '@fg:mix(#000000, #33aacc, clamp(d / GRADIENT, 0, 1))', DIRECTION: 0, FLIP: 0, USE_ALPHA: 1
    });
    expect(settings.glava).to.deep.equal({ shaderDir: '/etc/xdg/glava', args: [] });
    expect(layoutFor(settings, 'DP-3')).to.be.null;
  });

  it('applies typed bars options only to bars, and raw defines over them', () => {
    const bars = visualizerSettings({ bars: { colors: '#33AACC80', direction: 'outward', flip: true }, defines: { BAR_GAP: 3, C_LINE: true } });
    expect(bars.defines).to.include({ COLOR: '@fg:#33aacc80', DIRECTION: 1, FLIP: 1, BAR_GAP: 3, C_LINE: 1 });
    expect(visualizerSettings({ module: 'radial', defines: { C_RADIUS: 128 } }).defines).to.deep.equal({ C_RADIUS: 128 });
  });

  it('names the key of a bad value', () => {
    const fails = (section, message) => expect(() => visualizerSettings(section)).to.throw(message);
    fails({ module: 'spiral' }, 'visualizer.module must be bars, graph, radial, circle, wave, not "spiral"');
    fails({ enabled: 'yes' }, 'visualizer.enabled must be true or false');
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
    const list = visualizerSettings({ enabled: true, monitors: ['DP-3'] });
    expect(layoutFor(list, 'DP-3')).to.equal(list.layout);
    expect(layoutFor(list, 'HDMI-1')).to.be.null;
    const map = visualizerSettings({ enabled: true, monitors: { 'DP-3': { placement: { anchor: 'top' } }, 'HDMI-1': true, 'DP-1': false } });
    expect(layoutFor(map, 'DP-3').placement.anchor).to.equal('top');
    expect(layoutFor(map, 'HDMI-1')).to.equal(map.layout);
    expect(layoutFor(map, 'DP-1')).to.be.null;
    expect(geometry({ monitors: { 'DP-3': { rect: { x: 0, y: 0, width: 100, height: 100 } } } })).to.deep.equal({ x: 1920, y: 0, width: 100, height: 100 });
  });
});
