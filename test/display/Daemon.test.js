import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Daemon, buildCommand, readState, statePath, isProcessRunning } from '../../src/display/Daemon.js';
import { lastMediaKey, setMode } from '../../src/display/Playlist.js';
import { FakeMpvClient, FakeChild, makeConfig, silentLogger, LISTMONITORS_TWO } from '../helpers/fakes.js';

// Above Linux's maximum pid_max, so it can never be a live process
const DEAD_PID = 4194305;

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Daemon', () => {
  let tempDir;
  let db;
  let config;
  let spawned;
  let clients;
  let kills;
  let connectError;
  let purges;

  function makeDaemon(overrides = {}) {
    return new Daemon({
      config,
      database: db,
      logger: silentLogger,
      exec: async () => LISTMONITORS_TWO,
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
      purgeInterval: 0,
      ...overrides
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-daemon-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'paths.runtime': tempDir, 'display.mpv_args': ['--vo=gpu'] });
    spawned = [];
    clients = [];
    kills = [];
    connectError = null;
    purges = 0;
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
            calls.push({ dirs, resolution: options.resolution, stopping: options.shouldStop() });
            return { imported: [fits] };
          }
        }
      });

      await daemon.start();
      await daemon.importing;

      expect(calls).to.deep.equal([{ dirs: ['/walls'], resolution: '2560x1440', stopping: false }]);
      const appended = clients.map(c => c.client.commands.filter(cmd => cmd[0] === 'loadfile'));
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

    it('remembers images without touching speed', async () => {
      const id = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/i.png' });
      await load(0, '/m/i.png');

      expect(clients[0].client.properties).to.not.have.property('speed');
      expect(db.getSetting(lastMediaKey('image', 'DP-1'))).to.equal(id);
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
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(spawned).to.have.length(3);
      expect(spawned[2].args).to.include('2560x1440+0+0');
      expect(clients[0].client.closed).to.be.true;
      await daemon.stop();
    });

    it('gives up after repeated exits within a minute', async () => {
      const daemon = makeDaemon();
      await daemon.start();

      for (let i = 0; i < 6; i++) {
        spawned[spawned.length - 1].child.exit(1);
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // 2 initial launches; the second monitor restarts 5 times, then stops
      expect(spawned).to.have.length(2 + 5);
      await daemon.stop();
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
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(spawned).to.have.length(3);
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
});
