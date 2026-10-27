import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Importer, hashFile } from '../../src/library/Importer.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// Fake ffprobe: files are text whose content names their kind and size, e.g. "video 3840x2160"
async function fakeProbe(file) {
  const match = /^(image|video|gif) (\d+)x(\d+)/.exec(await fs.readFile(file, 'utf8'));
  if (!match) {
    return null;
  }
  return { kind: match[1], width: Number(match[2]), height: Number(match[3]), duration: match[1] === 'image' ? null : 10 };
}

describe('Importer', () => {
  let tempDir;
  let source;
  let db;
  let config;
  let importer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-import-'));
    source = path.join(tempDir, 'source');
    await fs.ensureDir(source);
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({
      'paths.media': path.join(tempDir, 'library', 'media'),
      'paths.trash': path.join(tempDir, 'library', 'trash')
    });
    importer = new Importer({ config, database: db, logger: silentLogger, probe: fakeProbe });
  });

  afterEach(async () => {
    db.close();
    await fs.remove(tempDir);
  });

  async function write(relative, content) {
    const file = path.join(source, relative);
    await fs.outputFile(file, content);
    return file;
  }

  const run = (options) => importer.importDirs([source], options);

  it('reports the file total before importing and a running count after each file', async () => {
    await write('a.jpg', 'image 2560x1440');
    await write('b.jpg', 'image 2560x1440');
    const events = [];

    await run({ onStart: total => events.push(['start', total]), onFile: (file, outcome, done) => events.push([path.basename(file), done]) });

    expect(events).to.deep.equal([['start', 2], ['a.jpg', 1], ['b.jpg', 2]]);
  });

  it('copies files into the library as local-<n> with the original name kept', async () => {
    const original = await write('Beach Sunset.JPG', 'image 2560x1440');

    const summary = await run();
    const media = db.getMedia(summary.imported[0]);

    expect(media.path).to.equal(path.join(tempDir, 'library', 'media', 'local-1.jpg'));
    expect(media).to.include({ kind: 'image', source: 'local', source_id: '1', original_name: 'Beach Sunset.JPG', width: 2560, height: 1440 });
    expect(media.sha256).to.equal(await hashFile(original));
    expect(await fs.readFile(media.path, 'utf8')).to.equal('image 2560x1440');
    expect(await fs.pathExists(original)).to.be.true;
  });

  it('marks imports as kept with the default rating against the given resolution', async () => {
    await write('a.mp4', 'video 3840x2160');
    config.set('library.default_import_rating', 3);

    const { imported } = await run({ resolution: '1080x1920' });

    expect(db.getMedia(imported[0]).status).to.equal('kept');
    expect(db.getLatestRating(imported[0])).to.include({ rating: 3, orientation: 'portrait', resolution: '1080x1920' });
  });

  it('numbers files in path order and never reuses a number', async () => {
    await write('b.png', 'image 2000x2000');
    await write('a.png', 'image 2000x2001');

    const first = await run();
    expect(first.imported.map(id => path.basename(db.getMedia(id).path))).to.deep.equal(['local-1.png', 'local-2.png']);

    db.deleteMedia(first.imported[1]);
    await write('c.png', 'image 2000x2002');
    const second = await run();
    expect(path.basename(db.getMedia(second.imported[0]).path)).to.equal('local-3.png');
  });

  it('searches subdirectories but skips hidden paths, other extensions and its own library', async () => {
    await write('nested/deep/a.webm', 'video 1920x1080');
    await write('.cache/b.png', 'image 1920x1080');
    await write('nested/.c.png', 'image 1920x1080');
    await write('notes.txt', 'image 1920x1080');
    config.set('paths.media', path.join(source, 'library'));
    await write('library/local-9.png', 'image 1920x1080');

    const summary = await run();

    expect(summary.scanned).to.equal(1);
    expect(db.getMedia(summary.imported[0]).original_name).to.equal('a.webm');
  });

  it('rejects anything below the minimum resolution, in either orientation', async () => {
    await write('small.png', 'image 1023x768');
    await write('portrait.png', 'image 768x1024');
    await write('tiny.gif', 'gif 320x240');

    const summary = await run();

    expect(summary.tooSmall).to.equal(2);
    expect(summary.imported).to.have.length(1);
    expect(db.getImportedFile(path.join(source, 'tiny.gif'))).to.include({ status: 'too_small', detail: '320x240' });
  });

  it('respects a configured minimum', async () => {
    config.set('library.min_width', 3840);
    config.set('library.min_height', 2160);
    await write('hd.mp4', 'video 1920x1080');

    expect((await run()).tooSmall).to.equal(1);
  });

  it('records duplicates by content without copying them', async () => {
    await write('a.png', 'image 2000x2000');
    await write('copy/a-again.png', 'image 2000x2000');

    const summary = await run();

    expect(summary.imported).to.have.length(1);
    expect(summary.duplicates).to.equal(1);
    expect(db.getImportedFile(path.join(source, 'copy', 'a-again.png')).media_id).to.equal(summary.imported[0]);
    expect(await fs.readdir(config.getPath('media'))).to.deep.equal(['local-1.png']);
  });

  it('records files ffprobe cannot read as unsupported', async () => {
    await write('broken.jpg', 'garbage');
    const summary = await run();

    expect(summary.unsupported).to.equal(1);
    expect(db.findMedia()).to.have.length(0);
  });

  it('skips unchanged files on later runs without reading them', async () => {
    await write('a.png', 'image 2000x2000');
    await write('small.png', 'image 100x100');
    await run();

    let probes = 0;
    importer.probe = async file => { probes++; return fakeProbe(file); };
    const summary = await run();

    expect(summary).to.include({ scanned: 2, unchanged: 2, tooSmall: 0 });
    expect(probes).to.equal(0);
  });

  it('re-checks a file whose size or modification time changed', async () => {
    const file = await write('a.png', 'image 100x100');
    await run();

    await fs.writeFile(file, 'image 3000x2000');
    const summary = await run();

    expect(summary.imported).to.have.length(1);
    expect(db.getImportedFile(file).status).to.equal('imported');
  });

  it('records failures and keeps going', async () => {
    await write('a.png', 'image 2000x2000');
    await write('b.png', 'image 2001x2000');
    let calls = 0;
    importer.probe = async file => {
      if (++calls === 1) {
        throw new Error('probe crashed');
      }
      return fakeProbe(file);
    };
    importer.addToLibrary = async () => { throw new Error('disk full'); };

    const summary = await run();

    expect(summary.unsupported).to.equal(1);
    expect(summary.failed).to.equal(1);
    expect(db.getImportedFile(path.join(source, 'b.png'))).to.include({ status: 'failed', detail: 'disk full' });
  });

  it('treats losing a race to a concurrent import as a duplicate and removes its copy', async () => {
    const file = await write('a.png', 'image 2000x2000');
    const sha256 = await hashFile(file);
    const winner = db.addMedia({ kind: 'image', source: 'local', source_id: 'other', sha256 });
    // The other import commits between this import's duplicate check and its insert
    const realLookup = db.getMediaBySha256.bind(db);
    let lookups = 0;
    db.getMediaBySha256 = hash => (++lookups === 1 ? null : realLookup(hash));

    const summary = await run();

    expect(summary.duplicates).to.equal(1);
    expect(db.getImportedFile(file).media_id).to.equal(winner);
    expect(await fs.readdir(config.getPath('media'))).to.deep.equal([]);
  });

  it('warns about missing directories and stops between files when asked', async () => {
    await write('a.png', 'image 2000x2000');
    await write('b.png', 'image 2000x2001');
    const warnings = [];
    importer.logger = { ...silentLogger, warn: (message, meta) => warnings.push(meta.dir) };

    let stop = false;
    const summary = await importer.importDirs([path.join(tempDir, 'missing'), source], {
      shouldStop: () => stop,
      onFile: () => { stop = true; }
    });

    expect(warnings).to.deep.equal([path.join(tempDir, 'missing')]);
    expect(summary.scanned).to.equal(1);
  });
});
