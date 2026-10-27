import { expect } from 'chai';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MpvClient } from '../../src/display/MpvClient.js';
import { DisplayControl } from '../../src/display/DisplayControl.js';
import { RatingCommand } from '../../src/commands/RatingCommand.js';
import { statePath } from '../../src/display/Daemon.js';
import { loadPlaylist, lastMediaKey, removeFailedEntry } from '../../src/display/Playlist.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeVideo(file, size) {
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10:duration=3`,
    '-pix_fmt', 'yuv420p', file
  ]);
}

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for mpv');
}

// Runs a headless mpv (no window, no audio) to check the IPC commands backdrop sends
describe('mpv integration', function () {
  this.timeout(20000);

  let tempDir;
  let mpv;
  let client;
  let db;

  before(function () {
    if (!hasCommand('mpv') || !hasCommand('ffmpeg')) {
      this.skip();
    }
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-int-'));
    const socketPath = path.join(tempDir, 'mpv.sock');
    mpv = spawn('mpv', [
      '--no-config', '--idle=yes', '--vo=null', '--ao=null', '--no-audio', '--loop-playlist=inf',
      `--input-ipc-server=${socketPath}`
    ], { stdio: 'ignore' });
    client = await MpvClient.connect(socketPath, { attempts: 50, delay: 100 });

    db = new DatabaseManager();
    db.initialize(':memory:');
  });

  afterEach(async () => {
    await client.command('quit').catch(() => {});
    client.close();
    mpv.kill();
    db.close();
    await fs.remove(tempDir);
  });

  it('loads the eligible playlist, resumes the last item and applies mode properties', async () => {
    const files = ['a.mp4', 'b.mp4', 'small.mp4'].map(name => path.join(tempDir, name));
    makeVideo(files[0], '640x360');
    makeVideo(files[1], '640x360');
    makeVideo(files[2], '160x90');
    const ids = files.map((file, i) => db.addMedia({
      kind: 'video', source: 'local', source_id: i, path: file,
      width: i === 2 ? 160 : 640, height: i === 2 ? 90 : 360
    }));
    const monitor = { name: 'TEST-1', width: 640, height: 360, x: 0, y: 0 };
    db.setSetting(lastMediaKey('video', monitor.name), ids[1]);

    const count = await loadPlaylist(client, {
      database: db, config: makeConfig().get(), mode: 'video', monitor, runtimeDir: tempDir
    });

    expect(count).to.equal(2);
    expect(await waitFor(() => client.getProperty('path'))).to.equal(files[1]);
    expect(await client.getProperty('playlist-count')).to.equal(2);
    expect(await client.getProperty('loop-file')).to.equal('inf');

    await client.setProperty('speed', 0.6);
    expect(await client.getProperty('speed')).to.be.closeTo(0.6, 0.001);

    await client.command('playlist-next', 'force');
    expect(await waitFor(async () => {
      const current = await client.getProperty('path');
      return current === files[0] ? current : null;
    })).to.equal(files[0]);
  });

  it('removes playing and repeated entries, advances, and idles when the playlist is empty', async () => {
    const first = path.join(tempDir, 'a.mp4');
    const second = path.join(tempDir, 'b.mp4');
    makeVideo(first, '320x180');
    makeVideo(second, '320x180');
    await client.setProperty('loop-file', 'inf');
    await client.command('loadfile', first, 'replace');
    await client.command('loadfile', second, 'append');
    await client.command('loadfile', first, 'append');
    await waitFor(() => client.getProperty('path'));

    const control = new DisplayControl({ config: makeConfig(), database: db });
    // Reuse the test's live connection; production closes each temporary connection.
    control.state = async () => ({ monitors: [{ name: 'TEST-1' }] });
    control.withClient = async (monitor, fn) => fn(client);
    await control.removeMedia({ path: first });

    expect(await client.getProperty('playlist-count')).to.equal(1);
    await waitFor(async () => (await client.getProperty('path')) === second);
    await control.removeMedia({ path: second });
    expect(await client.getProperty('playlist-count')).to.equal(0);
    await waitFor(() => client.getProperty('idle-active'));
  });

  it('drops missing files reported by end-file errors and keeps playing the rest', async () => {
    const file = path.join(tempDir, 'a.mp4');
    makeVideo(file, '320x180');
    const missing = [path.join(tempDir, 'gone-1.mp4'), path.join(tempDir, 'gone-2.mp4')];
    await client.setProperty('image-display-duration', 0.2);
    const removed = [];
    let pending = Promise.resolve();
    client.on('end-file', event => {
      if (event.reason === 'error') {
        pending = pending.then(async () => removed.push(await removeFailedEntry(client, event.playlist_entry_id)));
      }
    });

    await client.command('loadfile', missing[0], 'replace');
    await client.command('loadfile', file, 'append');
    await client.command('loadfile', missing[1], 'append');

    await waitFor(async () => (await client.getProperty('playlist-count')) === 1);
    await pending;
    expect(removed.map(entry => entry.filename)).to.have.members(missing);
    expect((await client.getProperty('playlist'))[0].filename).to.equal(file);
    expect(await waitFor(() => client.getProperty('path'))).to.equal(file);
  });

  it('accepts the brightness values dim sets', async () => {
    await client.setProperty('brightness', -40);
    expect(await client.getProperty('brightness')).to.equal(-40);
    await client.setProperty('brightness', 0);
    expect(await client.getProperty('brightness')).to.equal(0);
  });

  it('reports path changes through observed property events', async () => {
    const file = path.join(tempDir, 'a.mp4');
    makeVideo(file, '320x180');
    const paths = [];
    client.on('property-change', event => event.name === 'path' && event.data && paths.push(event.data));
    await client.observeProperty(1, 'path');

    await client.command('loadfile', file, 'replace');

    await waitFor(async () => paths.length > 0 || null);
    expect(paths[0]).to.equal(file);
  });

  it('keeps, re-rates, skips and undoes through real monitor sockets without duplicate entries', async () => {
    const inbox = path.join(tempDir, 'inbox');
    const mediaDir = path.join(tempDir, 'media');
    await fs.ensureDir(inbox); await fs.ensureDir(mediaDir);
    const first = path.join(inbox, 'ocean.waves.mp4');
    const other = path.join(mediaDir, 'other.mp4');
    makeVideo(first, '640x360'); makeVideo(other, '640x360');
    const id = db.addMedia({ kind: 'video', source: 'pexels', source_id: 'video:1', path: first, width: 640, height: 360 });
    db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: other, width: 640, height: 360 });
    const monitor = { name: 'TEST-1', width: 640, height: 360, socket: path.join(tempDir, 'mpv.sock') };
    const config = makeConfig({ 'paths.runtime': tempDir, 'paths.media': mediaDir,
      'paths.inbox': inbox, 'paths.trash': path.join(tempDir, 'trash') });
    await fs.writeJson(statePath(tempDir), { pid: process.pid, monitors: [monitor] });
    await loadPlaylist(client, { database: db, config: config.get(), mode: 'video', monitor, runtimeDir: tempDir, lastMediaId: id });
    await waitFor(async () => (await client.getProperty('path')) === first);
    const control = new DisplayControl({ config, database: db });
    const rating = new RatingCommand(config, db, silentLogger, { control });

    await rating.keep(2, { monitor: monitor.name });
    const kept = db.getMedia(id).path;
    await waitFor(async () => (await client.getProperty('path')) === kept);
    await rating.keep(3, { monitor: monitor.name });
    expect(await client.getProperty('playlist-count')).to.equal(2);
    expect(db.getLatestRating(id)).to.include({ rating: 3, resolution: '640x360' });

    await rating.skip({ monitor: monitor.name });
    expect(db.getMedia(id).status).to.equal('skipped');
    await waitFor(async () => (await client.getProperty('path')) === other);
    expect(await client.getProperty('playlist-count')).to.equal(1);

    await new RatingCommand(config, db, silentLogger, { control }).undo();
    expect(db.getMedia(id)).to.include({ path: kept, status: 'kept' });
    expect(db.getLatestRating(id).rating).to.equal(3);
    expect(await client.getProperty('playlist-count')).to.equal(2);
    expect(await client.getProperty('path')).to.equal(other);
  });
});
