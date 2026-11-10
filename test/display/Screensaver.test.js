import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { Screensaver, restoreDesktop, I3_MODE } from '../../src/display/daemon/Screensaver.js';
import { screensaverPath } from '../../src/display/runtimeFiles.js';

describe('Screensaver', () => {
  let runtimeDir, calls, daemon, saver, settings, idleMs, loadValue, failing, watchers;

  const workspaces = [{ name: '3', focused: true, visible: true, output: 'DP-3' }, { name: '7', focused: false, visible: true, output: 'HDMI-1' }];
  const outputs = [{ name: 'DP-3', active: true }, { name: 'HDMI-1', active: true }, { name: 'xroot-0', active: false }];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (failing?.(file, args)) throw new Error('failed');
    if (args[1] === 'get_workspaces') return JSON.stringify(workspaces);
    if (args[1] === 'get_outputs') return JSON.stringify(outputs);
    if (file === 'xprintidle') return String(idleMs);
    return '';
  };
  const visualizers = () => {
    const made = {
      presetOverride: undefined, active: true, changes: [],
      setPreset: async name => { made.changes.push(['preset', name]); made.presetOverride = name; },
      setEnabled: async on => { made.changes.push(['enabled', on]); made.active = on; }
    };
    return made;
  };
  const i3 = () => calls.filter(([file]) => file === 'i3-msg').map(([, ...args]) => args.join(' '));
  const hooks = () => calls.filter(([file]) => file === 'sh').map(call => call[2]);

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-saver-'));
    calls = [];
    failing = null;
    idleMs = 0;
    loadValue = 0;
    settings = { idle: false, idle_minutes: 10, max_load: null, preset: 'screensaver', workspace: 'backdrop', on_enter: ['hide'], on_leave: ['show'] };
    daemon = {
      runtimeDir, exec, stopping: false, now: () => 1000, visualizers: visualizers(),
      config: { get: () => ({ screensaver: settings }) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      load: { off: false, governor: { read: () => loadValue } },
      enqueue: task => task(), screens: new Map()
    };
    watchers = [];
    const watchTracks = options => {
      const watcher = { options, running: false, start() { this.running = true; }, stop() { this.running = false; } };
      watchers.push(watcher);
      return watcher;
    };
    saver = new Screensaver(daemon, { watchTracks });
  });

  afterEach(() => fs.remove(runtimeDir));

  it('shows an empty workspace per output, the focused one last, then the mode, the hook and the preset', async () => {
    await saver.apply('toggle');
    expect(i3()[2]).to.equal('focus output "HDMI-1"; workspace --no-auto-back-and-forth "backdrop-HDMI-1"; focus output "DP-3"; workspace --no-auto-back-and-forth "backdrop"');
    expect(i3()).to.include(`mode ${I3_MODE}`);
    expect(hooks()).to.deep.equal(['hide']);
    expect(daemon.visualizers.changes).to.deep.equal([['preset', 'screensaver']]);
    expect(saver.summary()).to.deep.equal({ active: true, trigger: 'key', since: 1000 });
  });

  it('puts everything back on leaving, focus on the workspace that had it', async () => {
    daemon.visualizers.presetOverride = 'party';
    await saver.apply('on');
    calls = [];
    await saver.apply('toggle');
    expect(i3()).to.deep.equal(['mode default', 'workspace --no-auto-back-and-forth "7"; workspace --no-auto-back-and-forth "3"']);
    expect(hooks()).to.deep.equal(['show']);
    expect(daemon.visualizers.changes.at(-1)).to.deep.equal(['preset', 'party']);
    expect(saver.summary()).to.deep.equal({ active: false });
    expect(await fs.pathExists(screensaverPath(runtimeDir))).to.equal(false);
  });

  it('on twice and off twice change nothing more', async () => {
    await saver.apply('off');
    expect(calls).to.have.length(0);
    await saver.apply('on');
    const entered = calls.length;
    await saver.apply('on');
    expect(calls).to.have.length(entered);
  });

  it('turns a visualizer that was off on for the time, and off again', async () => {
    daemon.visualizers.active = false;
    await saver.enter('key');
    expect(daemon.visualizers.changes[0]).to.deep.equal(['enabled', true]);
    await saver.leave();
    expect(daemon.visualizers.changes.at(-1)).to.deep.equal(['enabled', false]);
  });

  it('keeps the running preset with preset null', async () => {
    settings.preset = null;
    await saver.enter('key');
    await saver.leave();
    expect(daemon.visualizers.changes).to.deep.equal([]);
  });

  it('still works without i3, and a failing hook stops nothing', async () => {
    failing = file => file === 'i3-msg' || file === 'sh';
    await saver.enter('key');
    expect(saver.summary().active).to.equal(true);
    expect(daemon.visualizers.changes).to.deep.equal([['preset', 'screensaver']]);
    await saver.leave();
    expect(saver.summary().active).to.equal(false);
  });

  it('leaves the visualizers alone when the daemon is stopping', async () => {
    await saver.enter('key');
    daemon.visualizers.changes = [];
    daemon.stopping = true;
    await saver.leave();
    expect(daemon.visualizers.changes).to.deep.equal([]);
    expect(i3()).to.include('mode default');
  });

  describe('recovering', () => {
    it('puts the desktop back from the record of a daemon that is gone', async () => {
      await saver.enter('key');
      calls = [];
      expect(await restoreDesktop(runtimeDir, { run: exec })).to.equal(true);
      expect(i3()[0]).to.equal('mode default');
      expect(hooks()).to.deep.equal(['show']);
      expect(await restoreDesktop(runtimeDir, { run: exec })).to.equal(false);
    });

    it('does so when the next daemon starts', async () => {
      await saver.enter('key');
      calls = [];
      await new Screensaver(daemon).begin();
      expect(i3()[0]).to.equal('mode default');
    });
  });

  describe('going idle', () => {
    beforeEach(() => { settings.idle = true; });

    it('starts after idle_minutes, not before', async () => {
      idleMs = 599_000;
      await saver.checkIdle();
      expect(saver.summary().active).to.equal(false);
      idleMs = 600_000;
      await saver.checkIdle();
      expect(saver.summary()).to.include({ active: true, trigger: 'idle' });
    });

    it('is off by default', async () => {
      settings.idle = false;
      idleMs = 10_000_000;
      await saver.checkIdle();
      expect(calls).to.have.length(0);
    });

    it('waits for the load to be under max_load, and never starts with everything off for load', async () => {
      idleMs = 600_000;
      settings.max_load = 4;
      loadValue = 5;
      await saver.checkIdle();
      expect(saver.summary().active).to.equal(false);
      loadValue = 3;
      daemon.load.off = true;
      await saver.checkIdle();
      expect(saver.summary().active).to.equal(false);
      daemon.load.off = false;
      await saver.checkIdle();
      expect(saver.summary().active).to.equal(true);
    });

    it('does nothing without xprintidle', async () => {
      failing = file => file === 'xprintidle';
      await saver.checkIdle();
      expect(saver.summary().active).to.equal(false);
    });
  });

  describe('a new song', () => {
    const screen = name => ({ monitor: { name }, client: { commands: [], command: async function (...args) { this.commands.push(args); } } });

    beforeEach(() => {
      daemon.screens = new Map([['DP-3', screen('DP-3')], ['HDMI-1', screen('HDMI-1')]]);
    });

    const nexts = () => [...daemon.screens.values()].map(({ client }) => client.commands);
    const song = { player: 'spotify', artist: 'A', title: 'Two' };

    it('moves every monitor to its next item while the screensaver runs, following songs only then', async () => {
      await saver.apply('on');
      expect(watchers).to.have.length(1);
      expect(watchers[0].running).to.equal(true);
      await watchers[0].options.onTrack(song);
      expect(nexts()).to.deep.equal([[['playlist-next', 'force']], [['playlist-next', 'force']]]);
      await saver.apply('off');
      expect(watchers[0].running).to.equal(false);
      // A song reported after leaving changes nothing
      await watchers[0].options.onTrack(song);
      expect(nexts()[0]).to.have.length(1);
    });

    it('does nothing with next_on_song off, read on each song', async () => {
      settings.next_on_song = false;
      await saver.apply('on');
      await watchers[0].options.onTrack(song);
      expect(nexts()).to.deep.equal([[], []]);
      settings.next_on_song = true;
      await watchers[0].options.onTrack(song);
      expect(nexts()[0]).to.have.length(1);
    });

    it('still changes the other monitors when one fails', async () => {
      daemon.screens.get('DP-3').client.command = async () => { throw new Error('gone'); };
      await saver.apply('on');
      await watchers[0].options.onTrack(song);
      expect(nexts()[1]).to.have.length(1);
    });
  });

  describe('a song without lyrics', () => {
    let followers;
    const follower = options => {
      const made = { options, running: false, start() { this.running = true; }, stop() { this.running = false; } };
      followers.push(made);
      return made;
    };
    const lyricsMessage = (lines, loading = false) => ({ type: 'lyrics', key: 'spotify:1', loading, result: lines === null ? null : { best: lines.length ? { lyrics: { lines } } : null } });

    beforeEach(() => {
      followers = [];
      settings.preset_without_lyrics = 'screensaver-instrumental';
      saver = new Screensaver(daemon, { watchTracks: () => ({ start() {}, stop() {} }), followLyrics: follower, lyricsWait: 30 });
    });

    it('starts with the look for the song playing when sleeved says in time, and switches as lyrics come and go', async () => {
      const entering = saver.apply('on');
      while (!followers.length) await new Promise(resolve => setImmediate(resolve));
      followers[0].options.onMessage(lyricsMessage([]));
      await entering;
      expect(daemon.visualizers.changes).to.deep.equal([['preset', 'screensaver-instrumental']]);

      // A lookup still out changes nothing; lyrics found switch to the lyrics look
      await followers[0].options.onMessage(lyricsMessage(null, true));
      await followers[0].options.onMessage(lyricsMessage([{ time: 0, text: 'la' }]));
      expect(daemon.visualizers.changes.at(-1)).to.deep.equal(['preset', 'screensaver']);
      // The same again changes nothing
      const count = daemon.visualizers.changes.length;
      await followers[0].options.onMessage(lyricsMessage([{ time: 0, text: 'la' }]));
      expect(daemon.visualizers.changes).to.have.length(count);

      // sleeved going away counts as no lyrics
      await followers[0].options.onClose();
      expect(daemon.visualizers.changes.at(-1)).to.deep.equal(['preset', 'screensaver-instrumental']);

      await saver.apply('off');
      expect(followers[0].running).to.equal(false);
      expect(daemon.visualizers.changes.at(-1)).to.deep.equal(['preset', undefined]);
    });

    it('starts with preset when sleeved says nothing in time, and follows nothing without preset_without_lyrics', async () => {
      await saver.apply('on');
      expect(daemon.visualizers.changes).to.deep.equal([['preset', 'screensaver']]);
      await saver.apply('off');

      settings.preset_without_lyrics = null;
      followers.length = 0;
      await saver.apply('on');
      expect(followers).to.have.length(0);
    });
  });
});
