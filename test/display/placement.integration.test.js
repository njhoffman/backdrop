import { expect } from 'chai';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Daemon } from '../../src/display/Daemon.js';
import { withX11 } from '../../src/display/x11.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// Where the wallpaper window ends up on a virtual X server with a real xwinwrap and mpv. Without a virtual root,
// xwinwrap parents its window into a viewable window the size of the screen: a maximized terminal on minerva
// (3.3.1), which then showed the video. The daemon moves it back to the root (Daemon.placeWallpaper), and leaves
// it in a window marked as the desktop, a file manager's desktop.

const CLIENT = fileURLToPath(new URL('../fixtures/standin-client.mjs', import.meta.url));

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = ['Xvfb', 'xwinwrap', 'mpv', 'ffmpeg', 'xrandr'].every(hasCommand);

function startXvfb() {
  return new Promise((resolve, reject) => {
    const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stdio[3].on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve({ display: `:${output.trim()}`, stop: () => child.kill('SIGTERM') });
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Xvfb exited with ${code}`)));
  });
}

// A stand-in window covering the screen, resolving to it once mapped: { id, stop }
function standIn(kind) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...(kind === 'desktop' ? ['desktop'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', chunk => resolve({
      id: Number(String(chunk).trim()),
      stop: () => new Promise(done => { child.once('exit', done); child.kill('SIGTERM'); })
    }));
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`the stand-in exited with ${code}`)));
  });
}

const parentOf = id => withX11(x => new Promise((resolve, reject) => {
  x.client.QueryTree(id, (error, tree) => (error ? reject(error) : resolve({ parent: tree.parent, root: x.root })));
}));

(available ? describe : describe.skip)('wallpaper placement on a virtual X server', function () {
  // Allows for a machine busy elsewhere, as the stacking test does
  this.timeout(60000);
  let xvfb, savedDisplay, dir, db, daemon, window;

  before(async () => {
    xvfb = await startXvfb();
    savedDisplay = process.env.DISPLAY;
    process.env.DISPLAY = xvfb.display;
    // Short: mpv's socket path must fit in 107 bytes
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-plc-'));
    const image = path.join(dir, 'wall.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720', '-frames:v', '1', image]);
    db = new DatabaseManager();
    db.initialize(':memory:');
    db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: image, width: 1280, height: 720 });
    db.setSetting('mode', 'image');
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    await window?.stop();
    window = null;
  });

  after(async () => {
    db?.close();
    xvfb?.stop();
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    await fs.remove(dir);
  });

  // Starts a daemon over the window there is and resolves to the parent of its wallpaper's xwinwrap window
  async function wallpaperParent() {
    const config = makeConfig({
      'paths.runtime': path.join(dir, 'run'), 'paths.thumbnails': path.join(dir, 'thumbs'), 'display.mpv_args': ['--vo=x11']
    });
    daemon = new Daemon({
      config, database: db, logger: silentLogger,
      importer: { importDirs: async () => ({ imported: [] }) }, purge: async () => {}, thumbnail: async () => null,
      healthInterval: 0, monitorInterval: 0, purgeInterval: 0, watch: null, watchOutputs: null
    });
    await daemon.start();
    const [screen] = daemon.screens.values();
    return parentOf(await screen.client.getProperty('wid'));
  }

  it('moves the wallpaper xwinwrap put inside a maximized window back to the root', async () => {
    window = await standIn('client');
    const { parent, root } = await wallpaperParent();
    expect(parent).to.equal(root);
  });

  it('leaves the wallpaper inside a window marked as the desktop', async () => {
    window = await standIn('desktop');
    const { parent } = await wallpaperParent();
    expect(parent).to.equal(window.id);
  });
});
