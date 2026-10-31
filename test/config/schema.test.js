import { expect } from 'chai';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { validateConfig, checkSetting, seconds } from '../../src/config/schema.js';

// The defaults with overrides laid over one section's keys
function config(section, values) {
  const merged = new ConfigManager('/nonexistent').getDefaultConfig();
  if (section === 'sources.pexels') Object.assign(merged.sources.pexels, values);
  else Object.assign(merged[section], values);
  return merged;
}
const errorsFor = (section, values) => validateConfig(config(section, values));

describe('config schema', () => {
  it('accepts the defaults and converts nothing in them', () => {
    const defaults = new ConfigManager('/nonexistent').getDefaultConfig();
    const copy = structuredClone(defaults);
    expect(validateConfig(copy)).to.deep.equal([]);
    expect(copy).to.deep.equal(defaults);
  });

  it('takes durations as seconds or the CLI\'s times, and converts them', () => {
    const merged = config('display', { image_duration: '5m', video_duration: '1.5h' });
    expect(validateConfig(merged)).to.deep.equal([]);
    expect(merged.display).to.include({ image_duration: 300, video_duration: 5400 });
    expect(seconds(90)).to.equal(90);
    expect(seconds('0', { allowZero: true })).to.equal(0);
    expect(errorsFor('display', { image_duration: 0, video_duration: '5 minutes' })).to.deep.equal([
      'display.image_duration must be a time such as 90, 90s, 5m or 1h, not 0',
      'display.video_duration must be a time such as 90, 90s, 5m or 1h (0 loops videos forever), not "5 minutes"'
    ]);
  });

  it('checks display', () => {
    expect(errorsFor('display', { monitors: ['DP-1', 'HDMI-1'] })).to.deep.equal([]);
    expect(errorsFor('display', { monitors: 'DP-1', allow_upscale: 'yes', order: 'sorted', notify: 'always', mpv_args: '--hwdec=vaapi' })).to.deep.equal([
      'display.monitors must be auto or a list of output names such as [DP-1, HDMI-1], not "DP-1"',
      'display.allow_upscale must be true or false, not "yes"',
      'display.order must be shuffle or random, not "sorted"',
      'display.notify must be commands, all or off, not "always"',
      'display.mpv_args must be a list of strings, not "--hwdec=vaapi"'
    ]);
    expect(errorsFor('display', { monitors: [] })).to.have.length(1);
  });

  it('checks library', () => {
    expect(errorsFor('library', { import_dirs: '~/walls', default_import_rating: 4, min_width: -1, trash_days: 1.5 })).to.deep.equal([
      'library.import_dirs must be a list of strings, not "~/walls"',
      'library.default_import_rating must be a whole number from 1 to 3, not 4',
      'library.min_width must be a whole number from 0, not -1',
      'library.trash_days must be a whole number from 0, not 1.5'
    ]);
  });

  it('checks menu, screensaver and output', () => {
    expect(errorsFor('menu', { style: 'grid', rofi_args: [1], workspace: '' })).to.deep.equal([
      'menu.style must be panel or minimal, not "grid"',
      'menu.rofi_args must be a list of strings, not [1]',
      'menu.workspace must be true, false or a workspace name, not ""'
    ]);
    expect(errorsFor('menu', { workspace: 'wall' })).to.deep.equal([]);
    expect(errorsFor('screensaver', { idle_minutes: 0, sources: 'rated', streams: {} })).to.have.length(3);
    expect(errorsFor('output', { symbols: 'emoji', progress_gradient: ['#00c8ff'] })).to.deep.equal([
      'output.symbols must be auto, nerd, unicode or ascii, not "emoji"',
      'output.progress_gradient must be a list of at least two colors such as ["#00c8ff", "#a050ff"], not ["#00c8ff"]'
    ]);
  });

  it('checks the Pexels source and paths, and whole sections that are not mappings', () => {
    expect(errorsFor('sources.pexels', { per_page: 100, image_min_size: 'huge', api_key: 12 })).to.deep.equal([
      'sources.pexels.api_key must be a string, not 12',
      'sources.pexels.per_page must be a whole number from 1 to 80, not 100',
      'sources.pexels.image_min_size must be large, medium or small, not "huge"'
    ]);
    const merged = new ConfigManager('/nonexistent').getDefaultConfig();
    merged.paths.media = 5;
    merged.display = ['auto'];
    expect(validateConfig(merged)).to.deep.equal(['display must be a mapping of settings, not ["auto"]', 'paths.media must be a string, not 5']);
  });

  it('checks one setting with its key named, passing unknown keys through', () => {
    expect(checkSetting('display.image_duration', '2m')).to.equal(120);
    expect(() => checkSetting('display.notify', 'loud')).to.throw('display.notify must be commands, all or off, not "loud"');
    expect(checkSetting('display.whatever', 1)).to.equal(1);
  });
});
