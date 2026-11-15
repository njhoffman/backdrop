import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { CopiesCommand } from '../../src/commands/CopiesCommand.js';
import { checkCopies, renameIdCopies } from '../../src/library/copies.js';
import { reversedPath } from '../../src/library/reverse.js';
import { smoothedPath, smoothedReversedPath, smoothedSizePath } from '../../src/library/smooth.js';
import { fakeSha, makeConfig, silentLogger } from '../helpers/fakes.js';

const OLD = new Date('2020-01-01');
const HD = { name: 'DP-1', width: 1920, height: 1080 };

describe('CopiesCommand', () => {
  let dir, db, config, lines, send;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-copies-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({
      'paths.bounce': path.join(dir, 'bounce'), 'paths.smooth': path.join(dir, 'smooth'),
      'display.smooth': true, 'display.video_loop': 'bounce'
    });
    lines = [];
    send = sinon.stub().resolves();
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
    sinon.stub(console, 'error').callsFake(line => lines.push(line));
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(dir);
  });

  async function video(n, { width = 3840, height = 2160, speed = 0.5 } = {}) {
    const file = path.join(dir, 'media', `${n}.mp4`);
    await fs.outputFile(file, 'video');
    await fs.utimes(file, OLD, OLD);
    return db.getMedia(db.addMedia({ kind: 'video', source: 'local', source_id: n, sha256: fakeSha(n), path: file, width, height, duration: 10, fps: 30, speed }));
  }

  // A smoothed copy (and its reversed copy) recorded at size, or with no size when size is null
  async function smoothed(media, size) {
    const smooth = config.get().paths.smooth;
    await fs.outputFile(smoothedPath(media, smooth), 'copy');
    await fs.outputFile(smoothedReversedPath(media, smooth), 'reversed copy');
    if (size) await fs.writeJson(smoothedSizePath(media, smooth), size);
  }

  const command = ({ state = null, monitors = [] } = {}) => new CopiesCommand(config, db, silentLogger, {
    send, read: async () => state, monitors: async () => monitors
  });

  it('marks copies unwanted, too small for the monitors or unsized, and passes the rest', async () => {
    const fine = await video(1);
    const small = await video(2);
    const unsized = await video(3);
    const upgraded = await video(4);
    const skipped = await video(5);
    await smoothed(fine, { width: 1920, height: 1080 });
    await smoothed(small, { width: 1280, height: 720 });
    await smoothed(unsized, null);
    // The video replaced after its copy was made (download --upgrade): the copy is of content no item has now
    await fs.outputFile(reversedPath({ sha256: fakeSha(40) }, config.get().paths.bounce), 'reversed');
    await fs.outputFile(reversedPath(upgraded, config.get().paths.bounce), 'reversed');
    await fs.outputFile(reversedPath(skipped, config.get().paths.bounce), 'reversed');
    db.addRating(skipped.id, 0);

    const copies = await checkCopies({ config: config.get(), database: db, monitors: [HD] });
    const problems = Object.fromEntries(copies.map(copy => [`${copy.id} ${copy.copy}`, copy.problem]));
    expect(problems).to.deep.equal({
      '1 smoothed': null, '1 smoothed reversed': null,
      '2 smoothed': 'small', '2 smoothed reversed': null,
      '3 smoothed': 'unsized', '3 smoothed reversed': null,
      '4 reversed': null, '5 reversed': 'unwanted', 'null reversed': 'unwanted'
    });
    expect(copies.at(-1)).to.deep.include({ id: null, sha256: fakeSha(40) });
    expect(copies.find(copy => copy.problem === 'small')).to.deep.include({ size: { width: 1280, height: 720 }, need: { width: 1920, height: 1080 } });
    // Without monitors, sizes go unchecked
    const unchecked = await checkCopies({ config: config.get(), database: db });
    expect(unchecked.find(copy => copy.id === small.id && copy.copy === 'smoothed').problem).to.equal(null);
  });

  it('lists the problems and a summary, and asks the daemon to sync only with --sync', async () => {
    const small = await video(1);
    await smoothed(small, { width: 1280, height: 720 });
    await command({ monitors: [HD] }).run();
    expect(lines.join('\n')).to.include('#1 smoothed: smaller than the monitors need (1280x720, needs 1920x1080)');
    expect(lines.join('\n')).to.include('2 copies');
    expect(lines.join('\n')).to.include('1 smaller than the monitors need');
    expect(send.called).to.equal(false);

    // No daemon: nothing sent, and start named
    lines.length = 0;
    expect((await command({ monitors: [HD] }).run({ sync: true })).synced).to.equal(false);
    expect(lines.join('\n')).to.include('backdrop start');

    // The daemon's monitors are used over xrandr's, and the request goes to it
    const state = { pid: 1, monitors: [{ name: 'DP-3', width: 1280, height: 720 }] };
    lines.length = 0;
    const result = await command({ state, monitors: [HD] }).run({ sync: true });
    expect(result.synced).to.equal(true);
    expect(send.firstCall.args[2]).to.deep.equal({ copies: true });
    expect(result.copies.every(copy => !copy.problem)).to.equal(true);
    // With every copy playing, it says there was nothing to remake rather than that copies are being deleted
    expect(lines.join('\n')).to.include('Nothing to remake');
    expect(lines.join('\n')).to.not.include('deleting those');

    lines.length = 0;
    const tooSmall = { pid: 1, monitors: [HD] };
    await command({ state: tooSmall }).run({ sync: true });
    expect(lines.join('\n')).to.include('deleting those');
  });

  it('names a copy of replaced content by the start of its sha256', async () => {
    await fs.outputFile(reversedPath({ sha256: fakeSha(40) }, config.get().paths.bounce), 'reversed');
    await command({ monitors: [HD] }).run();
    expect(lines.join('\n')).to.include(`${fakeSha(40).slice(0, 12)} reversed: no longer wanted`);
  });

  it('prints JSON', async () => {
    await smoothed(await video(1), { width: 1920, height: 1080 });
    await command({ monitors: [HD] }).run({ json: true });
    const json = JSON.parse(lines.at(-1));
    expect(json.copies).to.have.length(2);
    expect(json.monitors).to.deep.equal([{ name: 'DP-1', width: 1920, height: 1080 }]);
    expect(json.synced).to.equal(false);
  });

  describe('renameIdCopies', () => {
    const names = async folder => (await fs.readdir(folder)).sort();

    it('renames copies, size records and work folders named for the id to the content, keeping their times', async () => {
      const media = await video(1);
      const bounce = config.get().paths.bounce;
      const smooth = config.get().paths.smooth;
      await fs.outputFile(path.join(bounce, '1.mp4'), 'reversed');
      await fs.outputFile(path.join(bounce, '1.reverse.work', 'c00000.mp4'), 'chunk');
      for (const name of ['1@0.5.mp4', '1@0.5.reversed.mp4', '1@0.5.json', '1@0.5.smooth.work/p00000.mp4', '1@0.5.reversed.reverse.work/c00000.mp4']) {
        await fs.outputFile(path.join(smooth, name), 'x');
      }
      const made = new Date('2021-06-01');
      await fs.utimes(path.join(smooth, '1@0.5.mp4'), made, made);
      const S = fakeSha(1);

      expect(await renameIdCopies(bounce, db)).to.deep.equal({ renamed: 2, removed: 0 });
      expect(await renameIdCopies(smooth, db)).to.deep.equal({ renamed: 5, removed: 0 });
      expect(await names(bounce)).to.deep.equal([`${S}.mp4`, `${S}.reverse.work`]);
      expect(await names(smooth)).to.deep.equal([`${S}@0.5.json`, `${S}@0.5.mp4`, `${S}@0.5.reversed.mp4`, `${S}@0.5.reversed.reverse.work`, `${S}@0.5.smooth.work`]);
      expect((await fs.stat(smoothedPath(media, smooth))).mtime.getTime()).to.equal(made.getTime());
      // A second start finds nothing to rename
      expect(await renameIdCopies(smooth, db)).to.deep.equal({ renamed: 0, removed: 0 });
    });

    it('removes what the old names had no use for: gone items, items without a file, and forward copies older than the file', async () => {
      const kept = await video(1);
      const replaced = await video(2);
      const purged = await video(3);
      db.updateMedia(purged.id, { path: null });
      const bounce = config.get().paths.bounce;
      const smooth = config.get().paths.smooth;
      await fs.outputFile(path.join(bounce, '1.mp4'), 'reversed');
      await fs.outputFile(path.join(bounce, '3.mp4'), 'reversed');
      await fs.outputFile(path.join(bounce, '99.mp4'), 'no such item');
      await fs.outputFile(path.join(bounce, 'notes.txt'), 'left alone');
      // Item 2's file is newer than its copies: the forward copy and its size record go, its reversal moves
      for (const name of ['2@0.5.mp4', '2@0.5.json', '2@0.5.reversed.mp4']) await fs.outputFile(path.join(smooth, name), 'x');
      const before = new Date('2019-01-01');
      for (const name of ['2@0.5.mp4', '2@0.5.json']) await fs.utimes(path.join(smooth, name), before, before);
      // A copy already under the new name wins over the old one
      await fs.outputFile(path.join(smooth, '1@0.5.mp4'), 'old');
      await fs.outputFile(smoothedPath(kept, smooth), 'new');

      expect(await renameIdCopies(bounce, db)).to.deep.equal({ renamed: 1, removed: 2 });
      expect(await names(bounce)).to.deep.equal([`${fakeSha(1)}.mp4`, 'notes.txt']);
      expect(await renameIdCopies(smooth, db)).to.deep.equal({ renamed: 1, removed: 3 });
      expect(await names(smooth)).to.deep.equal([`${fakeSha(1)}@0.5.mp4`, `${fakeSha(2)}@0.5.reversed.mp4`]);
      expect(await fs.readFile(smoothedPath(kept, smooth), 'utf8')).to.equal('new');
      expect(replaced.sha256).to.equal(fakeSha(2));
      expect(await renameIdCopies(path.join(dir, 'missing'), db)).to.deep.equal({ renamed: 0, removed: 0 });
      expect(await renameIdCopies(null, db)).to.deep.equal({ renamed: 0, removed: 0 });
    });
  });
});
