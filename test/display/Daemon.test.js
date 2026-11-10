import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { childrenPath } from '../../src/display/children.js';
import { Daemon, buildCommand, readState, statePath, nextFiltersPath, controlPath, controlRequestPath, isProcessRunning } from '../../src/display/Daemon.js';
import { lastMediaKey, setMode } from '../../src/display/Playlist.js';
import { FakeMpvClient, FakeChild, makeConfig, silentLogger, LISTMONITORS_TWO } from '../helpers/fakes.js';
import { notifications } from '../helpers/setup.js';

// Above Linux's maximum pid_max, so it can never be a live process
const DEAD_PID = 4194305;

const tick = () => new Promise(resolve => setImmediate(resolve));
// Waits for a relaunch (or any number of launches) rather than a fixed time, which a busy machine outlasts
async function launches(spawned, count, timeout = 2000) {
  for (let waited = 0; spawned.length < count && waited < timeout; waited += 5) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('Daemon', () => {
  let tempDir;
  let db;
  let config;
  let spawned;
  let reaped;
  let clients;
  let kills;
  let connectError;
  let purges;
  let layout;

  function makeDaemon(overrides = {}) {
    return new Daemon({
      config,
      database: db,
      logger: silentLogger,
      exec: async () => { if (layout instanceof Error) throw layout; return layout; },
      spawn: (file, args, options) => {
        const child = new FakeChild(1000 + spawned.length);
        spawned.push({ file, args, options, child });
        return child;
      },
      connect: async socketPath => {
        if (connectError) {
          throw connectError;
        }
        const client = new FakeMpvClient();
        clients.push({ socketPath, client });
        return client;
      },
      kill: (pid, signal) => kills.push([pid, signal]),
      restartDelay: 0,
      stopGrace: 20,
      importer: { importDirs: async () => ({ imported: [] }) },
      purge: async () => { purges++; },
      healthInterval: 0,
      // Tests that sample CPU pass their own /proc reader
      readFile: async () => { throw new Error('no /proc in tests'); },
      gpuMemory: async () => null,
      monitorInterval: 0,
      // Tests that watch the config file pass their own
      watch: null, watchOutputs: null,
      purgeInterval: 0,
      // Fake pids may belong to real processes, so their start times come from here, never /proc
      readStart: pid => `t${pid}`,
      reap: async dir => { reaped.push(dir); return []; },
      ...overrides
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-daemon-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'paths.runtime': tempDir, 'display.mpv_args': ['--vo=gpu'] });
    spawned = [];
    reaped = [];
    clients = [];
    kills = [];
    connectError = null;
    purges = 0;
    layout = LISTMONITORS_TWO;
  });

  afterEach(async () => {
    db.close();
    await fs.remove(tempDir);
  });

  describe('buildCommand', () => {
    it('wraps mpv in xwinwrap at the monitor geometry with its own socket and no user config', () => {
      const { file, args } = buildCommand(
        { width: 1080, height: 1920, x: 2560, y: 0 },
        '/run/backdrop/HDMI-1.sock',
        config.get().display
      );
      const separator = args.indexOf('--');

      expect(file).to.equal('xwinwrap');
      expect(args.slice(0, separator)).to.deep.equal([...config.get().display.xwinwrap_args, '-g', '1080x1920+2560+0']);
      expect(args.slice(separator + 1, separator + 4)).to.deep.equal(['mpv', '-wid', 'WID']);
      expect(args).to.include.members([
        '--no-config', '--input-ipc-server=/run/backdrop/HDMI-1.sock', '--idle=yes', '--no-audio',
        '--no-stop-screensaver', '--panscan=1.0', '--loop-playlist=inf'
      ]);
      expect(args[args.length - 1]).to.equal('--vo=gpu');
    });

    // 2.50.7: VAAPI first, since CUDA's probe stalled mpv's start past the IPC timeout on the NVIDIA desktop;
    // auto-safe keeps the other hardware decoders and software decoding after it
    it('tries VAAPI before the other safe hardware decoders', () => {
      const { args } = buildCommand({ width: 1920, height: 1080, x: 0, y: 0 }, '/run/backdrop/DP-1.sock', config.get().display);
      expect(args.filter(arg => arg.startsWith('--hwdec'))).to.deep.equal(['--hwdec=vaapi,auto-safe']);
    });
  });

  describe('readState', () => {
    it('returns null without a state file', async () => {
      expect(await readState(tempDir)).to.be.null;
    });

    it('returns null when the recorded process is gone', async () => {
      await fs.writeJson(statePath(tempDir), { pid: DEAD_PID, monitors: [] });
      expect(isProcessRunning(DEAD_PID)).to.be.false;
      expect(await readState(tempDir)).to.be.null;
    });

    it('returns the state of a live process', async () => {
      await fs.writeJson(statePath(tempDir), { pid: process.pid, monitors: [] });
      expect((await readState(tempDir)).pid).to.equal(process.pid);
    });
  });

  describe('start', () => {
    it('launches one detached xwinwrap per monitor and records sockets', async () => {
      const daemon = makeDaemon();
      await daemon.start();

      expect(spawned.map(s => s.file)).to.deep.equal(['xwinwrap', 'xwinwrap']);
      expect(spawned.every(s => s.options.detached)).to.be.true;
      expect(spawned[1].args).to.include('1080x1920+2560+0');

      const state = await readState(tempDir);
      expect(state.pid).to.equal(process.pid);
      expect(state.monitors.map(m => [m.name, m.socket])).to.deep.equal([
        ['DP-1', path.join(tempDir, 'DP-1.sock')],
        ['HDMI-1', path.join(tempDir, 'HDMI-1.sock')]
      ]);
      expect(clients.map(c => c.socketPath)).to.deep.equal(state.monitors.map(m => m.socket));

      await daemon.stop();
    });

    it('observes the playing path and loads the current mode', async () => {
      setMode(db, 'image');
      const daemon = makeDaemon();
      await daemon.start();

      const { commands } = clients[0].client;
      expect(commands[0]).to.deep.equal(['observe_property', 1, 'path']);
      expect(commands).to.deep.include(['set_property', 'loop-file', 'no']);

      await daemon.stop();
    });

    it('only manages configured monitors', async () => {
      config.set('display.monitors', ['HDMI-1']);
      const daemon = makeDaemon();
      await daemon.start();

      expect(spawned).to.have.length(1);
      await daemon.stop();
    });

    it('refuses to start twice', async () => {
      await fs.writeJson(statePath(tempDir), { pid: process.pid, monitors: [] });
      try {
        await makeDaemon().start();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include(`already running (pid ${process.pid})`);
      }
    });

    it('starts with the configured monitors that are active and warns about the rest', async () => {
      const warnings = [];
      config.set('display.monitors', ['HDMI-1', 'DP-9']);
      const daemon = makeDaemon({ logger: { ...silentLogger, warn: (message, meta) => warnings.push([message, meta]) } });
      await daemon.start();
      expect(spawned).to.have.length(1);
      expect(warnings).to.deep.include(['Configured monitors not active, waiting for them', { missing: ['DP-9'] }]);
      await daemon.stop();
    });

    it('drops the filters next stored when it starts and stops', async () => {
      await fs.outputJson(nextFiltersPath(tempDir), { pid: process.pid, query: ['clouds'] });
      const daemon = makeDaemon();
      await daemon.start();
      expect(await fs.pathExists(nextFiltersPath(tempDir))).to.be.false;
      await fs.outputJson(nextFiltersPath(tempDir), { pid: process.pid, query: ['clouds'] });
      await daemon.stop();
      expect(await fs.pathExists(nextFiltersPath(tempDir))).to.be.false;
    });

    it('waits for configured monitors when none is active, and picks them up on hotplug', async () => {
      config.set('display.monitors', ['DP-9']);
      layout = LISTMONITORS_TWO;
      const daemon = makeDaemon();
      await daemon.start();
      expect(spawned).to.have.length(0);
      expect((await readState(tempDir)).monitors).to.deep.equal([]);
      layout = `${LISTMONITORS_TWO} 2: +DP-9 1920/509x1080/286+3640+0  DP-9\n`.replace('Monitors: 2', 'Monitors: 3');
      await daemon.checkMonitors();
      expect(spawned).to.have.length(1);
      expect((await readState(tempDir)).monitors.map(m => m.name)).to.deep.equal(['DP-9']);
      await daemon.stop();
    });

    it('fails without active monitors', async () => {
      try {
        await makeDaemon({ exec: async () => 'Monitors: 0\n' }).start();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.equal('No active monitors found');
      }
    });

    it('cleans up when mpv cannot be reached', async () => {
      connectError = new Error('Cannot connect to mpv');
      try {
        await makeDaemon().start();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Cannot connect to mpv');
      }
      expect(kills).to.deep.include([-1000, 'SIGTERM']);
      expect(await fs.pathExists(statePath(tempDir))).to.be.false;
    });

    it('rejects socket paths too long for a Unix socket', async () => {
      config.set('paths.runtime', path.join(tempDir, 'x'.repeat(120)));
      try {
        await makeDaemon().start();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('shorten paths.runtime');
      }
    });
  });

  describe('import on start', () => {
    it('imports configured directories and appends new media to every monitor', async () => {
      config.set('library.import_dirs', ['/walls']);
      const fits = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/1.mp4', width: 2560, height: 1920 });
      const calls = [];
      const daemon = makeDaemon({
        importer: {
          importDirs: async (dirs, options) => {
            calls.push({ dirs, resolution: options.resolution, stopping: options.shouldStop(), whenLocked: options.whenLocked, concurrency: options.concurrency });
            return { imported: [fits] };
          }
        }
      });

      await daemon.start();
      await daemon.importing;

      // Skips while `backdrop import` runs, and probes fewer files at once than the CLI
      expect(calls).to.deep.equal([{ dirs: ['/walls'], resolution: '2560x1440', stopping: false, whenLocked: 'skip', concurrency: 2 }]);
      const appended = clients.map(c => c.client.commands.filter(cmd => cmd[0] === 'loadfile' && cmd[2] === 'append-play'));
      expect(appended).to.deep.equal([[['loadfile', '/m/1.mp4', 'append-play']], [['loadfile', '/m/1.mp4', 'append-play']]]);
      await daemon.stop();
    });

    it('logs the file total and periodic progress for long startup imports', async () => {
      config.set('library.import_dirs', ['/walls']);
      const infos = [];
      const daemon = makeDaemon({
        importProgressInterval: 0,
        logger: { ...silentLogger, info: (message, meta) => infos.push([message, meta]) },
        importer: {
          importDirs: async (dirs, { onStart, onFile }) => {
            onStart(3);
            for (let done = 1; done <= 3; done++) onFile(`/walls/${done}.jpg`, { status: 'imported' }, done);
            return { imported: [] };
          }
        }
      });

      await daemon.start();
      await daemon.importing;

      expect(infos.find(([message]) => message === 'Daemon started')[1]).to.have.property('version');
      expect(infos.filter(([message]) => message.startsWith('Import')).map(([message, meta]) => [message, meta])).to.deep.equal([
        ['Import started', { files: 3 }],
        ['Import progress', { done: 1, total: 3 }],
        ['Import progress', { done: 2, total: 3 }]
      ]);
      await daemon.stop();
    });

    it('skips importing when no directories are configured', async () => {
      let called = false;
      const daemon = makeDaemon({ importer: { importDirs: async () => { called = true; return { imported: [] }; } } });
      await daemon.start();
      await daemon.importing;

      expect(called).to.be.false;
      await daemon.stop();
    });

    it('does not block startup, and stop waits for the import to wind down', async () => {
      config.set('library.import_dirs', ['/walls']);
      let release;
      let sawStop = false;
      const daemon = makeDaemon({
        importer: {
          importDirs: async (dirs, { shouldStop }) => {
            await new Promise(resolve => { release = resolve; });
            sawStop = shouldStop();
            return { imported: [1] };
          }
        }
      });

      await daemon.start();
      expect(await readState(tempDir)).to.not.be.null;

      const stopping = daemon.stop();
      release();
      await stopping;

      expect(sawStop).to.be.true;
      expect(clients.every(c => !c.client.commands.some(cmd => cmd[0] === 'loadfile'))).to.be.true;
    });

    it('logs import failures without stopping the daemon', async () => {
      config.set('library.import_dirs', ['/walls']);
      const errors = [];
      const daemon = makeDaemon({
        logger: { ...silentLogger, error: (message, meta) => errors.push(meta.error) },
        importer: { importDirs: async () => { throw new Error('disk gone'); } }
      });

      await daemon.start();
      await daemon.importing;

      expect(errors).to.deep.equal(['disk gone']);
      expect(await readState(tempDir)).to.not.be.null;
      await daemon.stop();
    });
  });

  describe('when a file loads', () => {
    let daemon;

    beforeEach(async () => {
      daemon = makeDaemon();
      await daemon.start();
    });

    afterEach(async () => {
      await daemon.stop();
    });

    const load = async (index, filePath) => {
      clients[index].client.emit('property-change', { event: 'property-change', name: 'path', data: filePath });
      await tick();
    };

    it('applies the stored speed and remembers the video per mode and monitor', async () => {
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4', speed: 0.6 });
      await load(1, '/m/v.mp4');

      expect(clients[1].client.properties.speed).to.equal(0.6);
      expect(db.getSetting(lastMediaKey('video', 'HDMI-1'))).to.equal(id);
      expect(db.getSetting(lastMediaKey('video', 'DP-1'))).to.be.null;
    });

    it('makes the menu previews of the loaded item and the next entry in the background, for the panel style only', async () => {
      const made = [];
      daemon.thumbnail = async media => { made.push(media.id); return `/t/${media.id}.jpg`; };
      const a = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/a.mp4' });
      const b = db.addMedia({ kind: 'video', source: 'local', source_id: 2, path: '/m/b.mp4' });
      clients[0].client.properties.playlist = [{ filename: '/m/a.mp4', current: true }, { filename: '/m/b.mp4' }];
      await load(0, '/m/a.mp4');
      await daemon.screens.get('DP-1').thumbnails;
      expect(made).to.deep.equal([a, b]);

      config.set('menu.style', 'minimal');
      await load(0, '/m/b.mp4');
      await daemon.screens.get('DP-1').thumbnails;
      expect(made).to.deep.equal([a, b]);
    });

    it('remembers images without touching speed', async () => {
      const id = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/i.png' });
      await load(0, '/m/i.png');

      expect(clients[0].client.properties).to.not.have.property('speed');
      expect(db.getSetting(lastMediaKey('image', 'DP-1'))).to.equal(id);
    });

    it('applies the stored dim to every load, resetting it for undimmed and unknown files', async () => {
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/dark.png', dim: 40 });
      db.addMedia({ kind: 'image', source: 'local', source_id: 2, path: '/m/plain.png' });
      const { client } = clients[0];

      await load(0, '/m/dark.png');
      expect(client.properties.contrast).to.equal(-40);
      await load(0, '/m/plain.png');
      expect(client.properties.contrast).to.equal(0);
      client.properties.contrast = -40;
      await load(0, '/elsewhere.png');
      expect(client.properties.contrast).to.equal(0);
    });

    it('ends videos after display.video_duration and clears the limit for the next item', async () => {
      db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/short.mp4', duration: 20 });
      db.addMedia({ kind: 'video', source: 'local', source_id: 2, path: '/m/long.mp4', duration: 1800 });
      db.addMedia({ kind: 'image', source: 'local', source_id: 3, path: '/m/i.png' });
      const { client } = clients[0];

      await load(0, '/m/short.mp4');
      expect(client.properties).to.include({ 'loop-file': 5, end: 'none' });
      await load(0, '/m/long.mp4');
      expect(client.properties).to.include({ 'loop-file': 'no', end: '120' });
      await load(0, '/m/i.png');
      expect(client.properties.end).to.equal('none');
      await load(0, '/elsewhere.mp4');
      expect(client.properties).to.include({ 'loop-file': 'inf', end: 'none' });
    });

    it('counts a bounce as twice the video and reverses bouncing videos as they load', async () => {
      const reversed = [];
      await daemon.stop();
      clients.length = 0;
      daemon = makeDaemon({ reverse: async media => { reversed.push(media.id); return null; } });
      await daemon.start();
      config.set('display.video_loop', 'bounce');
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/b.mp4', duration: 20 });
      const { client } = clients[0];

      await load(0, `edl://%8%/m/b.mp4;%12%/c/bounce/1`);
      // 120 s of 40 s passes: this one and 2 more
      expect(client.properties).to.include({ 'loop-file': 2, end: 'none' });
      expect([...daemon.screens.values()].find(screen => screen.client === client).media.id).to.equal(id);
      await tick();
      expect(reversed).to.deep.equal([id]);

      // A failed encode is not tried again on the next play
      await load(0, '/m/other.mp4');
      await load(0, '/m/b.mp4');
      await tick();
      expect(client.properties).to.include({ 'loop-file': 5 });
      expect(reversed).to.deep.equal([id]);
    });

    it('notifies on every load only with display.notify: all', async () => {
      notifications.length = 0;
      db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4', duration: 20 });
      await load(0, '/m/v.mp4');
      expect(notifications).to.have.length(0);
      config.set('display.notify', 'all');
      await load(0, '/m/v.mp4');
      await load(0, '/elsewhere.mp4');
      expect(notifications).to.have.length(1);
      expect(notifications[0].at(-1)).to.include('DP-1');
    });

    it('loops videos forever when display.video_duration is 0', async () => {
      config.set('display.video_duration', 0);
      db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/short.mp4', duration: 20 });
      await load(0, '/m/short.mp4');
      expect(clients[0].client.properties).to.include({ 'loop-file': 'inf', end: 'none' });
    });

    it('reshuffles the playlist when playback wraps to its first entry', async () => {
      const { client } = clients[0];
      const playlist = playing => ['a', 'b', 'c'].map((name, index) => ({ id: index + 1, filename: `/m/${name}.png`, current: name === playing }));
      client.properties.playlist = playlist('c');
      await load(0, '/m/c.png');
      client.properties.playlist = playlist('a');
      await load(0, '/m/a.png');

      expect(client.commands.filter(cmd => cmd[0] === 'playlist-shuffle')).to.have.length(1);
    });

    it('ignores files outside the library and other properties', async () => {
      await load(0, '/elsewhere.mp4');
      clients[0].client.emit('property-change', { name: 'speed', data: 2 });
      await tick();

      expect(clients[0].client.properties).to.not.have.property('speed');
    });
  });

  describe('restarts', () => {
    it('relaunches a monitor whose mpv exits', async () => {
      const daemon = makeDaemon();
      await daemon.start();

      spawned[0].child.exit(1);
      await launches(spawned, 3);

      expect(spawned).to.have.length(3);
      expect(spawned[2].args).to.include('2560x1440+0+0');
      expect(clients[0].client.closed).to.be.true;
      await daemon.stop();
    });

    it('gives up after repeated exits within a minute', async () => {
      const daemon = makeDaemon();
      await daemon.start();

      // Each exit within the budget brings another launch, however long the machine takes
      for (let i = 0; i < 5; i++) {
        const launched = spawned.length;
        spawned[launched - 1].child.exit(1);
        for (let waited = 0; spawned.length === launched && waited < 5000; waited += 5) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      expect(spawned).to.have.length(2 + 5);

      // The sixth gets none
      spawned[spawned.length - 1].child.exit(1);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(spawned).to.have.length(2 + 5);
      await daemon.stop();
    });

    it('notifies when it gives up on a monitor', async () => {
      notifications.length = 0;
      const daemon = makeDaemon();
      await daemon.start();
      for (let i = 0; i < 6; i++) {
        const launched = spawned.length;
        spawned[launched - 1].child.exit(1);
        for (let waited = 0; spawned.length === launched && waited < 200; waited += 5) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      expect(notifications).to.have.length(1);
      expect(notifications[0].at(-1)).to.include('given up');
      await daemon.stop();
    });

    it('pipes the wallpaper process output and puts its last lines in the exit warning', async () => {
      const warnings = [];
      const logger = { ...silentLogger, warn: (message, meta) => warnings.push({ message, meta }) };
      const daemon = makeDaemon({
        logger,
        spawn: (file, args, options) => {
          const child = new FakeChild(1000 + spawned.length);
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          spawned.push({ file, args, options, child });
          return child;
        }
      });
      await daemon.start();
      expect(spawned[0].options.stdio).to.deep.equal(['ignore', 'pipe', 'pipe']);

      spawned[0].child.stderr.write('X Error of failed request:  BadMatch\n');
      await tick();
      spawned[0].child.exit(1);
      await new Promise(resolve => setTimeout(resolve, 20));

      const exited = warnings.find(w => w.message === 'mpv exited, restarting');
      expect(exited.meta.output).to.deep.equal(['X Error of failed request:  BadMatch']);
      await daemon.stop();
    });

    describe('when mpv opens no file', () => {
      const mpvKills = index => kills.filter(([pid, signal]) => signal === 'SIGKILL' && Math.abs(pid) === spawned[index].child.pid);

      beforeEach(() => {
        db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/1.mp4', width: 2560, height: 1920 });
      });

      it('kills it once the wait is over, so the restart path tries again', async () => {
        const daemon = makeDaemon({ firstFileTimeout: 20 });
        await daemon.start();
        // The second monitor opens its file in time
        clients[1].client.emit('property-change', { name: 'path', data: '/m/1.mp4' });
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mpvKills(0)).to.have.length(1);
        expect(mpvKills(1)).to.have.length(0);
        await daemon.stop();
      });

      it('waits for nothing without media to show', async () => {
        db.close();
        db = new DatabaseManager();
        db.initialize(':memory:');
        const daemon = makeDaemon({ firstFileTimeout: 10 });
        await daemon.start();
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(kills.filter(([, signal]) => signal === 'SIGKILL')).to.have.length(0);
        await daemon.stop();
      });

      it('stops waiting when the daemon stops', async () => {
        const daemon = makeDaemon({ firstFileTimeout: 30 });
        await daemon.start();
        await daemon.stop();
        const before = kills.length;
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(kills).to.have.length(before);
      });
    });
  });

  describe('unplayable files', () => {
    const playlist = [
      { filename: '/media/a.mp4', id: 1 },
      { filename: '/gone/b.mp4', id: 2 },
      { filename: '/gone/c.mp4', id: 3, current: true }
    ];
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    const removals = client => client.commands.filter(cmd => cmd[0] === 'playlist-remove');

    it('drops the failed entry by its playlist id and ignores normal ends', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      const { client } = clients[0];
      client.properties.playlist = playlist;

      client.emit('end-file', { event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
      client.emit('end-file', { event: 'end-file', reason: 'error', playlist_entry_id: 3, file_error: 'loading failed' });
      await settle();

      expect(removals(client)).to.deep.equal([['playlist-remove', 2]]);
      expect(removals(clients[1].client)).to.deep.equal([]);
      await daemon.stop();
    });

    it('serializes removals so later failures use fresh indexes', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      const { client } = clients[0];
      client.properties.playlist = [...playlist];
      const command = client.command.bind(client);
      client.command = async (...args) => {
        if (args[0] === 'playlist-remove') client.properties.playlist.splice(args[1], 1);
        return command(...args);
      };

      client.emit('end-file', { event: 'end-file', reason: 'error', playlist_entry_id: 2 });
      client.emit('end-file', { event: 'end-file', reason: 'error', playlist_entry_id: 3 });
      client.emit('end-file', { event: 'end-file', reason: 'error', playlist_entry_id: 3 });
      await settle();

      expect(removals(client)).to.deep.equal([['playlist-remove', 1], ['playlist-remove', 1]]);
      expect(client.properties.playlist.map(entry => entry.id)).to.deep.equal([1]);
      await daemon.stop();
    });

    it('logs instead of throwing when the playlist cannot be read', async () => {
      const warnings = [];
      const daemon = makeDaemon({ logger: { ...silentLogger, warn: (message) => warnings.push(message) } });
      await daemon.start();
      delete clients[0].client.properties.playlist;

      clients[0].client.emit('end-file', { event: 'end-file', reason: 'error', playlist_entry_id: 1 });
      await settle();

      expect(warnings).to.include('Failed to drop unplayable file');
      await daemon.stop();
    });
  });

  describe('health checks', () => {
    it('waits 15 s for mpv on loads but only 5 s on a health check', async () => {
      const options = [];
      const daemon = makeDaemon({
        connect: async (socketPath, connectOptions) => {
          options.push(connectOptions);
          const client = new FakeMpvClient();
          clients.push({ socketPath, client });
          return client;
        }
      });
      await daemon.start();
      expect(options[0]).to.include({ timeout: 15000 });
      const asked = [];
      const { client } = clients.at(-1);
      const getProperty = client.getProperty.bind(client);
      client.getProperty = (name, propertyOptions) => {
        asked.push([name, propertyOptions]);
        return getProperty(name);
      };
      await daemon.checkHealth();
      expect(asked[0]).to.deep.equal(['pid', { timeout: 5000 }]);
      await daemon.stop();
    });


    it('kills an mpv that misses two checks in a row, and resets on success', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      const { client } = clients[0];

      delete client.properties.pid;
      await daemon.checkHealth();
      client.properties.pid = 4242;
      await daemon.checkHealth();
      delete client.properties.pid;
      await daemon.checkHealth();
      expect(kills).to.deep.equal([]);

      await daemon.checkHealth();
      expect(kills).to.deep.equal([[-1000, 'SIGKILL']]);

      // The kill makes mpv exit, and the normal restart path takes over
      spawned[0].child.exit(null, 'SIGKILL');
      // The relaunch itself: a fixed 20 ms missed it once on a busy machine
      await launches(spawned, 3);
      expect(spawned).to.have.length(3);
      await daemon.stop();
    });

    it('samples mpv CPU per monitor and charges only intervals an item played through', async () => {
      let clock = 0;
      let ticks = 0;
      const procStat = () => `4242 (mpv) S ${'0 '.repeat(10)}${ticks} 0 0 0`;
      const warnings = [];
      const daemon = makeDaemon({
        now: () => clock, readFile: async () => procStat(),
        logger: { ...silentLogger, warn: (message, meta) => warnings.push([message, meta]) }
      });
      await daemon.start();
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/4k.mp4', width: 3840, height: 2160 });
      const { client } = clients[0];
      client.properties['hwdec-current'] = 'no';
      client.emit('property-change', { name: 'path', data: '/m/4k.mp4' });
      await tick();

      await daemon.checkHealth();
      clock += 30_000; ticks += 1200;
      await daemon.checkHealth();
      clock += 30_000; ticks += 600;
      await daemon.checkHealth();
      expect(db.getPlaybackStats(id)).to.include({ seconds: 60, cpu_seconds: 18, hwdec: 'no' });
      const [monitor] = (await readState(tempDir)).monitors;
      expect(monitor).to.include({ cpu: 30, hwdec: 'no' });
      expect(warnings.filter(([message]) => message === 'Video above 1080p is decoded in software')).to.have.length(1);

      // A new item mid-interval: the interval counts for the monitor average but for neither item
      clock += 10_000;
      client.emit('property-change', { name: 'path', data: '/elsewhere.mp4' });
      await tick();
      clock += 20_000; ticks += 300;
      await daemon.checkHealth();
      expect(db.getPlaybackStats(id).seconds).to.equal(60);
      await daemon.stop();
    });

    it('queues state writes, so concurrent ones never interleave in the file', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      await Promise.all(Array.from({ length: 8 }, () => daemon.writeState()));
      const state = await fs.readJson(path.join(tempDir, 'state.json'));
      expect(state.monitors.map(monitor => monitor.name)).to.deep.equal(['DP-1', 'HDMI-1']);
      await daemon.stop();
    });

    it('records the GPU memory each mpv holds at a health check in the state', async () => {
      const asked = [];
      let bytes = 512 * 1024 ** 2;
      const procStat = () => `4242 (mpv) S ${'0 '.repeat(10)}0 0 0 0`;
      const daemon = makeDaemon({ readFile: async () => procStat(), gpuMemory: async pid => { asked.push(pid); return bytes; } });
      await daemon.start();
      await daemon.checkHealth();
      expect(asked).to.deep.equal([4242, 4242]);
      expect((await fs.readJson(path.join(tempDir, 'state.json'))).monitors.map(monitor => monitor.gpuMemory)).to.deep.equal([bytes, bytes]);

      // An unreadable /proc leaves it unknown rather than failing the check
      bytes = null;
      daemon.gpuMemory = async () => { throw new Error('EACCES'); };
      await daemon.checkHealth();
      expect((await fs.readJson(path.join(tempDir, 'state.json'))).monitors.map(monitor => monitor.gpuMemory)).to.deep.equal([null, null]);
      expect(kills).to.deep.equal([]);
      await daemon.stop();
    });

    it('skips monitors whose process already exited', async () => {
      const daemon = makeDaemon({ restartDelay: 1000 });
      await daemon.start();
      delete clients[0].client.properties.pid;
      spawned[0].child.exit(1);

      await daemon.checkHealth();
      await daemon.checkHealth();

      expect(kills).to.deep.equal([]);
      await daemon.stop();
    });

    it('runs on a timer that stop clears', async () => {
      const daemon = makeDaemon({ healthInterval: 5 });
      await daemon.start();
      await new Promise(resolve => setTimeout(resolve, 30));
      const checks = () => clients[0].client.commands.filter(cmd => cmd[1] === 'pid').length;
      expect(checks()).to.be.greaterThan(1);

      await daemon.stop();
      const after = checks();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(checks()).to.equal(after);
    });
  });

  describe('monitor hotplug', () => {
    // Children exit when signalled, as real ones do, instead of on a timer
    const exitOnKill = { kill: (pid, signal) => {
      kills.push([pid, signal]);
      spawned.find(({ child }) => child.pid === -pid && child.exitCode === null)?.child.exit(0, signal);
    } };
    const THREE = LISTMONITORS_TWO.replace('Monitors: 2', 'Monitors: 3') + ' 2: +DP-2 3840/600x2160/340+3640+0  DP-2\n';
    const sockets = async () => (await readState(tempDir)).monitors.map(m => m.name);

    it('starts a newly attached monitor and records it in the state', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      layout = THREE;

      await daemon.checkMonitors();

      expect(spawned).to.have.length(3);
      expect(spawned[2].args).to.include('3840x2160+3640+0');
      expect(await sockets()).to.deep.equal(['DP-1', 'HDMI-1', 'DP-2']);
      await daemon.stop();
    });

    it('stops a removed monitor without treating its exit as a crash', async () => {
      const daemon = makeDaemon(exitOnKill);
      await daemon.start();
      layout = 'Monitors: 1\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n';

      await daemon.checkMonitors();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(kills).to.deep.include([-1001, 'SIGTERM']);
      expect(spawned).to.have.length(2);
      expect(await sockets()).to.deep.equal(['DP-1']);
      await daemon.stop();
    });

    it('respawns a monitor whose resolution or position changed', async () => {
      const daemon = makeDaemon(exitOnKill);
      await daemon.start();
      layout = LISTMONITORS_TWO.replace('2560/597x1440/336+0+0', '3840/597x2160/336+0+0').replace('+2560+0', '+3840+0');

      await daemon.checkMonitors();

      expect(spawned.slice(2).map(({ args }) => args.find(arg => /^\d+x\d+\+/.test(arg)))).to.deep.equal(['3840x2160+0+0', '1080x1920+3840+0']);
      expect((await readState(tempDir)).monitors.find(m => m.name === 'DP-1')).to.include({ width: 3840, height: 2160 });
      await daemon.stop();
    });

    it('leaves the layout alone on an empty or failed xrandr read, and when nothing changed', async () => {
      const warnings = [];
      const daemon = makeDaemon({ logger: { ...silentLogger, warn: message => warnings.push(message) } });
      await daemon.start();

      await daemon.checkMonitors();
      layout = 'Monitors: 0\n';
      await daemon.checkMonitors();
      layout = new Error('Can\'t open display');
      await daemon.checkMonitors();

      expect(spawned).to.have.length(2);
      expect(kills).to.deep.equal([]);
      expect(warnings).to.include.members(['No active monitors reported, keeping the current layout', 'Cannot read monitor layout']);
      await daemon.stop();
    });

    it('only manages configured monitors and picks one up again when it returns', async () => {
      config.set('display.monitors', ['HDMI-1']);
      const daemon = makeDaemon(exitOnKill);
      await daemon.start();
      layout = 'Monitors: 1\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n';
      await daemon.checkMonitors();
      expect(daemon.screens.size).to.equal(0);

      layout = LISTMONITORS_TWO;
      await daemon.checkMonitors();

      expect(spawned).to.have.length(2);
      expect(spawned[1].args).to.include('1080x1920+2560+0');
      await daemon.stop();
    });

    it('does not let a crash restart and a layout change both manage the same monitor', async () => {
      const daemon = makeDaemon({ ...exitOnKill, restartDelay: 10 });
      await daemon.start();
      spawned[1].child.exit(1);
      layout = 'Monitors: 1\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n';

      await daemon.checkMonitors();
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(spawned).to.have.length(2);
      expect([...daemon.screens.keys()]).to.deep.equal(['DP-1']);
      await daemon.stop();
    });

    it('shares one reconciliation between overlapping checks and polls on a timer', async () => {
      const daemon = makeDaemon({ monitorInterval: 5 });
      await daemon.start();
      layout = THREE;
      await Promise.all([daemon.checkMonitors(), daemon.checkMonitors()]);
      expect(spawned).to.have.length(3);

      layout = LISTMONITORS_TWO.replace('Monitors: 2', 'Monitors: 4') + ' 2: +DP-2 3840/600x2160/340+3640+0  DP-2\n 3: +DP-3 1920/1x1080/1+7480+0  DP-3\n';
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(spawned).to.have.length(4);
      await daemon.stop();
    });

    // A watcher stand-in: connected says whether i3's output events are live; options is what the daemon gave it
    const fakeWatcher = connected => {
      const watcher = { connected, started: 0, stopped: 0, options: null };
      watcher.start = () => { watcher.started++; };
      watcher.stop = () => { watcher.stopped++; };
      return watcher;
    };

    it('reads the layout on each output event, and while events are live polls only once the fallback has passed', async () => {
      let reads = 0;
      let time = 0;
      const watcher = fakeWatcher(true);
      const daemon = makeDaemon({
        monitorInterval: 5, monitorFallback: 1000, now: () => time,
        exec: async file => { if (file === 'xrandr') reads++; return layout; },
        watchOutputs: options => { watcher.options = options; return watcher; }
      });
      await daemon.start();
      expect(watcher.started).to.equal(1);
      expect(watcher.options.spawn).to.equal(daemon.spawn);
      const atStart = reads;

      // Ticks find live events and a recent enough check: no xrandr
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(reads).to.equal(atStart);

      layout = THREE;
      await watcher.options.onChange();
      expect(reads).to.equal(atStart + 1);
      expect(spawned).to.have.length(3);

      // Once the fallback has passed since that read, one tick reads again, and the next ones wait another fallback
      time = 1000;
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(reads).to.equal(atStart + 2);

      await daemon.stop();
      expect(watcher.stopped).to.equal(1);
    });

    it('polls on every tick while no output events are live', async () => {
      let reads = 0;
      const daemon = makeDaemon({
        monitorInterval: 5, monitorFallback: 60_000,
        exec: async file => { if (file === 'xrandr') reads++; return layout; },
        watchOutputs: () => fakeWatcher(false)
      });
      await daemon.start();
      const atStart = reads;
      layout = THREE;
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(reads).to.be.at.least(atStart + 3);
      expect(spawned).to.have.length(3);
      await daemon.stop();
    });

    it('asks xrandr for the current layout, without a probe', async () => {
      const calls = [];
      const daemon = makeDaemon({ exec: async (file, args) => { calls.push([file, ...args]); return layout; } });
      await daemon.start();
      await daemon.checkMonitors();
      expect(calls.filter(([file]) => file === 'xrandr')).to.deep.include(['xrandr', '--current', '--listactivemonitors']);
      expect(calls.some(call => call[0] === 'xrandr' && !call.includes('--current'))).to.equal(false);
      await daemon.stop();
    });
  });

  describe('visualizer', () => {
    let calls, visualizers;
    beforeEach(() => {
      calls = [];
      visualizers = {
        override: null,
        on: false,
        get active() { return this.override ?? this.on; },
        setEnabled: async on => { calls.push(['visualizer', on]); visualizers.override = on; },
        restackAll: async options => { calls.push(options?.scan ? 'restackAll scan' : 'restackAll'); },
        setPreset: async name => { calls.push(['preset', name]); },
        setLive: async (change, options) => {
          if (change?.changes?.opacity === 9) throw new Error('visualizer.opacity must be a number from 0 to 1, not 9');
          calls.push(['live', change, options]);
        },
        configure: async () => { calls.push('configure'); },
        sync: async () => { calls.push('sync'); },
        restack: name => { calls.push(['restack', name]); },
        reload: async () => { calls.push('reload'); },
        stop: async () => { calls.push('stop'); },
        describe: name => (name === 'HDMI-1' ? [{ instance: 'main', module: 'bars', geometry: '1080x480+2560+1440' }] : []),
        summary: () => ({ enabled: true, error: null, generation: calls.filter(call => call === 'configure' || call === 'reload').length })
      };
    });

    const exitOnKill = { kill: (pid, signal) => {
      kills.push([pid, signal]);
      spawned.find(({ child }) => child.pid === -pid && child.exitCode === null)?.child.exit(0, signal);
    } };

    const control = async (daemon, request) => {
      await fs.writeJson(controlPath(tempDir), { pid: process.pid, ...request });
      await daemon.applyControl();
    };

    it('restacks every monitor, looking for overlays, on a restack request', async () => {
      const daemon = makeDaemon({ visualizers });
      await daemon.start({ visualizer: true });
      calls.length = 0;
      await control(daemon, { restack: true });
      expect(calls).to.deep.equal(['restackAll scan']);
      await daemon.stop();
    });

    it('applies the visualizer menu\'s requests: a change, a refused one, and a saved preset with the changes dropped', async () => {
      const errors = [];
      let reloaded = 0;
      const daemon = makeDaemon({ visualizers, reloadConfig: async () => { reloaded++; },
        logger: { ...silentLogger, error: (message, meta) => errors.push([message, meta.error]) } });
      await daemon.start({ visualizer: true });
      calls.length = 0;
      await control(daemon, { visualizer_set: { instance: 'main', changes: { opacity: 0.5 } } });
      await control(daemon, { visualizer_set: { instance: 'main', changes: { opacity: 9 } } });
      expect(errors).to.deep.equal([['Visualizer change refused', 'visualizer.opacity must be a number from 0 to 1, not 9']]);
      await control(daemon, { reload_config: true, visualizer_reset: true, preset: 'mine' });
      expect(reloaded).to.equal(1);
      // The reset only records: the preset switch right after it reloads once
      expect(calls.filter(call => Array.isArray(call))).to.deep.equal([
        ['live', { instance: 'main', changes: { opacity: 0.5 } }, undefined],
        ['live', null, { reload: false }],
        ['preset', 'mine']
      ]);
      await control(daemon, { visualizer_reset: true });
      expect(calls.at(-1)).to.deep.equal(['live', null, { reload: true }]);
      await daemon.stop();
    });

    it('starts without wallpapers, tracking monitors for the visualizer, and refuses to start with nothing on', async () => {
      const daemon = makeDaemon({ visualizers });
      await daemon.start({ wallpaper: false, visualizer: true });
      expect(spawned).to.have.length(0);
      expect(visualizers.override).to.be.true;
      const state = await readState(tempDir);
      expect(state).to.include({ wallpaper: false, control: 0 });
      expect(state.monitors.map(monitor => [monitor.name, monitor.socket])).to.deep.equal([['DP-1', null], ['HDMI-1', null]]);
      // Hotplug follows monitors without starting wallpapers
      layout = 'Monitors: 1\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n';
      await daemon.checkMonitors();
      expect([...daemon.monitors.keys()]).to.deep.equal(['DP-1']);
      expect(spawned).to.have.length(0);
      await daemon.stop();

      let caught;
      try { await makeDaemon({ visualizers }).start({ wallpaper: false, visualizer: false }); } catch (error) { caught = error; }
      expect(caught.message).to.equal('Nothing to show: the wallpaper is off and the visualizer did not start');
      expect(await readState(tempDir)).to.be.null;
    });

    it('switches the wallpaper and visualizer on and off on request, placing the visualizer over new wallpapers', async () => {
      const daemon = makeDaemon({ visualizers, ...exitOnKill });
      await daemon.start({ visualizer: true });
      expect(spawned).to.have.length(2);

      await control(daemon, { wallpaper: false });
      expect(daemon.screens.size).to.equal(0);
      expect(kills.map(kill => kill[1])).to.deep.equal(['SIGTERM', 'SIGTERM']);
      let state = await readState(tempDir);
      expect(state).to.include({ wallpaper: false, control: 1 });
      expect(await fs.pathExists(controlPath(tempDir))).to.be.false;
      // Its own exits are not crashes
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(spawned).to.have.length(2);

      await control(daemon, { wallpaper: true });
      expect(spawned).to.have.length(4);
      expect(calls.at(-1)).to.equal('restackAll');
      state = await readState(tempDir);
      expect(state.monitors.every(monitor => monitor.socket)).to.be.true;

      // A request for another daemon is ignored, but still answered
      await fs.writeJson(controlPath(tempDir), { pid: process.pid + 1, wallpaper: false });
      await daemon.applyControl();
      expect((await readState(tempDir)).control).to.equal(3);
      expect(daemon.wallpaper).to.be.true;

      await control(daemon, { visualizer: false });
      expect(calls).to.deep.include(['visualizer', false]);
      await control(daemon, { wallpaper: false });
      // Neither part is left on, so the daemon stopped
      expect(await readState(tempDir)).to.be.null;
      expect(daemon.stopping).to.be.true;
    });

    it('applies every pending request on one signal, oldest first, and lists their ids', async () => {
      const daemon = makeDaemon({ visualizers, ...exitOnKill });
      await daemon.start({ visualizer: true });
      daemon.controls.applyDurations = async () => { throw new Error('durations broke'); };
      // A temporary file is still being written, and is left for its writer to rename
      await fs.writeJson(controlRequestPath(tempDir, '2-b'), { pid: process.pid, visualizer: false });
      await fs.writeJson(controlRequestPath(tempDir, '1-a'), { pid: process.pid, wallpaper: false });
      await fs.writeJson(controlRequestPath(tempDir, '3-c'), { pid: process.pid, durations: true });
      await fs.writeJson(controlPath(tempDir), { pid: process.pid, visualizer: true });
      await fs.writeJson(path.join(tempDir, '.control-4-d.json.tmp'), { pid: process.pid, wallpaper: true });
      await daemon.applyControl();

      // control.json first, then by name: the visualizer turned on, the wallpaper off, then the visualizer off
      // would leave nothing, so the stop check waits until all were applied; 3-c failed and is not listed
      expect(calls.filter(call => Array.isArray(call) && call[0] === 'visualizer')).to.deep.equal([['visualizer', true], ['visualizer', false]]);
      expect(await readState(tempDir)).to.be.null;
      expect(daemon.handledRequests).to.deep.equal(['1-a', '2-b']);
      expect(daemon.controlGeneration).to.equal(3);
      expect((await fs.readdir(tempDir)).filter(name => name.includes('control'))).to.deep.equal(['.control-4-d.json.tmp']);
    });

    it('lists handled ids in the state, keeping the latest, and clears old requests on start', async () => {
      await fs.writeJson(controlRequestPath(tempDir, 'stale'), { pid: process.pid, wallpaper: false });
      const daemon = makeDaemon({ visualizers });
      await daemon.start({ visualizer: true });
      expect(await fs.pathExists(controlRequestPath(tempDir, 'stale'))).to.be.false;
      expect((await readState(tempDir)).handled).to.deep.equal([]);
      for (let n = 0; n < 40; n++) {
        await fs.writeJson(controlRequestPath(tempDir, String(n).padStart(2, '0')), { pid: process.pid });
      }
      await daemon.applyControl();
      const { handled, control } = await readState(tempDir);
      expect(handled).to.have.length(32);
      expect([handled[0], handled.at(-1)]).to.deep.equal(['08', '39']);
      expect(control).to.equal(40);
      // A signal with no request still moves the counter older CLIs wait on
      await daemon.applyControl();
      expect((await readState(tempDir)).control).to.equal(41);
      await daemon.stop();
    });


    it('starts it after the wallpapers and records it, with the daemon version, in the state', async () => {
      const daemon = makeDaemon({ visualizers });
      await daemon.start();
      expect(calls).to.deep.equal(['configure', 'sync']);
      const state = await readState(tempDir);
      expect(state.version).to.match(/^\d+\.\d+\.\d+/);
      expect(state.visualizer).to.deep.equal({ enabled: true, error: null, generation: 1 });
      expect(state.monitors.map(monitor => monitor.visualizer)).to.deep.equal([null, { instance: 'main', module: 'bars', geometry: '1080x480+2560+1440' }]);
      expect(state.monitors.map(monitor => monitor.visualizers.length)).to.deep.equal([0, 1]);
      await daemon.stop();
      expect(calls.at(-1)).to.equal('stop');
    });

    it('refuses the screensaver\'s preset on request while the screensaver is off, and takes it while on', async () => {
      const daemon = makeDaemon({ visualizers });
      await daemon.start();
      await control(daemon, { preset: 'screensaver' });
      expect(calls.filter(call => call[0] === 'preset')).to.deep.equal([]);
      // The request is still answered, so its CLI does not wait
      expect((await readState(tempDir)).control).to.equal(1);
      daemon.screensaver.active = { trigger: 'key', since: 0 };
      await control(daemon, { preset: 'screensaver' });
      expect(calls.filter(call => call[0] === 'preset')).to.deep.equal([['preset', 'screensaver']]);
      daemon.screensaver.active = null;
      await daemon.stop();
    });

    it('switches the preset on request, and back to the configured one with null', async () => {
      const daemon = makeDaemon({ visualizers });
      await daemon.start();
      await control(daemon, { preset: 'party' });
      await control(daemon, { preset: null });
      expect(calls.filter(call => call[0] === 'preset')).to.deep.equal([['preset', 'party'], ['preset', null]]);
      expect((await readState(tempDir)).control).to.equal(2);
      await daemon.stop();
    });

    it('follows monitor changes and places it again over a restarted wallpaper', async () => {
      const daemon = makeDaemon({ visualizers });
      await daemon.start();
      spawned[1].child.exit(1);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls).to.deep.include(['restack', 'HDMI-1']);
      layout = 'Monitors: 1\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n';
      await daemon.checkMonitors();
      expect(calls.filter(call => call === 'sync')).to.have.length(2);
      await daemon.stop();
    });

    it('reloads only the visualizer section on SIGHUP, and keeps it when the file no longer parses', async () => {
      let reloads = 0;
      const errors = [];
      const daemon = makeDaemon({
        visualizers, logger: { ...silentLogger, error: message => errors.push(message) },
        reloadConfig: async () => { reloads++; if (reloads === 2) throw new Error('Failed to load config: bad YAML'); }
      });
      await daemon.start();
      await daemon.reloadVisualizer();
      expect(calls.slice(2)).to.deep.equal(['reload']);
      expect((await readState(tempDir)).visualizer.generation).to.equal(2);
      await daemon.reloadVisualizer();
      expect(calls.slice(2)).to.deep.equal(['reload']);
      expect(errors).to.include('Visualizer reload failed, keeping the running one');
      await daemon.stop();
      await daemon.reloadVisualizer();
      expect(reloads).to.equal(2);
    });
  });

  describe('durations', () => {
    it('applies durations next stored to what plays now and to later loads, until cleared', async () => {
      let time = 1_000_000;
      const daemon = makeDaemon({ now: () => time });
      await daemon.start();
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/1.mp4', width: 1920, height: 1080, duration: 18 });
      const [screen] = daemon.screens.values();
      screen.media = db.getMedia(id);
      screen.loadedAt = time;
      time += 50_000;

      await fs.writeJson(nextFiltersPath(tempDir), { pid: process.pid, image_duration: 45, video_duration: 120 });
      await fs.writeJson(controlPath(tempDir), { pid: process.pid, durations: true });
      await daemon.applyControl();
      const { client } = clients.find(item => item.socketPath === screen.socketPath);
      expect(client.properties).to.include({ 'image-display-duration': 45, 'loop-file': 3, end: 'none' });
      expect((await readState(tempDir)).control).to.equal(1);
      // Later loads use them too
      expect(daemon.imageDuration()).to.equal(45);
      expect(daemon.videoDuration()).to.equal(120);

      await fs.remove(nextFiltersPath(tempDir));
      await fs.writeJson(controlPath(tempDir), { pid: process.pid, durations: true });
      await daemon.applyControl();
      expect(daemon.imageDuration()).to.equal(config.get().display.image_duration);
      expect(client.properties['image-display-duration']).to.equal(config.get().display.image_duration);
      await daemon.stop();
    });

    it('counts the video duration again from where a video plays when its speed changes', async () => {
      let time = 1_000_000;
      config.set('display.video_duration', 120);
      const daemon = makeDaemon({ now: () => time });
      await daemon.start();
      const short = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/1.mp4', width: 1920, height: 1080, duration: 18 });
      const long = db.addMedia({ kind: 'video', source: 'local', source_id: 2, path: '/m/2.mp4', width: 1920, height: 1080, duration: 1800 });
      const [screen] = daemon.screens.values();
      const { client } = clients.find(item => item.socketPath === screen.socketPath);
      const speedTo = async speed => {
        client.emit('property-change', { name: 'speed', data: speed });
        await new Promise(resolve => setTimeout(resolve, 5));
      };
      expect(client.commands).to.deep.include(['observe_property', 4, 'speed']);

      screen.media = db.getMedia(short);
      screen.loadedAt = time;
      // The speed every load sets is the stored one: nothing to count again
      client.properties['loop-file'] = 'untouched';
      await speedTo(1);
      expect(client.properties['loop-file']).to.equal('untouched');

      // 50s in at 9s into a pass, slowed to half: 18s of this pass left, 52s after it fits one more 36s pass
      time += 50_000;
      client.properties['time-pos'] = 9;
      await speedTo(0.5);
      expect(client.properties).to.include({ 'loop-file': 1, end: 'none' });
      expect(screen.media.speed).to.equal(0.5);

      // A long video 30s in at 30s, doubled: 90s of wall time left are 180s of media
      screen.media = db.getMedia(long);
      screen.loadedAt = time;
      time += 30_000;
      client.properties['time-pos'] = 30;
      await speedTo(2);
      expect(client.properties).to.include({ 'loop-file': 'no', end: '210' });

      // Images have no speed to follow
      screen.media = { ...db.getMedia(long), kind: 'image' };
      client.properties.end = 'kept';
      await speedTo(3);
      expect(client.properties.end).to.equal('kept');
      await daemon.stop();
    });
  });

  describe('config watch', () => {
    let watched, calls, visualizers, sections, importWatches;
    // The config directory's watch, and import folders' (recursive, with options) apart from it
    const fakeWatch = (dir, options, listener = options) => {
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; };
      if (typeof options === 'object') importWatches.push({ dir, options, watcher });
      else watched = { dir, listener, watcher };
      return watcher;
    };
    // The config file as the next load reads it: a visualizer section, an Error for a bad file, { section,
    // warnings } for a visualizer section with the file's unknown-key warnings, or { settings } with other
    // settings by key ('display.order': 'shuffle')
    const readConfig = async () => {
      const next = sections.shift();
      if (next instanceof Error) throw next;
      const base = structuredClone(config.get());
      let warnings = config.warnings ?? [];
      if (next?.settings) {
        for (const [key, value] of Object.entries(next.settings)) {
          const [section, name] = key.split('.');
          base[section][name] = value;
        }
      } else if (next?.warnings) {
        warnings = next.warnings;
        base.visualizer = next.section;
      } else {
        base.visualizer = next;
      }
      return { get: () => base, warnings };
    };
    const save = async (name = 'config.yaml') => {
      watched.listener('rename', name);
      await new Promise(resolve => setTimeout(resolve, 15));
      await daemon.queue;
    };
    let daemon;

    beforeEach(async () => {
      calls = [];
      sections = [];
      importWatches = [];
      visualizers = {
        override: null, active: true, error: null,
        configure: async () => {}, sync: async () => {}, stop: async () => {}, restack: () => {},
        reload: async () => { calls.push('reload'); },
        refresh: async () => { calls.push('refresh'); },
        describe: () => [], summary: () => ({ enabled: true, error: visualizers.error, generation: 1 })
      };
      config.configPath = path.join(tempDir, 'config', 'config.yaml');
      notifications.length = 0;
      daemon = makeDaemon({ visualizers, readConfig, watch: fakeWatch, configSettle: 5 });
      await daemon.start();
    });
    afterEach(async () => { await daemon.stop(); });

    it('watches import folders while running and stops when a saved file turns watching off', async () => {
      const folder = path.join(tempDir, 'walls');
      await fs.ensureDir(folder);
      daemon.importer = { importDirs: async () => ({ imported: [] }) };
      sections.push({ settings: { 'library.import_dirs': [folder] } });
      await save();
      expect(importWatches.map(entry => [entry.dir, entry.watcher.closed])).to.deep.equal([[folder, undefined]]);

      sections.push({ settings: { 'library.watch_imports': false } });
      await save();
      expect(importWatches[0].watcher.closed).to.be.true;
      expect(daemon.importWatcher.watching).to.deep.equal([]);
    });

    it('watches the config directory and refreshes the visualizer when its section changed', async () => {
      expect(watched.dir).to.equal(path.join(tempDir, 'config'));
      sections.push({ ...config.get().visualizer, opacity: 0.5 });
      // Several events from one save become one refresh; other files in the directory are ignored
      watched.listener('change', 'config.yaml');
      watched.listener('change', '4913');
      await save();
      expect(calls).to.deep.equal(['refresh']);
      expect(config.get().visualizer.opacity).to.equal(0.5);

      // A save that leaves the section as it was changes nothing
      sections.push({ ...config.get().visualizer });
      await save();
      await save('config.yaml~');
      expect(calls).to.deep.equal(['refresh']);
      expect(notifications).to.deep.equal([]);
    });

    it('keeps the running visualizer and announces a bad file or value', async () => {
      const before = config.get().visualizer;
      sections.push(new Error('Failed to load config: Nested mappings are not allowed in compact mappings'));
      await save();
      sections.push({ ...before, bars: { width: 0 } });
      await save();
      expect(calls).to.deep.equal([]);
      expect(config.get().visualizer).to.deep.equal(before);
      expect(notifications.map(args => args.at(-1))).to.deep.equal([
        'Config not applied: Failed to load config: Nested mappings are not allowed in compact mappings',
        'Config not applied: visualizer.bars.width must be an integer from 1, not 0'
      ]);
      expect(notifications[0]).to.include('--urgency=critical');

      // Problems found only when starting it are announced too
      visualizers.error = 'GLava shaders not found in /x (no bars.glsl); set visualizer.glava.shader_dir';
      sections.push({ ...before, module: 'radial' });
      await save();
      expect(calls).to.deep.equal(['refresh']);
      expect(notifications.at(-1).at(-1)).to.equal(`Visualizer off: ${visualizers.error}`);
    });

    it('logs unknown keys at start and announces each one a save adds once', async () => {
      await daemon.stop();
      const warnings = [];
      const logger = { ...silentLogger, warn: (message, meta) => message === 'Unknown config keys' && warnings.push(meta.warnings) };
      config.warnings = ['Unknown config key "displya"; closest: "display"'];
      daemon = makeDaemon({ visualizers, readConfig, watch: fakeWatch, configSettle: 5, logger });
      await daemon.start();
      expect(warnings).to.deep.equal([config.warnings]);

      const section = config.get().visualizer;
      const typo = 'Unknown config key "visualizer.colour"; closest: "visualizer.colors"';
      sections.push({ section, warnings: [config.warnings[0], typo] });
      await save();
      // Saving again without fixing it, or fixing it, announces nothing more
      sections.push({ section, warnings: [config.warnings[0], typo] });
      await save();
      sections.push({ section, warnings: [] });
      await save();
      expect(notifications.map(args => args.at(-1))).to.deep.equal([typo]);
      expect(warnings.at(-1)).to.deep.equal([typo]);
      expect(calls).to.deep.equal([]);
      config.warnings = [];
    });

    it('applies other settings by their kind: taken in, durations, playlists, monitors and imports', async () => {
      const client = clients[0].client;
      // An eligibility change brings the playlist in line (reading it) rather than loading a new one
      const loads = () => client.commands.filter(command => command[0] === 'loadfile' && command[2] === 'replace').length;
      const reads = () => client.commands.filter(command => command[0] === 'get_property' && command[1] === 'playlist').length;
      const [loadsBefore, readsBefore] = [loads(), reads()];
      const imported = [];
      daemon.importer = { importDirs: async dirs => { imported.push(dirs); return { imported: [] }; } };
      sections.push({ settings: {
        'display.order': 'shuffle', 'library.trash_days': 7, 'display.image_duration': 42,
        'display.allow_upscale': true, 'display.monitors': ['DP-1'], 'library.import_dirs': ['/new']
      } });
      await save();
      const settings = config.get();
      expect(settings.display).to.include({ order: 'shuffle', image_duration: 42, allow_upscale: true });
      expect(settings.library).to.include({ trash_days: 7 });
      expect(client.properties['image-display-duration']).to.equal(42);
      expect(reads()).to.be.above(readsBefore);
      expect(loads()).to.equal(loadsBefore);
      // The monitor list changed: the layout was read again and HDMI-1 dropped
      expect([...daemon.monitors.keys()]).to.deep.equal(['DP-1']);
      await daemon.importing;
      expect(imported).to.deep.equal([['/new']]);
      expect(notifications).to.deep.equal([]);
    });

    it('announces settings that need a restart, without taking them, and keeps everything on a bad value', async () => {
      const args = config.get().display.mpv_args;
      sections.push({ settings: { 'display.mpv_args': ['--hwdec=no'], 'display.order': 'shuffle' } });
      await save();
      expect(config.get().display.mpv_args).to.deep.equal(args);
      expect(config.get().display.order).to.equal('shuffle');
      expect(notifications.at(-1).at(-1)).to.equal('Restart the daemon to apply: display.mpv_args (backdrop stop, then backdrop start)');

      sections.push(new Error('Failed to load config: invalid values in /c.yaml:\n  display.notify must be commands, all or off, not "loud"'));
      await save();
      expect(notifications.at(-1).at(-1)).to.include('Config not applied').and.include('display.notify must be');
      expect(config.get().display.order).to.equal('shuffle');
    });

    it('stops watching when the daemon stops', async () => {
      await daemon.stop();
      expect(watched.watcher.closed).to.be.true;
      sections.push({ ...config.get().visualizer, opacity: 0.1 });
      watched.listener('change', 'config.yaml');
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(calls).to.deep.equal([]);
    });
  });

  describe('trash purge', () => {
    it('purges once on start and then on its interval, logging failures', async () => {
      const errors = [];
      const daemon = makeDaemon({
        purgeInterval: 5,
        logger: { ...silentLogger, error: (message) => errors.push(message) },
        purge: async () => { purges++; if (purges === 2) throw new Error('disk'); }
      });
      await daemon.start();
      expect(purges).to.equal(1);
      await new Promise(resolve => setTimeout(resolve, 30));
      await daemon.stop();

      expect(purges).to.be.greaterThan(2);
      expect(errors).to.include('Trash purge failed');
    });
  });

  describe('stop', () => {
    it('quits mpv, signals process groups and removes runtime files', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      spawned.forEach(({ child }) => setTimeout(() => child.exit(0, 'SIGTERM'), 5));

      await daemon.stop();

      expect(clients.every(c => c.client.commands.some(cmd => cmd[0] === 'quit'))).to.be.true;
      expect(kills).to.deep.equal([[-1000, 'SIGTERM'], [-1001, 'SIGTERM']]);
      expect(await fs.readdir(tempDir)).to.deep.equal([]);
    });

    it('escalates to SIGKILL when a process ignores SIGTERM', async () => {
      const daemon = makeDaemon();
      await daemon.start();

      await daemon.stop();

      expect(kills).to.deep.include([-1000, 'SIGKILL']);
    });

    it('does not restart processes that exit during shutdown', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      const stopping = daemon.stop();
      spawned[0].child.exit(0);
      await stopping;
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(spawned).to.have.length(2);
    });
  });

  describe('child processes', () => {
    it('ends what a crashed daemon left before starting, and records every child until it stops', async () => {
      const daemon = makeDaemon();
      await daemon.start();
      expect(reaped).to.deep.equal([tempDir]);
      const record = await fs.readJson(childrenPath(tempDir));
      expect(record.daemon).to.equal(process.pid);
      expect(record.children).to.deep.equal([
        { pid: 1000, group: true, command: 'xwinwrap', start: 't1000' },
        { pid: 1001, group: true, command: 'xwinwrap', start: 't1001' }
      ]);

      // A child that exits is dropped; its replacement is recorded
      spawned[0].child.exit(1);
      await launches(spawned, 3);
      const pids = (await fs.readJson(childrenPath(tempDir))).children.map(child => child.pid);
      expect(pids).to.not.include(1000);
      expect(pids).to.include(1001);

      await daemon.stop();
      expect(await fs.pathExists(childrenPath(tempDir))).to.equal(false);
    });

    it('stops everything and exits 1 on an uncaught error', async () => {
      const errors = [];
      const daemon = makeDaemon({ logger: { ...silentLogger, error: (message, meta) => errors.push([message, meta.error]) } });
      await daemon.start();
      let code;
      await daemon.crash(new Error('boom'), exitCode => { code = exitCode; });
      expect(code).to.equal(1);
      expect(errors).to.deep.equal([['Daemon crashed, stopping', 'boom']]);
      expect(await fs.pathExists(statePath(tempDir))).to.equal(false);
      expect(kills.filter(([, signal]) => signal === 'SIGTERM').map(([pid]) => pid)).to.include.members([-1000, -1001]);
    });
  });

  describe('wallpaper dim while music plays', () => {
    let daemon, visualizers;
    beforeEach(async () => {
      visualizers = {
        override: null, active: true, error: null, musicDim: 0,
        configure: async () => {}, sync: async () => {}, stop: async () => {}, restack: () => {}, reload: async () => {},
        describe: () => [], summary: () => ({ enabled: true, musicDim: visualizers.musicDim })
      };
      daemon = makeDaemon({ visualizers });
      await daemon.start();
    });
    afterEach(async () => { await daemon.stop(); });

    const load = async filePath => {
      clients[0].client.emit('property-change', { event: 'property-change', name: 'path', data: filePath });
      await tick();
    };

    it('shows the stronger of the item\'s dim and the music dim, and restores the item\'s own (read again) after', async () => {
      const id = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', dim: 10 });
      const { client } = clients[0];
      await load('/m/a.png');
      expect(client.properties.contrast).to.equal(-10);

      visualizers.musicDim = 30;
      await daemon.applyDims();
      expect(client.properties.contrast).to.equal(-30);
      // A load while music plays starts dimmed
      await load('/m/a.png');
      expect(client.properties.contrast).to.equal(-30);
      expect((await readState(tempDir)).visualizer.musicDim).to.equal(30);

      // `backdrop dim` stored a stronger dim meanwhile: it wins, and stays after the music
      db.setDim(id, 50);
      await daemon.applyDims();
      expect(client.properties.contrast).to.equal(-50);
      db.setDim(id, 5);
      visualizers.musicDim = 0;
      await daemon.applyDims();
      expect(client.properties.contrast).to.equal(-5);
    });

    it('observes mpv\'s contrast', async () => {
      expect(clients[0].client.commands).to.deep.include(['observe_property', 3, 'contrast']);
    });
  });

  describe('visualizer colors from the wallpaper', () => {
    let daemon, sampled, recolored, wants, release, overlays;
    const instance = { name: 'main', pipe: { fg: '#000000ff' }, palette: { source: 'wallpaper', pick: 'vivid', minContrast: 1 } };
    // A sample whose top half is green and bottom half red
    const sample = () => {
      const pixels = Buffer.alloc(4 * 4 * 3);
      for (let index = 0; index < 16; index++) pixels.set(index < 8 ? [0, 200, 0] : [200, 0, 0], index * 3);
      return { width: 4, height: 4, pixels, dim: 0 };
    };
    const load = async filePath => {
      daemon.screens.get('DP-1').client.emit('property-change', { event: 'property-change', name: 'path', data: filePath });
      await new Promise(resolve => setTimeout(resolve, 5));
    };

    beforeEach(async () => {
      sampled = []; recolored = []; wants = true; release = null; overlays = [];
      const visualizers = {
        override: null, active: true, error: null,
        configure: async () => {}, sync: async () => {}, stop: async () => {}, restack: () => {}, reload: async () => {},
        describe: () => [], summary: () => ({ enabled: true }),
        overlaysOn: name => (name === 'DP-1' ? overlays : []),
        wantsWallpaperColors: () => wants,
        recolor: async name => { recolored.push(name); }
      };
      daemon = makeDaemon({
        visualizers,
        samplePalette: async (media, monitor) => {
          sampled.push([media.path, monitor.name]);
          if (release) await release;
          return sample();
        }
      });
      await daemon.start();
    });
    afterEach(async () => { await daemon.stop(); });

    it('gives a sleeve instance the colors behind its lyrics area, not its whole window', async () => {
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 2560, height: 1440 });
      const monitor = daemon.monitors.get('DP-1');
      const whole = { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
      const bottom = { ...whole, y: monitor.y + monitor.height * 3 / 4, height: monitor.height / 4 };
      await load('/m/a.png');
      await daemon.sampling.get('DP-1')?.done;
      const sleeve = lyricsArea => ({ engine: 'sleeve', sleeve: { lyricsArea } });

      expect(daemon.colorsFor(monitor, sleeve(null), whole)).to.deep.equal(daemon.wallpaperColors.overlayColors(monitor, whole));
      const area = daemon.colorsFor(monitor, sleeve('100%x25%+0+75%'), whole);
      expect(area).to.deep.equal(daemon.wallpaperColors.overlayColors(monitor, bottom));
      expect(area).to.not.deep.equal(daemon.colorsFor(monitor, sleeve(null), whole));
    });

    it('samples each load once and answers with the colors under the instance', async () => {
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 2560, height: 1440 });
      const monitor = daemon.monitors.get('DP-1');
      const bottom = { x: monitor.x, y: monitor.y + monitor.height * 3 / 4, width: monitor.width, height: monitor.height / 4 };
      // Nothing playing yet: the configured colors
      expect(daemon.colorsFor(monitor, instance, bottom)).to.equal(null);

      await load('/m/a.png');
      await daemon.sampling.get('DP-1')?.done;
      expect(sampled).to.deep.equal([['/m/a.png', 'DP-1']]);
      expect(recolored).to.deep.equal(['DP-1']);
      expect(daemon.colorsFor(monitor, instance, bottom)).to.deep.equal({ fg: '#c80000ff' });
      expect(daemon.colorsFor(monitor, instance, { ...bottom, y: monitor.y })).to.deep.equal({ fg: '#00c800ff' });
      // Asking again does not decode again
      expect(sampled).to.have.length(1);
    });

    it('samples on demand when an instance asks before the load sampled, and drops a sample a newer load replaced', async () => {
      wants = false;
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 2560, height: 1440 });
      db.addMedia({ kind: 'image', source: 'local', source_id: 2, path: '/m/b.png', width: 2560, height: 1440 });
      await load('/m/a.png');
      expect(sampled).to.deep.equal([]);

      // The visualizer turned on later: its first request starts the sampling
      let finish;
      release = new Promise(resolve => { finish = resolve; });
      const monitor = daemon.monitors.get('DP-1');
      expect(daemon.colorsFor(monitor, instance, monitor)).to.equal(null);
      expect(sampled).to.deep.equal([['/m/a.png', 'DP-1']]);
      const first = daemon.sampling.get('DP-1').done;
      await load('/m/b.png');
      finish();
      await first;
      expect(daemon.samples.has('DP-1')).to.equal(false);
      expect(recolored).to.deep.equal([]);
    });

    it('recolors when mpv\'s contrast changes, checking contrast against what shows now', async () => {
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 2560, height: 1440 });
      await load('/m/a.png');
      await daemon.sampling.get('DP-1')?.done;
      recolored.length = 0;
      const monitor = daemon.monitors.get('DP-1');
      const strict = { ...instance, palette: { ...instance.palette, minContrast: 5 } };
      // Against the undimmed wallpaper the pick is lightened for contrast
      expect(daemon.colorsFor(monitor, strict, monitor)).to.deep.equal({ fg: '#95ff95ff' });
      const { client } = daemon.screens.get('DP-1');
      client.emit('property-change', { event: 'property-change', name: 'contrast', data: -60 });
      client.emit('property-change', { event: 'property-change', name: 'contrast', data: -60 });
      await tick();
      expect(recolored).to.deep.equal(['DP-1']);
      expect(daemon.screens.get('DP-1').contrast).to.equal(-60);
      // Dimmed by 60 the wallpaper is dark enough for the plain green
      expect(daemon.colorsFor(monitor, strict, monitor)).to.deep.equal({ fg: '#00c800ff' });
    });

    it('writes the overlays to the state with what the wallpaper shows behind them, again when the dim changes', async () => {
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 2560, height: 1440 });
      const monitor = daemon.monitors.get('DP-1');
      const bottom = { x: monitor.x, y: monitor.y + monitor.height / 2, width: monitor.width, height: monitor.height / 2 };
      overlays = [{ window: 0x5000001, name: 'sleeve', position: 'below', geometry: bottom }];
      const geometry = `${bottom.width}x${bottom.height}+${bottom.x}+${bottom.y}`;
      // Not sampled yet: no colors, and asking starts the sampling
      await daemon.writeState();
      expect((await readState(tempDir)).monitors[0].overlays).to.deep.equal([{ window: 0x5000001, name: 'sleeve', position: 'below', geometry, colors: null }]);

      await load('/m/a.png');
      await daemon.sampling.get('DP-1')?.done;
      expect((await readState(tempDir)).monitors[0].overlays[0].colors).to.deep.equal({
        background: '#c80000', main: [{ color: '#c80000', share: 1 }]
      });

      daemon.screens.get('DP-1').client.emit('property-change', { event: 'property-change', name: 'contrast', data: -100 });
      await new Promise(resolve => setTimeout(resolve, 20));
      // Dimmed all the way the red shows as black; the main colors are the wallpaper's own
      expect((await readState(tempDir)).monitors[0].overlays[0].colors).to.deep.equal({
        background: '#000000', main: [{ color: '#c80000', share: 1 }]
      });
    });

    it('logs a failed sample and keeps the configured colors', async () => {
      const warnings = [];
      await daemon.stop();
      daemon = makeDaemon({
        visualizers: { ...daemon.visualizers, wantsWallpaperColors: () => true, recolor: async () => {} },
        samplePalette: async () => { throw new Error('ffmpeg missing'); },
        logger: { ...silentLogger, warn: (message, meta) => warnings.push([message, meta.error]) }
      });
      await daemon.start();
      db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/a.png', width: 2560, height: 1440 });
      await load('/m/a.png');
      await daemon.sampling.get('DP-1')?.done;
      expect(warnings).to.deep.include(['Sampling the wallpaper for visualizer colors failed', 'ffmpeg missing']);
      expect(daemon.colorsFor(daemon.monitors.get('DP-1'), instance, daemon.monitors.get('DP-1'))).to.equal(null);
    });
  });
});
