import { expect } from 'chai';
import { SleeveVisualizer } from '../../src/visualizer/SleeveVisualizer.js';
import { createVisualizer } from '../../src/visualizer/index.js';
import { visualizerSettings } from '../../src/visualizer/settings.js';

describe('SleeveVisualizer', () => {
  const monitor = { name: 'DP-3' };
  const geometry = { x: 0, y: 320, width: 2560, height: 800 };
  const adapterFor = (sleeve, exec = async () => { throw new Error('not installed'); }) => {
    const settings = visualizerSettings({ engine: 'sleeve', sleeve });
    return createVisualizer(settings, { ...settings.instances[0], name: 'lyrics' }, { runtimeDir: '/nonexistent', exec });
  };

  it('is the adapter for the sleeve engine', () => {
    expect(adapterFor({})).to.be.instanceOf(SleeveVisualizer);
  });

  it('starts as the contract says, passing only the options set', () => {
    const { file, args } = adapterFor({}).command(monitor, geometry);
    expect(file).to.equal('sleeve');
    expect(args).to.deep.equal([
      'shell', '--managed', '--geometry', '2560x800+0+320', '--title', 'backdrop-visualizer-DP-3-lyrics', '--instance', 'DP-3-lyrics'
    ]);
  });

  it('passes each option that is set, and a configured path', () => {
    const { file, args } = adapterFor({ now: 'full', now_position: 'bottom-left', lyrics_align: 'center', no_sandbox: true, command: '/opt/sleeve' }).command(monitor, geometry);
    expect(file).to.equal('/opt/sleeve');
    expect(args.slice(8)).to.deep.equal(['--now', 'full', '--now-position', 'bottom-left', '--lyrics-align', 'center', '--no-sandbox']);
  });

  it('has a window title the manager can find', () => {
    expect(adapterFor({}).title(monitor)).to.equal('backdrop-visualizer-DP-3-lyrics');
  });

  it('builds sleeve ctl display, by page name', () => {
    const adapter = adapterFor({});
    expect(adapter.display(monitor, { reset: true }).args).to.deep.equal(['ctl', 'display', '--instance', 'DP-3-lyrics', '--reset']);
    expect(adapter.display(monitor, { visible: false }).args.at(-1)).to.equal('--hide');
    expect(adapter.display(monitor, { visible: true }).args.at(-1)).to.equal('--show');
    expect(adapter.display(monitor, { look: { now: 'full', nowPosition: 'top-right', lyricsAlign: 'left' } }).args.slice(4))
      .to.deep.equal(['--preset', 'full', '--position', 'top-right', '--align', 'left']);
  });

  it('writes colors as one JSON line, and nothing until there are some', () => {
    const adapter = adapterFor({});
    const colors = { background: '#102030', main: [{ color: '#aabbcc', share: 0.6 }] };
    expect(adapter.colorLines(colors)).to.deep.equal([`${JSON.stringify(colors)}\n`]);
    expect(adapter.colorLines({})).to.deep.equal([]);
    expect(adapter.colorLines(null)).to.deep.equal([]);
  });

  it('has nothing to prepare', async () => {
    await adapterFor({}).prepare();
  });

  describe('the wallpaper layer', () => {
    const screen = { name: 'DP-3', width: 2560, height: 1440 };
    const whole = { x: 0, y: 0, width: 2560, height: 1440 };
    const version = text => async () => `${text}\n`;

    it('passes the areas and background at the start and over ctl', async () => {
      const adapter = adapterFor({ lyrics_area: '33%x100%+0+0', now_area: '67%x100%+33%+0', background: '#10203099' }, version('0.37.0'));
      await adapter.prepare();
      expect(adapter.command(monitor, geometry).args.slice(8)).to.deep.equal([
        '--lyrics-area', '33%x100%+0+0', '--now-area', '67%x100%+33%+0', '--background', '#10203099'
      ]);
      expect(adapter.display(monitor, { look: { lyricsArea: '50%x100%+0+0', nowArea: null, background: 'cover@0.6' } }).args.slice(4))
        .to.deep.equal(['--lyrics-area', '50%x100%+0+0', '--background', 'cover@0.6']);
    });

    it('maps below by itself for a window filling its monitor, only on a sleeve that knows the option', async () => {
      const current = adapterFor({}, version('0.36.0'));
      await current.prepare();
      expect(current.command(screen, whole).args).to.include('--map-below');
      expect(current.command(screen, { x: 0, y: 1000, width: 2560, height: 440 }).args).to.not.include('--map-below');

      const old = adapterFor({}, version('0.33.0'));
      await old.prepare();
      expect(old.command(screen, whole).args).to.not.include('--map-below');
      const unknown = adapterFor({});
      await unknown.prepare();
      expect(unknown.command(screen, whole).args).to.not.include('--map-below');
    });

    it('lets map_below override that, either way', async () => {
      const off = adapterFor({ map_below: false }, version('0.37.0'));
      await off.prepare();
      expect(off.command(screen, whole).args).to.not.include('--map-below');
      const on = adapterFor({ map_below: true }, version('0.37.0'));
      await on.prepare();
      expect(on.command(screen, { x: 0, y: 0, width: 100, height: 100 }).args).to.include('--map-below');
    });

    it('reports an older sleeve by name rather than letting it exit 2 on the option', async () => {
      for (const sleeve of [{ lyrics_area: '33%x100%+0+0' }, { now_area: '33%x100%+0+0' }, { background: 'cover' }, { map_below: true }]) {
        const failure = await adapterFor(sleeve, version('0.35.9')).prepare().catch(error => error.message);
        expect(failure).to.equal('visualizer.sleeve areas, background and map_below need sleeve 0.36.0 or later (found 0.35.9)');
      }
      await adapterFor({}, version('0.33.0')).prepare();
      await adapterFor({ background: 'cover' }, version('1.0.0')).prepare();
    });
  });
});
