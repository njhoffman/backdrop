import { expect } from 'chai';
import { SleeveVisualizer } from '../../src/visualizer/SleeveVisualizer.js';
import { createVisualizer } from '../../src/visualizer/index.js';
import { visualizerSettings } from '../../src/visualizer/settings.js';

describe('SleeveVisualizer', () => {
  const monitor = { name: 'DP-3' };
  const geometry = { x: 0, y: 320, width: 2560, height: 800 };
  const adapterFor = sleeve => {
    const settings = visualizerSettings({ engine: 'sleeve', sleeve });
    return createVisualizer(settings, { ...settings.instances[0], name: 'lyrics' }, { runtimeDir: '/nonexistent' });
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
});
