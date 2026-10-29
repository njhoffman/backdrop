import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { ListCommand } from '../../src/commands/ListCommand.js';
import { StatsCommand, directoryUsage } from '../../src/commands/StatsCommand.js';
import { statePath } from '../../src/display/Daemon.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('ListCommand and StatsCommand', () => {
  let dir, db, config, command, rating;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-list-'));
    db = new DatabaseManager(); db.initialize(':memory:'); config = makeConfig();
    rating = { rate: sinon.stub().resolves() };
    command = new ListCommand(config, db, silentLogger, { rating });
    sinon.stub(console, 'log');
  });
  afterEach(async () => { sinon.restore(); db.close(); await fs.remove(dir); });
  async function add(kind, source, n) {
    const file = path.join(dir, `${n}.png`); await fs.writeFile(file, 'media');
    return db.addMedia({ kind, source, source_id: n, path: file, width: 3840, height: 2160 });
  }

  it('filters current ratings, monitor orientation, source, keywords and limit together', async () => {
    const first = await add('image', 'pexels', 1);
    const second = await add('image', 'local', 2);
    db.addRating(first, 3, '1080x1920'); db.addRating(first, 1, '1920x1080');
    db.addRating(second, 2, '1080x1920');
    const search = db.addSearch('pexels', 'Ocean Waves'); db.addSearchResult(search, first, 1);
    expect((await command.listImages({ rated: 'portrait' })).map(m => m.id)).to.deep.equal([second]);
    expect((await command.listImages({ rated: true, local: false, keywords: ['ocean', 'waves'], number: 1 })).map(m => m.id)).to.deep.equal([first]);
    expect(await command.listImages({ minRating: 3 })).to.deep.equal([]);
  });

  it('lists GIFs in video mode and excludes undownloaded rows', async () => {
    const gif = await add('gif', 'local', 1);
    db.addMedia({ kind: 'video', source: 'pexels', source_id: 2 });
    expect((await command.listVideos()).map(m => m.id)).to.deep.equal([gif]);
  });

  it('exports existing matching files to an explicit M3U path', async () => {
    const id = await add('image', 'local', 1); const missing = await add('image', 'local', 2);
    await fs.unlink(db.getMedia(missing).path);
    const file = path.join(dir, 'playlists', 'images.m3u');
    await command.listImages({ playlist: file });
    expect(await fs.readFile(file, 'utf8')).to.equal(`#EXTM3U\n${db.getMedia(id).path}\n`);
  });

  it('routes interactive rating through the same lifecycle as the playback commands', async () => {
    const id = await add('image', 'local', 1);
    command.prompt = async () => ({ action: 0 });
    await command.listImages({ interactive: true });
    expect(rating.rate.calledOnce).to.be.true;
    expect(rating.rate.firstCall.args[0].id).to.equal(id);
    expect(rating.rate.firstCall.args[1]).to.equal(0);
  });

  it('prints one tab-separated line per item without a summary row for fzf', async () => {
    const id = await add('image', 'local', 1); db.addRating(id, 2);
    await command.listImages({ line: true });
    const printed = console.log.getCalls().map(call => call.args[0]);
    expect(printed).to.have.length(1);
    expect(printed[0].split('\t')).to.deep.equal([`#${id}`, 'image', '3840x2160', '', '', 'landscape', '2/3', 'local', '', db.getMedia(id).path]);
  });

  it('rejects invalid filters', async () => {
    for (const options of [{ number: '2abc' }, { minRating: '4' }, { rated: 'diagonal' }, { status: 'bad' }]) {
      let caught; try { await command.listImages(options); } catch (error) { caught = error; }
      expect(caught).to.be.instanceOf(Error);
    }
  });

  it('prints accurate offline statistics and labels cached quota information', async () => {
    const id = await add('image', 'local', 1); db.addRating(id, 2);
    db.setSetting('source_rate_limit:pexels', { limit: 20000, remaining: 123, reset: 2000000000 });
    const stats = await new StatsCommand(config, db, silentLogger).showStats();
    expect(stats.media.image.kept).to.equal(1);
    expect(console.log.args.flat().join('\n')).to.include('last response').and.include('123 / 20000');
  });

  it('prints aligned stats sections with breakdowns, storage and per-monitor eligibility, plain when piped', async () => {
    config = makeConfig({ 'paths.media': path.join(dir, 'media'), 'paths.inbox': path.join(dir, 'inbox'),
      'paths.trash': path.join(dir, 'trash'), 'paths.runtime': dir });
    await fs.outputFile(path.join(dir, 'media', 'a.mp4'), Buffer.alloc(2048));
    const image = await add('image', 'pexels', 1); db.addRating(image, 3, '1920x1080');
    const video = db.addMedia({ kind: 'video', source: 'local', source_id: 2, path: path.join(dir, 'media', 'a.mp4'),
      width: 1920, height: 1080, duration: 90 });
    db.addRating(video, 1, '1080x1920');
    db.addMedia({ kind: 'video', source: 'pexels', source_id: 3, width: 3840, height: 2160 });
    const search = db.addSearch('pexels', 'Ocean'); db.addSearchResult(search, image, 1);
    await fs.writeJson(statePath(dir), { pid: process.pid, monitors: [{ name: 'DP-1', width: 1920, height: 1080 }] });

    const stats = await new StatsCommand(config, db, silentLogger).showStats();

    const text = console.log.args.map(args => args[0] ?? '').join('\n');
    expect(stats.media.video.kept).to.equal(1);
    expect(text).to.include([
      'Library',
      '  kind   total  new  kept  skipped  pending  playing time',
      '  video      1    0     1        0        1         1m30s',
      '  gif        0    0     0        0        0             -',
      '  image      1    0     1        0        0             -',
      '  total      2    0     2        0        1         1m30s'
    ].join('\n'));
    expect(text).to.include('  3/3      1  50%\n  2/3      0   0%\n  1/3      1  50%\n  skipped  0');
    expect(text).to.include('  4K       1  50%\n  1440p    0   0%\n  1080p    1  50%\n  smaller  0   0%');
    expect(text).to.include('  pexels      2           1     1        0        1         3.0\n  local       1           1     1        0        0         1.0');
    expect(text).to.include('  "Ocean"        1           1     1');
    expect(text).to.include('all time: 1 search');
    expect(text).to.match(/media {2}1 files {2}2\.0 KB {2}\S+media/);
    expect(text).to.include('  DP-1     1920x1080       1       1');
    expect(text).to.not.include('Playback cost');
    db.addPlaybackSample(video, 600, 30); db.setDecoder(video, 'vaapi');
    console.log.resetHistory();
    await new StatsCommand(config, db, silentLogger).showStats();
    const cost = console.log.args.map(args => args[0] ?? '').join('\n');
    expect(cost).to.include('Playback cost (mpv CPU, % of one core)\n  kind   size   decoder   items  sampled  avg cpu\n  video  1080p  hardware      1   10m00s     5.0%');
    expect(cost).to.include(`#${video} 1920x1080  cpu 5.0% over 10m00s, vaapi`);
    expect(text).to.not.match(/\x1b|█/);
  });

  it('counts files and bytes under a directory, treating a missing one as empty', async () => {
    await fs.outputFile(path.join(dir, 'u', 'a'), 'abc');
    await fs.outputFile(path.join(dir, 'u', 'sub', 'b'), 'de');
    expect(await directoryUsage(path.join(dir, 'u'))).to.deep.equal({ files: 2, bytes: 5 });
    expect(await directoryUsage(path.join(dir, 'missing'))).to.deep.equal({ files: 0, bytes: 0 });
  });
});
