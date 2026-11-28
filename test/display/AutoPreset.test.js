import { expect } from 'chai';
import { AutoPreset, AUTO_SETTING, PREFER_SETTING } from '../../src/display/daemon/AutoPreset.js';
import { silentLogger } from '../helpers/fakes.js';

const pixels = (rgb, count = 16) => Buffer.from(Array.from({ length: count }, () => rgb).flat());
const GREY = pixels([120, 120, 120]);
const RED = pixels([200, 30, 30]);

// A daemon as AutoPreset sees it: settings in memory, one monitor, a visualizer that records the presets it is given
function fakeDaemon({ settings = {}, rules = [] } = {}) {
  const stored = new Map(Object.entries(settings));
  const daemon = {
    stopping: false, logger: silentLogger, spawn: () => null, exec: async () => '',
    database: { getSetting: (key, fallback) => (stored.has(key) ? stored.get(key) : fallback), setSetting: (key, value) => stored.set(key, value) },
    config: { get: () => ({ visualizer: { auto: { rules } } }) },
    monitors: new Map([['DP-1', { name: 'DP-1' }]]),
    samples: new Map(),
    screensaver: { active: null },
    presets: [],
    visualizers: { active: true, presetOverride: null, async setPreset(name) { this.presetOverride = name; daemon.presets.push(name); } },
    enqueue: fn => fn(),
    writeState: async () => {},
    sampleScreen: async () => {}
  };
  return { daemon, stored };
}

// AutoPreset with stand-in watchers whose callbacks the test calls, and a cover the test sets
function auto(daemon, { cover = GREY } = {}) {
  const hooks = {};
  const preset = new AutoPreset(daemon, {
    watchWorkspaces: ({ onChange }) => { hooks.workspaces = onChange; return { start() {}, stop() {} }; },
    followLyrics: ({ onMessage }) => { hooks.lyrics = onMessage; return { start() {}, stop() {} }; },
    coverUrl: async () => 'https://example.invalid/cover.jpg',
    sampleArt: async () => hooks.cover ?? cover
  });
  return { preset, hooks };
}
const song = (key, lines) => ({ type: 'lyrics', key, result: lines === null ? null : { best: { lyrics: { lines } } }, loading: false });

describe('AutoPreset', () => {
  it('is off by default, and picks nothing until turned on', async () => {
    const { daemon } = fakeDaemon();
    const { preset } = auto(daemon);
    preset.begin();
    await preset.decide();
    expect(preset.running).to.equal(false);
    expect(daemon.presets).to.deep.equal([]);
    expect(preset.summary()).to.include({ enabled: false, prefer: 'wallpaper' });
  });

  it('shows bars behind windows, and a black and white cover\'s duotone once nothing covers the monitor', async () => {
    const { daemon, stored } = fakeDaemon({ settings: { [PREFER_SETTING]: 'cover' } });
    const { preset, hooks } = auto(daemon);
    await preset.setEnabled('on');
    expect(stored.get(AUTO_SETTING)).to.equal(true);
    // i3 has said nothing yet: every monitor counts as covered
    expect(daemon.presets).to.deep.equal(['bars']);
    await hooks.lyrics(song('a', [{ text: 'la' }]));
    await hooks.workspaces(new Set(['DP-1']));
    expect(daemon.presets).to.deep.equal(['bars']);
    await hooks.workspaces(new Set());
    expect(daemon.presets).to.deep.equal(['bars', 'lyrics-sharp-duotone']);
    expect(preset.summary()).to.include({ preset: 'lyrics-sharp-duotone', reason: 'a black and white cover' });
    // A colored cover with lyrics
    hooks.cover = RED;
    await hooks.lyrics(song('b', [{ text: 'la' }]));
    expect(daemon.presets.at(-1)).to.equal('lyrics-blurred-soft-tinted');
    // Without lyrics, a look made for none
    await hooks.lyrics(song('c', null));
    expect(daemon.presets.at(-1)).to.equal('cover-radials');
  });

  it('counts the screensaver as full screen, windows or not', async () => {
    const { daemon } = fakeDaemon({ settings: { [AUTO_SETTING]: true } });
    const { preset, hooks } = auto(daemon);
    preset.begin();
    await hooks.workspaces(new Set(['DP-1']));
    await hooks.lyrics(song('a', null));
    expect(daemon.presets.at(-1)).to.equal('bars');
    daemon.screensaver.active = { trigger: 'manual' };
    await preset.screensaverChanged();
    expect(daemon.presets.at(-1)).to.equal('radials');
  });

  it('leaves a preset picked by hand until the next song or a change of view', async () => {
    const { daemon } = fakeDaemon({ settings: { [AUTO_SETTING]: true } });
    const { preset, hooks } = auto(daemon);
    preset.begin();
    await hooks.workspaces(new Set());
    await hooks.lyrics(song('a', [{ text: 'la' }]));
    expect(daemon.presets.at(-1)).to.equal('lyrics-veil');
    daemon.visualizers.presetOverride = 'ring';
    preset.pickedByHand('ring');
    await preset.decide();
    expect(preset.summary().held).to.equal('ring');
    expect(daemon.visualizers.presetOverride).to.equal('ring');
    // The same song's lyrics arriving again change nothing; the next song does
    await hooks.lyrics(song('a', [{ text: 'la' }]));
    expect(daemon.visualizers.presetOverride).to.equal('ring');
    await hooks.lyrics(song('b', [{ text: 'la' }]));
    expect(daemon.visualizers.presetOverride).to.equal('lyrics-veil');
    // And a change of view
    preset.pickedByHand('wave');
    daemon.visualizers.presetOverride = 'wave';
    await hooks.workspaces(new Set(['DP-1']));
    expect(daemon.visualizers.presetOverride).to.equal('bars');
  });

  it('tries the config\'s rules first, and follows the wallpaper or the cover as asked', async () => {
    const rules = [{ when: { view: 'fullscreen', prefer: 'wallpaper' }, preset: 'party', reason: 'mine' }];
    const { daemon, stored } = fakeDaemon({ settings: { [AUTO_SETTING]: true }, rules });
    daemon.samples.set('DP-1', { mediaId: 1, sample: { pixels: RED } });
    const { preset, hooks } = auto(daemon);
    preset.begin();
    await hooks.workspaces(new Set());
    await hooks.lyrics(song('a', [{ text: 'la' }]));
    expect(preset.summary()).to.include({ preset: 'party', reason: 'mine' });
    expect(preset.summary().moment.image).to.deep.equal(['colorful', 'mid']);
    await preset.setPrefer('toggle');
    expect(stored.get(PREFER_SETTING)).to.equal('cover');
    expect(daemon.presets.at(-1)).to.equal('lyrics-sharp-duotone');
    let failure;
    await preset.setPrefer('both').catch(error => { failure = error; });
    expect(failure.message).to.equal('prefer must be cover, wallpaper or toggle, not both');
  });

  it('stops following when turned off, keeping the preset showing', async () => {
    const { daemon, stored } = fakeDaemon({ settings: { [AUTO_SETTING]: true } });
    const { preset } = auto(daemon);
    preset.begin();
    await preset.decide();
    await preset.setEnabled('toggle');
    expect(stored.get(AUTO_SETTING)).to.equal(false);
    expect(preset.running).to.equal(false);
    expect(daemon.visualizers.presetOverride).to.equal('bars');
  });
});
