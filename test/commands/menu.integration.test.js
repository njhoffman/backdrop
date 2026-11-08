import { expect } from 'chai';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MenuCommand, minimalView, panelView } from '../../src/commands/MenuCommand.js';
import { statePath } from '../../src/display/Daemon.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// The menus drawn by real rofi on a virtual X server: rofi's theme parser and key bindings, which the unit
// tests (fake views) cannot see. rofi reports a bad -theme-str on stderr ("Failed to parse -theme-str"),
// shows an error window and exits 65, so every run asserts a clean stderr. A screenshot of each menu is
// kept in the test's directory and named in the failure, since layout problems only show in pixels.

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = ['Xvfb', 'rofi', 'xdotool', 'import'].every(hasCommand);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Starts Xvfb on a free display; resolves to { display, stop }
function spawnXvfb() {
  return new Promise((resolve, reject) => {
    const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1600x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stdio[3].on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve({ display: `:${output.trim()}`, stop: () => child.kill('SIGTERM') });
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Xvfb exited with ${code}`)));
  });
}

// Whether a client can open display now
function accepts(display) {
  return new Promise(resolve => {
    const child = spawn('xdotool', ['getdisplaygeometry'], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
}

// An Xvfb that clients can reach. Under load, rofi has failed to open a display -displayfd had already
// reported (2026-11-07), so each start is checked with a real client and a server that never answers is
// replaced by a new one.
async function startXvfb(attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const server = await spawnXvfb();
    for (let wait = 0; wait < 50; wait++) {
      if (await accepts(server.display)) return server;
      await sleep(100);
    }
    server.stop();
    last = server.display;
  }
  throw new Error(`No client could open the Xvfb display (last ${last})`);
}

(available ? describe : describe.skip)('rofi menus on a virtual X server', function () {
  this.timeout(30000);
  let xvfb, dir, env, runs, screenshots, keep = false;

  before(async () => {
    xvfb = await startXvfb();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-rofi-'));
    // rofi reads its own config from XDG_CONFIG_HOME, which test/helpers/setup.js points at an empty directory
    env = { ...process.env, DISPLAY: xvfb.display };
  });
  after(async () => {
    xvfb?.stop();
    // Kept when a test failed, for its screenshots
    if (!keep) await fs.remove(dir);
  });
  beforeEach(() => { runs = []; screenshots = []; });
  afterEach(function () {
    if (this.currentTest.state === 'failed' && screenshots.length) {
      this.currentTest.err.message += `\nScreenshots: ${screenshots.join(', ')}`;
      keep = true;
    }
  });

  const xdotool = args => execFileSync('xdotool', args, { env, encoding: 'utf8' });

  const rofiWindow = () => {
    try {
      return xdotool(['search', '--class', 'rofi']).trim();
    } catch {
      // xdotool exits 1 until the window exists
      return '';
    }
  };

  async function waitForRofi() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (rofiWindow()) return;
      const run = runs.at(-1);
      if (run?.code !== null && run?.code !== undefined) throw new Error(`rofi exited with ${run.code} before opening a window: ${run.stderr.trim()}`);
      await sleep(50);
    }
    throw new Error(`rofi did not open a window: ${runs.at(-1)?.stderr.trim() ?? 'not started'}`);
  }

  // Presses a key that ends this rofi run, again if a busy rofi had not yet taken the keyboard and missed it.
  // Its window can outlive it for a moment and would pass for the next run's, so this waits for that too.
  async function pressUntilClosed(run, key) {
    const deadline = Date.now() + 15000;
    while (run.code === null && Date.now() < deadline) {
      xdotool(['key', key]);
      for (let waited = 0; run.code === null && waited < 2000; waited += 50) await sleep(50);
    }
    if (run.code === null) throw new Error(`rofi did not close on ${key}`);
    for (let waited = 0; rofiWindow() && waited < 5000; waited += 50) await sleep(50);
  }

  // rofi as the views start it, on the virtual display, recording stderr and the exit code per run
  const spawnRofi = (file, args, options) => {
    const child = spawn(file, args, { ...options, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const run = { args, stderr: '', code: null };
    runs.push(run);
    child.stderr.on('data', chunk => { run.stderr += chunk; });
    child.on('close', code => { run.code = code; });
    return child;
  };

  // Starts a view and waits for its rofi window. Under load a single rofi has failed to connect to a display that the
  // runs before and after it used (\`Failed to open display\`, 2026-11-07), so that one failure starts it again, up to
  // three times; the failed run is dropped from runs, so its stderr and exit code do not count. Resolves to
  // { result }, the view's promise, which settles only once rofi closes.
  async function startShown(start) {
    for (let attempt = 1; ; attempt++) {
      const result = start();
      try {
        await waitForRofi();
        return { result };
      } catch (error) {
        const failed = runs.at(-1);
        if (attempt >= 3 || !/Failed to open display/.test(failed?.stderr ?? '')) throw error;
        await result.catch(() => {});
        runs.pop();
        await sleep(200);
      }
    }
  }

  // A view that shows each menu with real rofi and presses the next of keys (xdotool key names) once its
  // window is up, after a screenshot
  function driven(makeView, keys) {
    const view = makeView([], spawnRofi);
    const queue = [...keys];
    return async menu => {
      const { result } = await startShown(() => view(menu));
      await sleep(300);
      const shot = path.join(dir, `${runs.length}-${(menu.prompt ?? 'menu').replace(/\W+/g, '_')}.png`);
      execFileSync('import', ['-window', 'root', shot], { env });
      screenshots.push(shot);
      await pressUntilClosed(runs.at(-1), queue.shift() ?? 'Escape');
      return result;
    };
  }

  const cleanStderr = () => {
    for (const run of runs) expect(run.stderr.trim(), 'rofi stderr').to.equal('');
  };

  const menu = (overrides = {}) => ({
    prompt: 'backdrop', title: 'ocean-waves.mp4',
    // Quotes, apostrophes, backslashes, ampersands and line breaks: what broke -theme-str before
    message: '<b>#412  video  3840x2160</b>\n0:18 · 25 fps · "quoted" · it\'s · a\\b · R&amp;D',
    status: ['random  <b>on</b>', 'query  <b>"night sky", \'stars\'</b>', 'tags  <b>a\\b</b>'],
    entries: [
      { icon: '»', label: 'next', key: 'n' }, { icon: '1', label: 'keep 1', key: '1' }, { icon: '2', label: 'keep 2', key: '2', active: true },
      { icon: '3', label: 'keep 3', key: '3' }, { icon: 'v', label: 'speed', key: 'v', disabled: true },
      { icon: '«', label: 'prev', key: 'p' }, { icon: 's', label: 'skip', key: 's' }, { icon: 'u', label: 'undo', key: 'u' },
      { icon: 'm', label: 'mode', key: 'm' }, { icon: 'd', label: 'dim', key: 'd' }
    ],
    keys: ['q', 'Tab'],
    columns: 5,
    ...overrides
  });

  for (const [name, makeView] of [['panel', panelView], ['minimal', minimalView]]) {
    describe(`${name} view`, () => {
      it('parses the theme strings and returns a bound key as { key }', async () => {
        expect(await driven(makeView, ['2'])(menu())).to.deep.equal({ key: '2' });
        // Bound keys are the entries' (n 1 2 3 v p s u m d), then the menu's (q Tab), from exit code 10
        expect(runs.map(run => run.code)).to.deep.equal([12]);
        cleanStderr();
      });

      it('returns Tab and q as keys, Escape as null and Return as the selected index', async () => {
        const view = driven(makeView, ['Tab', 'q', 'Escape', 'Return']);
        expect(await view(menu())).to.deep.equal({ key: 'Tab' });
        expect(await view(menu())).to.deep.equal({ key: 'q' });
        expect(await view(menu())).to.equal(null);
        // -a marks keep 2 active; the selection starts on the first entry
        expect(await view(menu())).to.equal(0);
        cleanStderr();
        expect(runs.map(run => run.code)).to.deep.equal([21, 20, 1, 0]);
      });
    });
  }

  it('draws the real main and step menus through the panel theme', async () => {
    const runtime = path.join(dir, 'run');
    await fs.ensureDir(runtime);
    await fs.writeJson(statePath(runtime), { pid: process.pid, monitors: [{ name: 'DP-1' }, { name: 'HDMI-1' }] });
    const db = new DatabaseManager();
    db.initialize(':memory:');
    try {
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/local-1.mp4', original_name: 'it\'s "ocean" waves.mp4',
        width: 3840, height: 2160, duration: 18, fps: 25, speed: 0.8, dim: 20 });
      db.addRating(id, 2, '1920x1080');
      const monitors = [{ name: 'DP-1', width: 1920, height: 1080 }, { name: 'HDMI-1', width: 1920, height: 1080 }];
      const display = {
        control: {
          targetMonitor: async () => monitors[0],
          selected: async name => ({ monitor: monitors.find(m => m.name === name), path: '/m/local-1.mp4', media: db.getMedia(id), rating: db.getLatestRating(id) }),
          state: async () => ({ monitors })
        },
        next: sinon.stub().resolves(), prev: sinon.stub().resolves(), mode: sinon.stub().resolves(), speed: sinon.stub().resolves(), dim: sinon.stub().resolves()
      };
      const rating = { keep: sinon.stub().resolves(), skip: sinon.stub().resolves(), undo: sinon.stub().resolves() };
      const config = makeConfig({ 'paths.runtime': runtime, 'menu.workspace': false });
      // Main menu, speed step menu, a step, back, the monitor menu, back, quit
      const view = driven(panelView, ['v', 'Return', 'Escape', 'Tab', 'Escape', 'q']);
      const command = new MenuCommand(config, db, silentLogger, {
        display, rating, view, thumbnail: async () => null, workspace: async () => async () => {}
      });
      await command.open({});
      // v (14) opens speed, Return picks 0.4, Escape goes back, Tab (23, after q, z and o) the monitors, Escape back, q (20) quits
      expect(runs.map(run => run.code)).to.deep.equal([14, 0, 1, 23, 1, 20]);
      expect(display.speed.firstCall.args[0]).to.equal('0.4');
      cleanStderr();
    } finally {
      db.close();
    }
  });

  it('draws the visualizer menu and its color swatches through the panel theme', async () => {
    const runtime = path.join(dir, 'run-visualizer');
    await fs.ensureDir(runtime);
    const db = new DatabaseManager();
    db.initialize(':memory:');
    try {
      const monitors = [{ name: 'DP-1', width: 1920, height: 1080 }];
      const visualizer = { enabled: true, error: null, preset: null, presets: ['subtle'], instances: ['main'], live: {} };
      const display = {
        control: {
          targetMonitor: async () => monitors[0],
          selected: async () => ({ monitor: monitors[0], path: null, media: null, rating: null }),
          state: async () => ({ monitors, visualizer })
        }
      };
      const sent = [];
      const config = makeConfig({ 'paths.runtime': runtime, 'menu.workspace': false, 'visualizer.enabled': true });
      // c opens the colors (swatches are markup), Return picks fixed, Escape back, o opacity, Escape, Escape closes
      const view = driven(panelView, ['c', 'Return', 'Escape', 'o', 'Escape', 'Escape']);
      const command = new MenuCommand(config, db, silentLogger, {
        display, rating: {}, view, thumbnail: async () => null, workspace: async () => async () => {},
        control: async (runtimeDir, state, change) => {
          sent.push(change);
          visualizer.live = { main: { ...(visualizer.live.main ?? {}), ...change.visualizer_set.changes } };
          return { monitors, visualizer };
        }
      });
      await command.open({ page: 'visualizer' });
      // Visualizer keys: e w p m o a l c r s, then q, from 10
      expect(runs.map(run => run.code)).to.deep.equal([17, 0, 1, 14, 1, 1]);
      expect(sent).to.deep.equal([{ visualizer_set: { instance: 'main', changes: { palette: { source: 'config' } } } }]);
      cleanStderr();
    } finally {
      db.close();
    }
  });
});
