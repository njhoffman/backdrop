import { expect } from 'chai';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MpvClient } from '../../src/display/MpvClient.js';
import { loadPlaylist, lastMediaKey } from '../../src/display/Playlist.js';
import { makeConfig } from '../helpers/fakes.js';

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
});
