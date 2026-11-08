import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { ConfigService, appliesWhen } from '../../src/services/ConfigService.js';
import { silentLogger } from '../helpers/fakes.js';

describe('ConfigService', () => {
  let dir, file, config, service, savedKey;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-config-service-'));
    file = path.join(dir, 'config.yaml');
    await fs.writeFile(file, [
      '# my config',
      'display:',
      '  image_duration: 5m   # five minutes',
      '  order: shuffle',
      'sources:',
      '  pexels:',
      '    api_key: secret-key',
      ''
    ].join('\n'));
    savedKey = process.env.PEXELS_API;
    delete process.env.PEXELS_API;
    config = new ConfigManager(file);
    await config.loadConfig();
    service = new ConfigService({ config, logger: silentLogger });
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env.PEXELS_API;
    else process.env.PEXELS_API = savedKey;
    await fs.remove(dir);
  });

  const field = (view, key) => view.fields.find(item => item.key === key);

  it('lists every setting with its value in the file\'s form, its default and when it applies', async () => {
    const view = await service.describe();
    expect(view.path).to.equal(file);
    expect(view.errors).to.deep.equal([]);
    expect(field(view, 'display.image_duration')).to.include({ kind: 'duration', value: '5m', default: 300, inFile: true, applies: 'live' });
    expect(field(view, 'display.order')).to.include({ value: 'shuffle', default: 'random', inFile: true });
    expect(field(view, 'display.order').choices).to.deep.equal(['shuffle', 'random']);
    expect(field(view, 'library.min_width')).to.include({ kind: 'integer', min: 0, value: 1024, inFile: false, applies: 'live' });
    expect(field(view, 'display.mpv_args')).to.include({ applies: 'daemon' });
    expect(field(view, 'menu.style').applies).to.equal('command');
    expect(field(view, 'web.port').applies).to.equal('web');
    expect(view.fields.some(item => item.key.startsWith('visualizer.'))).to.equal(false);
  });

  it('never gives a secret\'s value, only whether it is set and where from', async () => {
    const key = field(await service.describe(), 'sources.pexels.api_key');
    expect(key).to.include({ kind: 'secret', set: true, fromEnvironment: false });
    expect(key).to.not.have.property('value');
    expect(JSON.stringify(await service.describe())).to.not.include('secret-key');
  });

  it('writes changes as given, keeping the file\'s comments, and refreshes its own copy', async () => {
    const view = await service.update({ 'display.image_duration': '90s', 'library.trash_days': 7, 'display.mpv_args': ['--hwdec=no'] });
    const text = await fs.readFile(file, 'utf8');
    expect(text).to.include('# my config');
    expect(text).to.include('image_duration: 90s');
    expect(text).to.match(/library:\n {2}trash_days: 7/);
    expect(field(view, 'display.image_duration').value).to.equal('90s');
    expect(config.get().display.image_duration).to.equal(90);
    expect(config.get().library.trash_days).to.equal(7);
  });

  it('writes nothing when a change fails its check or a rule between settings', async () => {
    const before = await fs.readFile(file, 'utf8');
    let caught;
    try { await service.update({ 'display.order': 'sorted', 'library.trash_days': 3 }); } catch (error) { caught = error; }
    expect(caught.message).to.equal('display.order must be shuffle or random, not "sorted"');
    try { await service.update({ 'load.image_above': 30, 'load.off_above': 20 }); } catch (error) { caught = error; }
    expect(caught.message).to.include('load.off_above must be above load.image_above');
    try { await service.update({ 'visualizer.enabled': true }); } catch (error) { caught = error; }
    expect(caught).to.include({ status: 404, message: 'Unknown setting: visualizer.enabled' });
    try { await service.update({}); } catch (error) { caught = error; }
    expect(caught.message).to.include('Give the changes');
    expect(await fs.readFile(file, 'utf8')).to.equal(before);
  });

  it('resets a setting by removing it from the file', async () => {
    const view = await service.reset('display.order');
    expect(await fs.readFile(file, 'utf8')).to.not.include('order: shuffle');
    expect(field(view, 'display.order')).to.include({ value: 'random', inFile: false });
    expect(config.get().display.order).to.equal('random');
  });

  it('shows the file\'s mistakes rather than failing', async () => {
    await fs.appendFile(file, 'library:\n  trash_days: -1\n');
    const view = await service.describe();
    expect(view.errors).to.deep.equal(['library.trash_days must be a whole number from 0, not -1']);
  });

  it('knows when each kind of setting takes effect', () => {
    expect(appliesWhen('display.video_loop')).to.equal('live');
    expect(appliesWhen('load.sustain')).to.equal('live');
    expect(appliesWhen('display.xwinwrap_args')).to.equal('daemon');
    expect(appliesWhen('sources.pexels.per_page')).to.equal('command');
    expect(appliesWhen('web.port')).to.equal('web');
  });
});
