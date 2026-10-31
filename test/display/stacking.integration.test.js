import { expect } from 'chai';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Daemon, controlPath } from '../../src/display/Daemon.js';
import { withX11 } from '../../src/display/x11.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// The daemon's stacking on a virtual X server: a real daemon runs xwinwrap and mpv, and the visualizer is a
// stand-in window (test/fixtures/standin-visualizer.mjs) that lowers itself after it maps, as GLava does.
// GLava itself does not open a window under Xvfb, so its own stacking behavior is not covered here; this
// covers backdrop's placement, which must leave each visualizer directly above its monitor's wallpaper after
// a start, after mpv dies and is restarted, and after the wallpaper is switched off and on.

const STANDIN = fileURLToPath(new URL('../fixtures/standin-visualizer.mjs', import.meta.url));

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = ['Xvfb', 'xwinwrap', 'mpv', 'ffmpeg', 'xdotool', 'xrandr'].every(hasCommand);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// The adapter the daemon's VisualizerManager runs instead of GLava
const standIn = (settings, instance) => ({
  prepare: async () => {},
  title: monitor => `backdrop-visualizer-${monitor.name}-${instance.name}`,
  command: (monitor, geometry) => ({
    file: process.execPath,
    args: [STANDIN, `backdrop-visualizer-${monitor.name}-${instance.name}`, geometry.x, geometry.y, geometry.width, geometry.height],
    env: process.env
  })
});

async function waitFor(check, timeout = 10000, what = 'condition') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check().catch(error => ({ error: error.message }));
    if (last === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

(available ? describe : describe.skip)('visualizer stacking on a virtual X server', function () {
  this.timeout(60000);
  let xvfb, savedDisplay, dir, db, daemon;
  const others = [];

  // Another window at the bottom of the stack, like a desktop-icons or conky window. A restarted wallpaper
  // (xwinwrap -b) goes below it, so only the daemon's restack can leave the visualizer directly above the
  // wallpaper again; without it, these scenarios would pass by accident.
  async function lowWindow() {
    const child = spawn(process.execPath, [STANDIN, `other-${others.length}`, 0, 0, 50, 50], { stdio: 'ignore' });
    others.push(child);
    await waitFor(async () => {
      const { children } = await layout();
      const id = Number(execFileSync('xdotool', ['search', '--name', `^other-${others.length - 1}$`], { encoding: 'utf8' }).trim().split('\n')[0]);
      return children[0] === id;
    }, 5000, 'the other window at the bottom');
  }

  before(async () => {
    xvfb = await startXvfb();
    savedDisplay = process.env.DISPLAY;
    // The daemon's children, xrandr, xdotool and the x11 connection all follow $DISPLAY
    process.env.DISPLAY = xvfb.display;
    // Short: mpv's socket path must fit in 107 bytes
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-stk-'));
    const image = path.join(dir, 'wall.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720', '-frames:v', '1', image]);
    db = new DatabaseManager();
    db.initialize(':memory:');
    db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: image, width: 1280, height: 720 });
    db.setSetting('mode', 'image');
    const config = makeConfig({
      'paths.runtime': path.join(dir, 'run'), 'paths.thumbnails': path.join(dir, 'thumbs'),
      'display.mpv_args': ['--vo=x11'], 'visualizer.enabled': true
    });
    daemon = new Daemon({
      config, database: db, logger: silentLogger, createVisualizer: standIn,
      importer: { importDirs: async () => ({ imported: [] }) }, purge: async () => {}, thumbnail: async () => null,
      healthInterval: 500, monitorInterval: 0, purgeInterval: 0, watch: null
    });
    await daemon.start();
  });

  after(async () => {
    for (const child of others) child.kill('SIGTERM');
    await daemon?.stop();
    db?.close();
    xvfb?.stop();
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    await fs.remove(dir);
  });

  const monitorName = () => [...daemon.monitors.keys()][0];

  // The root's children bottom to top, the wallpaper's top-level window and the visualizer's window
  async function layout() {
    const name = monitorName();
    const client = daemon.screens.get(name)?.client;
    return withX11(async x => {
      const children = await new Promise((resolve, reject) => x.client.QueryTree(x.root, (error, tree) => (error ? reject(error) : resolve(tree.children))));
      const wallpaperId = client ? await client.getProperty('window-id').catch(() => null) : null;
      const wallpaper = wallpaperId ? await x.topLevel(wallpaperId) : null;
      let visualizer = null;
      try {
        visualizer = Number(execFileSync('xdotool', ['search', '--name', `^backdrop-visualizer-${name}-main$`], { encoding: 'utf8' }).trim().split('\n')[0]);
      } catch {
        // not mapped yet
      }
      return { children, wallpaper, visualizer };
    });
  }

  const directlyAbove = async () => {
    const { children, wallpaper, visualizer } = await layout();
    if (!wallpaper || !visualizer) return { wallpaper, visualizer };
    const at = children.indexOf(visualizer);
    return at === children.indexOf(wallpaper) + 1 ? true : { order: children, wallpaper, visualizer };
  };

  // Placement checks again after it settles (SETTLE_MS) once the stand-in lowered itself twice, so the
  // order has to hold for a while, not just once
  async function expectStaysAbove(what) {
    await waitFor(directlyAbove, 10000, `the visualizer directly above the wallpaper ${what}`);
    await sleep(1200);
    expect(await directlyAbove(), `still directly above ${what}`).to.equal(true);
  }

  it('places the visualizer directly above the wallpaper after a start', async () => {
    await expectStaysAbove('after the start');
  });

  it('keeps it above the wallpaper the daemon starts after mpv dies', async () => {
    await lowWindow();
    const screen = daemon.screens.get(monitorName());
    const before = await screen.client.getProperty('window-id');
    process.kill(await screen.client.getProperty('pid'), 'SIGKILL');
    await waitFor(async () => {
      const current = daemon.screens.get(monitorName());
      const id = current?.client ? await current.client.getProperty('window-id').catch(() => null) : null;
      return Boolean(id) && id !== before;
    }, 15000, 'a new wallpaper window');
    await expectStaysAbove('after mpv was restarted');
  });

  it('keeps the visualizer through stop --wallpaper and puts it back above on start --wallpaper', async () => {
    const control = async change => {
      await fs.writeJson(controlPath(daemon.runtimeDir), { pid: process.pid, ...change });
      await daemon.applyControl();
    };
    await control({ wallpaper: false });
    const off = await layout();
    expect(off.wallpaper).to.equal(null);
    expect(off.visualizer).to.be.a('number');
    await lowWindow();
    await control({ wallpaper: true });
    await expectStaysAbove('after start --wallpaper');
  });
});
