import { expect } from 'chai';
import { EventEmitter } from 'events';
import { watch as watchFiles } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { ImportWatcher } from '../../src/display/daemon/ImportWatcher.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('ImportWatcher', () => {
  let tempDir;
  let config;
  let watched;
  let runs;
  let results;
  let daemon;
  let warnings;

  const fakeWatch = (dir, options, listener) => {
    const watcher = new EventEmitter();
    watcher.close = () => { watcher.closed = true; };
    watched.push({ dir, options, listener, watcher });
    return watcher;
  };

  function makeWatcher(overrides = {}) {
    daemon = {
      config,
      logger: { ...silentLogger, warn: (message, meta) => warnings.push([message, meta]) },
      watch: fakeWatch,
      stopping: false,
      importing: Promise.resolve(),
      firstMonitor: () => ({ name: 'DP-1', width: 2560, height: 1440 }),
      importDirs: async (monitor, options) => { runs.push({ monitor: monitor.name, ...options }); return results.shift() ?? { imported: [] }; },
      ...overrides
    };
    return new ImportWatcher(daemon, { settle: 10, retry: 30 });
  }
  // Waits for a scheduled pass to run
  const settled = async (ms = 25) => { await sleep(ms); await daemon.importing; };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-watch-'));
    await fs.ensureDir(path.join(tempDir, 'a'));
    await fs.ensureDir(path.join(tempDir, 'b'));
    config = makeConfig({
      'library.import_dirs': [path.join(tempDir, 'a'), path.join(tempDir, 'b'), path.join(tempDir, 'missing')],
      'library.watch_imports': true,
      'paths.media': path.join(tempDir, 'a', 'library', 'media'),
      'paths.trash': path.join(tempDir, 'a', 'library', 'trash')
    });
    watched = [];
    runs = [];
    results = [];
    warnings = [];
  });
  afterEach(async () => { await fs.remove(tempDir); });

  it('watches each existing import folder recursively', () => {
    const watcher = makeWatcher();
    watcher.start();

    expect(watched.map(entry => entry.dir)).to.deep.equal([path.join(tempDir, 'a'), path.join(tempDir, 'b')]);
    expect(watched[0].options).to.deep.equal({ recursive: true });
    watcher.stop();
  });

  it('watches nothing when watch_imports is off', () => {
    config.set('library.watch_imports', false);
    makeWatcher().start();
    expect(watched).to.deep.equal([]);
  });

  it('replaces its watches when started again and closes them on stop', () => {
    const watcher = makeWatcher();
    watcher.start();
    const first = watched.map(entry => entry.watcher);
    watcher.start();

    expect(first.every(entry => entry.closed)).to.be.true;
    watcher.stop();
    expect(watched.slice(2).every(entry => entry.watcher.closed)).to.be.true;
    expect(watcher.watching).to.deep.equal([]);
  });

  it('imports once a burst of changes has settled, with the settle age', async () => {
    const watcher = makeWatcher();
    watcher.start();
    for (const name of ['x.png', 'x.png', 'sub/y.mp4']) watched[0].listener('change', name);

    await settled();

    expect(runs).to.deep.equal([{ monitor: 'DP-1', settle: 10 }]);
    watcher.stop();
  });

  it('ignores hidden files and the library\'s own folders inside an import folder', async () => {
    const watcher = makeWatcher();
    watcher.start();
    for (const name of ['.x.png.part', 'sub/.cache/y.png', 'library/media/local-1.png', 'library/trash/local-2.png']) {
      watched[0].listener('rename', name);
    }

    await settled();

    expect(runs).to.deep.equal([]);
    watcher.stop();
  });

  it('tries again while files are still changing or `backdrop import` holds the lock', async () => {
    results.push({ imported: [], recent: 1 }, { imported: [], locked: true }, { imported: [] });
    const watcher = makeWatcher();
    watcher.start();
    watched[1].listener('rename', 'new.png');

    await settled(25);
    expect(runs).to.have.length(2);
    await settled(45);
    expect(runs).to.have.length(3);
    await settled(45);
    expect(runs).to.have.length(3);
    watcher.stop();
  });

  it('stops watching a folder whose watch fails', () => {
    const watcher = makeWatcher();
    watcher.start();
    watched[0].watcher.emit('error', new Error('ENOENT'));

    expect(watched[0].watcher.closed).to.be.true;
    expect(watcher.watching).to.deep.equal([path.join(tempDir, 'b')]);
    expect(warnings[0][1]).to.include({ error: 'ENOENT' });
    watcher.stop();
  });

  it('does nothing once the daemon is stopping', async () => {
    const watcher = makeWatcher();
    watcher.start();
    daemon.stopping = true;
    watched[0].listener('rename', 'x.png');

    await settled();

    expect(runs).to.deep.equal([]);
    watcher.stop();
  });

  it('sees a file written into a subfolder through a real recursive watch', async () => {
    await fs.ensureDir(path.join(tempDir, 'b', 'deep'));
    const watcher = makeWatcher({ watch: watchFiles });
    watcher.start();

    await fs.outputFile(path.join(tempDir, 'b', 'deep', 'new.png'), 'image');
    for (let i = 0; i < 50 && !runs.length; i++) await settled(20);

    expect(runs).to.have.length(1);
    watcher.stop();
  });
});
