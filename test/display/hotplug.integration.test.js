import { expect } from 'chai';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Daemon, readState } from '../../src/display/Daemon.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// A layout change on a real X server: a real daemon polls the real xrandr and restarts the wallpaper of a
// monitor whose resolution changed. Xephyr (nested in an Xvfb, so nothing shows on the desktop) can change its
// screen size with `xrandr -s`; neither it nor Xvfb 21.1 can add or remove monitors (`--setmonitor` is
// ignored, and `--delmonitor` crashes Xephyr), so attaching and removing monitors stay with the fake xrandr
// in Daemon.test.js and a check on real hardware.

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = ['Xvfb', 'Xephyr', 'xwinwrap', 'mpv', 'ffmpeg', 'xrandr'].every(hasCommand);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// An X server started with -displayfd, resolving to { display, stop } once it accepts clients
function startServer(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['-displayfd', '3', ...args], { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stdio[3].on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve({ display: `:${output.trim()}`, stop: () => child.kill('SIGTERM') });
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`${file} exited with ${code}`)));
  });
}

async function waitFor(check, timeout = 15000, what = 'condition') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check().catch(error => ({ error: error.message }));
    if (last === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

(available ? describe : describe.skip)('monitor hotplug on a real X server', function () {
  this.timeout(60000);
  let host, nested, savedDisplay, dir, db, daemon;

  before(async () => {
    host = await startServer('Xvfb', ['-screen', '0', '2560x1440x24', '-nolisten', 'tcp']);
    nested = await startServer('Xephyr', ['-resizeable', '-screen', '1280x720', '-nolisten', 'tcp'], { ...process.env, DISPLAY: host.display });
    savedDisplay = process.env.DISPLAY;
    // The daemon's xrandr, xwinwrap and mpv all follow $DISPLAY
    process.env.DISPLAY = nested.display;
    // Short: mpv's socket path must fit in 107 bytes
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-hot-'));
    const image = path.join(dir, 'wall.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', image]);
    db = new DatabaseManager();
    db.initialize(':memory:');
    db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: image, width: 1600, height: 1200 });
    db.setSetting('mode', 'image');
    const config = makeConfig({
      'paths.runtime': path.join(dir, 'run'), 'paths.thumbnails': path.join(dir, 'thumbs'),
      'display.mpv_args': ['--vo=x11'], 'visualizer.enabled': false
    });
    daemon = new Daemon({
      config, database: db, logger: silentLogger,
      importer: { importDirs: async () => ({ imported: [] }) }, purge: async () => {}, thumbnail: async () => null,
      healthInterval: 0, monitorInterval: 200, purgeInterval: 0, watch: null, watchOutputs: null
    });
    await daemon.start();
  });

  after(async () => {
    await daemon?.stop();
    db?.close();
    nested?.stop();
    host?.stop();
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    await fs.remove(dir);
  });

  // The pid of the mpv playing on the only monitor
  const mpvPid = () => daemon.screens.get('default')?.client?.getProperty('pid');

  it('starts on the monitor xrandr reports', async () => {
    expect([...daemon.monitors.values()].map(({ name, width, height, x, y }) => ({ name, width, height, x, y })))
      .to.deep.equal([{ name: 'default', width: 1280, height: 720, x: 0, y: 0 }]);
    await waitFor(async () => (await daemon.screens.get('default').client.getProperty('path')) !== null, 15000, 'the wallpaper to load');
  });

  it('restarts the wallpaper of a monitor whose resolution changed, at the new size', async () => {
    const before = await mpvPid();
    execFileSync('xrandr', ['-s', '1024x768']);
    await waitFor(async () => daemon.monitors.get('default')?.width === 1024 && Boolean(await mpvPid().catch(() => null)), 15000, 'the new layout');
    expect(daemon.monitors.get('default')).to.include({ width: 1024, height: 768 });
    expect(await mpvPid()).to.not.equal(before);
    const state = await readState(daemon.runtimeDir);
    expect(state.monitors.map(monitor => monitor.name)).to.deep.equal(['default']);
    expect(state.monitors[0].socket).to.be.a('string');
  });

  it('leaves the wallpaper alone when xrandr reports the same layout again', async () => {
    const before = await mpvPid();
    execFileSync('xrandr', ['-s', '1024x768']);
    await sleep(800);
    expect(await mpvPid()).to.equal(before);
  });
});
