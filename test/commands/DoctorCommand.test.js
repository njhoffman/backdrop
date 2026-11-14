import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { DoctorCommand } from '../../src/commands/DoctorCommand.js';
import { ANIMATED_WEBP } from '../../src/library/probe.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('DoctorCommand', () => {
  let db, config, lines, errors, installed, files, savedDisplay, modes;
  const doctor = (overrides = {}) => new DoctorCommand(config, db, silentLogger, {
    version: '2.32.0',
    which: async name => installed.has(name),
    x11: async fn => fn({ hasCompositor: async () => true }),
    readStateFile: async () => null,
    orphans: () => null,
    pathExists: async file => files.has(file),
    exec: async (file, args) => {
      if (file === 'i3-msg' && args.includes('get_binding_modes')) return JSON.stringify(modes);
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    },
    ...overrides
  });
  const byName = (checks, name) => checks.find(check => check.name === name);

  beforeEach(() => {
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'visualizer.enabled': true, 'sources.pexels.api_key': 'key' });
    installed = new Set(['mpv', 'xwinwrap', 'ffmpeg', 'ffprobe', 'xrandr', 'xdotool', 'rofi', 'glava', 'notify-send', 'pactl', 'i3-msg', 'polybar-msg', 'xprintidle']);
    modes = ['default', 'screensaver'];
    files = new Set();
    lines = []; errors = [];
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
    sinon.stub(console, 'error').callsFake(line => errors.push(line));
    savedDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ':9';
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    db.close();
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    process.exitCode = undefined;
  });

  it('passes a healthy setup', async () => {
    const id = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 1920, height: 1080 });
    files.add('/m/a.png');
    const checks = await doctor().run();
    expect(checks.every(check => check.status === 'ok'), JSON.stringify(checks.filter(check => check.status !== 'ok'))).to.equal(true);
    expect(byName(checks, 'files').detail).to.equal('1 items, every file present');
    expect(lines.at(-1)).to.equal('Everything checks out');
    expect(process.exitCode).to.equal(undefined);
    expect(id).to.be.a('number');
  });

  it('fails on a missing required tool and warns on optional ones only when their feature is on', async () => {
    installed.delete('xwinwrap');
    installed.delete('glava');
    installed.delete('pactl');
    // The default screensaver look without lyrics has one-speaker rings, which need pactl; leave it out here
    config.set('screensaver.preset_without_lyrics', null);
    const checks = await doctor().run();
    expect(byName(checks, 'xwinwrap')).to.include({ status: 'fail', hint: 'install xwinwrap' });
    expect(byName(checks, 'glava').status).to.equal('warn');
    // only_while_playing is off: pactl is not needed
    expect(byName(checks, 'pactl')).to.equal(undefined);
    expect(process.exitCode).to.equal(1);
    expect(errors.at(-1)).to.equal('1 failed, 1 warning');
  });

  it('wants pactl for an instance that follows one speaker', async () => {
    installed.delete('pactl');
    config.set('screensaver.preset_without_lyrics', null);
    config.set('visualizer.instances', [{ name: 'l', module: 'radial', channel: 'left' }]);
    const checks = await doctor().run();
    expect(byName(checks, 'pactl').status).to.equal('warn');
  });

  it('warns about what the screensaver relies on', async () => {
    let checks = await doctor().run();
    expect(byName(checks, 'i3 mode').status).to.equal('ok');
    modes = ['default'];
    installed.delete('polybar-msg');
    installed.delete('xprintidle');
    config.set('screensaver.idle', true);
    config.set('screensaver.on_enter', ['FOO=1 polybar-msg cmd hide', 'notify-send hi']);
    config.set('visualizer.presets', { night: { instances: [{ name: 'p', engine: 'projectm' }] } });
    config.set('screensaver.preset', 'night');
    checks = (await doctor().run()).filter(check => check.group === 'screensaver');
    expect(checks.map(check => [check.name, check.status])).to.deep.equal([
      ['i3 mode', 'warn'], ['polybar-msg', 'warn'], ['xprintidle', 'warn'], ['projectMSDL', 'warn']
    ]);
    expect(byName(checks, 'i3 mode').hint).to.include('mode "screensaver"');
  });

  it('checks the display and the compositor', async () => {
    let checks = await doctor({ x11: async fn => fn({ hasCompositor: async () => false }) }).run();
    expect(byName(checks, 'compositor')).to.include({ status: 'warn', hint: 'start picom or another compositor' });
    checks = await doctor({ x11: async () => { throw new Error('connection refused'); } }).run();
    expect(byName(checks, 'X display')).to.include({ status: 'fail' });
    expect(byName(checks, 'X display').detail).to.include('connection refused');
    delete process.env.DISPLAY;
    checks = await doctor().run();
    expect(byName(checks, 'X display').detail).to.equal('DISPLAY is not set');
  });

  it('reports invalid values, unknown keys, a bad visualizer section and a missing Pexels key', async () => {
    config.errors = ['display.notify must be commands, all or off, not "loud"'];
    config.warnings = ['Unknown config key "visualizr"; closest: "visualizer"'];
    config.visualizerError = 'visualizer.module must be bars, graph, radial, circle, wave, not "spiral"';
    config.get().sources.pexels.api_key = '';
    const checks = await doctor().run();
    expect(checks.filter(check => check.group === 'config').map(check => [check.name, check.status])).to.deep.equal([
      ['value', 'fail'], ['unknown key', 'warn'], ['visualizer', 'warn'], ['Pexels key', 'warn']
    ]);
  });

  it('reports the daemon: running behind the CLI, a stale state file, and processes a crash left', async () => {
    let checks = await doctor({ readStateFile: async () => ({ pid: 42, version: '2.30.0' }) }).run();
    expect(byName(checks, 'daemon')).to.include({ status: 'warn', detail: 'running (pid 42, 2.30.0)' });
    expect(byName(checks, 'daemon').hint).to.include('it runs 2.30.0, the CLI is 2.32.0');

    files.add(`${config.get().paths.runtime}/state.json`);
    checks = await doctor({ orphans: () => ({ daemon: 7, orphans: [{ command: 'xwinwrap', pid: 70 }] }) }).run();
    expect(byName(checks, 'daemon')).to.include({ status: 'warn', hint: 'backdrop stop clears it' });
    expect(byName(checks, 'left running')).to.include({ status: 'warn', detail: 'xwinwrap (pid 70), from daemon 7, which exited without stopping' });
  });

  it('reports items whose files are missing, a few by id', async () => {
    for (let index = 1; index <= 5; index++) db.addMedia({ kind: 'image', source: 'local', source_id: index, path: `/m/${index}.png`, width: 1920, height: 1080 });
    files.add('/m/1.png');
    const checks = await doctor().run();
    expect(byName(checks, 'files')).to.include({ status: 'warn', detail: '4 of 5 items have no file (#2, #3, #4, ...)' });
    expect(byName(checks, 'files').hint).to.include('backdrop rescan --all');
  });

  it('names animated WebP the import could not take, while the files are still there', async () => {
    const record = (file, detail) => db.recordImportedFile({ source_path: file, size: 1, mtime_ms: 1, status: 'unsupported', detail });
    record('/walls/a.webp', ANIMATED_WEBP);
    record('/walls/gone.webp', ANIMATED_WEBP);
    record('/walls/junk.png', 'no picture stream');
    files.add('/walls/a.webp').add('/walls/junk.png');

    const checks = await doctor().run();

    expect(byName(checks, 'animated WebP')).to.include({ status: 'warn', detail: '1 not imported: FFmpeg cannot decode them (a.webp)' });
    expect(byName(checks, 'animated WebP').hint).to.include('magick a.webp a.gif');
  });

  it('reports the bounce cache against its limit, warning when the daemon left it well over', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-doctor-bounce-'));
    try {
      config.set('paths.bounce', dir);
      expect(byName(await doctor().run(), 'bounce cache')).to.equal(undefined);
      await fs.outputFile(path.join(dir, '1.mp4'), Buffer.alloc(2048));
      config.set('display.bounce_cache_gb', 1);
      db.setSetting('bounce_encodes', { [new Date().toISOString().slice(0, 10)]: { count: 3, seconds: 90 } });
      expect(byName(await doctor().run(), 'bounce cache')).to.include({
        status: 'ok', detail: '1 reversed copy, 2.0 KB of 1.0 GB; 3 encoded today (1.5 min), 0 yesterday'
      });
      config.set('display.bounce_cache_gb', 1 / 1024 ** 2);
      expect(byName(await doctor().run(), 'bounce cache').status).to.equal('warn');
      config.set('display.bounce_cache_gb', 0);
      expect(byName(await doctor().run(), 'bounce cache').detail).to.include('(no limit)');
    } finally {
      await fs.remove(dir);
    }
  });

  it('checks RIFE and counts smoothed videos only with display.smooth on', async () => {
    expect(byName(await doctor().run(), 'smoothing')).to.equal(undefined);
    config.set('display.smooth', true);
    config.set('display.smooth_rife', '/opt/rife/rife-ncnn-vulkan');
    expect(byName(await doctor().run(), 'smoothing')).to.include({ status: 'fail', detail: 'RIFE not found: /opt/rife/rife-ncnn-vulkan' });
    files.add('/opt/rife/rife-ncnn-vulkan');
    expect(byName(await doctor().run(), 'smoothing').detail).to.include('no rife-v4.6 model');
    files.add('/opt/rife/rife-v4.6');
    db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/1.mp4', speed: 0.5, fps: 30, duration: 10 });
    expect(byName(await doctor().run(), 'smoothing')).to.include({ status: 'ok', detail: '0 of 1 slowed videos smoothed; the daemon makes the rest' });
  });

  it('warns when RIFE runs on the only GPU, cannot be watched there, or the daemon moved it to the CPU', async () => {
    config.set('display.smooth', true);
    config.set('display.smooth_rife', 'rife-ncnn-vulkan');
    const which = async () => true;
    const journal = (line = 'a kernel line') => async (file, args) => (file === 'journalctl' && args.includes('-k') ? line : '');
    // On the CPU (the default): nothing to say
    expect(byName(await doctor({ which }).run(), 'smoothing gpu')).to.equal(undefined);
    config.set('display.smooth_gpu', 0);
    let check = byName(await doctor({ which, exec: journal(), renderNodes: async () => ['renderD128'] }).run(), 'smoothing gpu');
    expect(check).to.include({ status: 'warn', detail: 'RIFE shares the only GPU, the one the desktop draws on: a hang there can freeze the machine' });
    expect(check.hint).to.include('smooth_gpu: -1');
    check = byName(await doctor({ which, exec: journal(), renderNodes: async () => ['renderD128', 'renderD129'] }).run(), 'smoothing gpu');
    expect(check).to.include({ status: 'ok', detail: 'RIFE on GPU 0 of 2, watched through the kernel log' });
    check = byName(await doctor({ which, exec: journal(''), renderNodes: async () => ['renderD128', 'renderD129'] }).run(), 'smoothing gpu');
    expect(check.status).to.equal('warn');
    expect(check.detail).to.include('the kernel log cannot be read');
    expect(check.hint).to.include('adm group');
    const at = new Date(2026, 10, 13, 21, 47).getTime();
    const readStateFile = async () => ({ pid: 1, monitors: [], smoothing: { gpu: 0, device: -1, fallback: { reason: 'the GPU hung under RIFE', at } } });
    check = byName(await doctor({ which, exec: journal(), readStateFile, renderNodes: async () => ['renderD128', 'renderD129'] }).run(), 'smoothing gpu');
    expect(check).to.include({ status: 'warn', detail: 'the daemon smooths on the CPU since 21:47: the GPU hung under RIFE' });
    expect(check.hint).to.include('restart the daemon');
  });

  it('reports the smooth cache against its limit, and says when a full cache holds the backlog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-doctor-smooth-'));
    try {
      config.set('paths.smooth', dir);
      config.set('display.smooth', true);
      config.set('display.smooth_rife', 'rife-ncnn-vulkan');
      const video = path.join(dir, 'media', '1.mp4');
      await fs.outputFile(video, 'video');
      await fs.utimes(video, 1000, 1000);
      const done = db.getMedia(db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: video, width: 2560, height: 1440, speed: 0.5, fps: 30, duration: 10 }));
      db.addMedia({ kind: 'video', source: 'local', source_id: 2, path: '/m/2.mp4', speed: 0.5, fps: 30, duration: 10 });
      await fs.outputFile(path.join(dir, `${done.id}@0.5.mp4`), Buffer.alloc(2048));
      config.set('display.smooth_cache_gb', 1);
      expect(byName(await doctor({ which: async () => true }).run(), 'smoothing')).to.include({
        status: 'ok', detail: '1 of 2 slowed videos smoothed, 2.0 KB of 1.0 GB; the daemon makes the rest'
      });
      // A copy smaller than the daemon's monitors need does not count (sizes unchecked without a daemon, as above)
      await fs.writeJson(path.join(dir, `${done.id}@0.5.json`), { width: 1280, height: 720 });
      const withDaemon = { which: async () => true, readStateFile: async () => ({ pid: 1, monitors: [{ name: 'DP-1', width: 1920, height: 1080 }] }) };
      expect(byName(await doctor(withDaemon).run(), 'smoothing').detail).to.equal('0 of 2 slowed videos smoothed, 2.0 KB of 1.0 GB; '
        + '1 copy is smaller than the monitors need, the original plays until a larger one is made; the daemon makes the rest');
      await fs.writeJson(path.join(dir, `${done.id}@0.5.json`), { width: 1920, height: 1080 });
      expect(byName(await doctor(withDaemon).run(), 'smoothing').detail).to.include('1 of 2 slowed videos smoothed');
      config.set('display.smooth_cache_gb', 3 / 1024 ** 2);
      expect(byName(await doctor({ which: async () => true }).run(), 'smoothing').detail).to.include('the cache is full');
      config.set('display.smooth_cache_gb', 1 / 1024 ** 2);
      expect(byName(await doctor({ which: async () => true }).run(), 'smoothing').status).to.equal('warn');
    } finally {
      await fs.remove(dir);
    }
  });

  it('runs the visualizer check with --visualizer, and prints JSON', async () => {
    const checkVisualizers = async () => [{ preset: null, instance: 'main', ok: true }, { preset: 'ring', instance: 'ring', ok: false, code: 1, output: ['syntax error'] }];
    const checks = await doctor({ checkVisualizers }).run({ visualizer: true, json: true });
    expect(checks.filter(check => check.group === 'visualizer').map(check => [check.name, check.status, check.detail])).to.deep.equal([
      ['(no preset) main', 'ok', 'runs'], ['ring ring', 'fail', 'exited with code 1: syntax error']
    ]);
    const json = JSON.parse(lines.at(-1));
    expect(json).to.include({ ok: false, failed: 1, warned: 0 });
    expect(json.checks).to.have.length(checks.length);
  });

  describe('sleeve', () => {
    const sleeveChecks = async ({ version = '0.33.0\n', shell = 'inactive\n', which = async () => true, section = { enabled: true, engine: 'sleeve' } } = {}) => {
      config.set('visualizer', section);
      const checks = await doctor({
        which,
        exec: async file => {
          if (file === 'sleeve') { if (version instanceof Error) throw version; return version; }
          return shell;
        }
      }).run();
      return checks.filter(check => check.name.startsWith('sleeve') && (check.group !== 'tools' || check.status !== 'ok'));
    };

    it('reports nothing unless an enabled section uses it', async () => {
      expect(await sleeveChecks({ section: { enabled: false, engine: 'sleeve' } })).to.deep.equal([]);
      expect(await sleeveChecks({ section: { enabled: true } })).to.deep.equal([]);
    });

    it('accepts a new enough sleeve', async () => {
      expect(await sleeveChecks({ version: '1.2.0\n' })).to.deep.include({ group: 'visualizer', name: 'sleeve', status: 'ok', detail: 'version 1.2.0' });
      expect((await sleeveChecks()).find(check => check.name === 'sleeve').status).to.equal('ok');
    });

    it('warns of an old sleeve or one that cannot say', async () => {
      expect((await sleeveChecks({ version: '0.32.9\n' })).find(check => check.name === 'sleeve').status).to.equal('warn');
      expect((await sleeveChecks({ version: new Error('exit 1') })).find(check => check.name === 'sleeve').detail).to.include('unknown');
    });

    it('asks for a newer sleeve when the wallpaper layer is configured', async () => {
      const section = { enabled: true, engine: 'sleeve', sleeve: { background: 'cover' } };
      const found = (await sleeveChecks({ section, version: '0.35.0\n' })).find(check => check.name === 'sleeve');
      expect(found).to.include({ status: 'warn' });
      expect(found.detail).to.include('needs 0.36 or later');
      expect((await sleeveChecks({ section, version: '0.36.0\n' })).find(check => check.name === 'sleeve').status).to.equal('ok');
    });

    it('warns that its own overlay service would draw the lyrics twice', async () => {
      const overlay = (await sleeveChecks({ shell: 'active\n' })).find(check => check.name === 'sleeve overlay');
      expect(overlay.status).to.equal('warn');
      expect(overlay.detail).to.include('draw twice');
    });

    it('names a missing sleeve among the tools', async () => {
      const checks = await sleeveChecks({ which: async name => name !== 'sleeve' });
      expect(checks).to.deep.include({ group: 'tools', name: 'sleeve', status: 'warn', detail: 'not installed; the sleeve visualizer instances (docs/specs/sleeve.md)', hint: 'install sleeve' });
    });
  });
});
