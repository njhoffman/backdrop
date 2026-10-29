import { expect } from 'chai';
import { EventEmitter } from 'events';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MenuCommand, rofiMenu } from '../../src/commands/MenuCommand.js';
import { notifications } from '../helpers/setup.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('MenuCommand', () => {
  const monitors = [{ name: 'DP-1', width: 1920, height: 1080 }, { name: 'HDMI-1', width: 1920, height: 1080 }];
  let db, display, rating, shown, picks, command, playing;

  beforeEach(() => {
    db = new DatabaseManager(); db.initialize(':memory:');
    const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/ocean-waves.mp4', original_name: 'ocean-waves.mp4',
      width: 3840, height: 2160, duration: 18, fps: 25, speed: 0.8 });
    db.addRating(id, 2, '1920x1080');
    playing = { media: db.getMedia(id), rating: db.getLatestRating(id) };
    const control = {
      targetMonitor: sinon.stub().callsFake(async name => monitors.find(m => m.name === name) ?? monitors[0]),
      current: sinon.stub().callsFake(async name => ({ monitor: monitors.find(m => m.name === name), path: playing.media?.path ?? null, ...playing })),
      state: sinon.stub().resolves({ monitors })
    };
    display = { control, next: sinon.stub().resolves(), prev: sinon.stub().resolves(), mode: sinon.stub().resolves(),
      speed: sinon.stub().resolves(), dim: sinon.stub().resolves() };
    rating = { keep: sinon.stub().resolves(), skip: sinon.stub().resolves(), undo: sinon.stub().resolves(), goNext: sinon.stub().resolves() };
    shown = [];
    picks = [];
    // Picks entries by label in order; null dismisses the menu, running out of picks too
    const runMenu = async (entries, options) => {
      shown.push({ entries, ...options });
      const label = picks.shift() ?? null;
      if (label === null) return null;
      const index = entries.indexOf(label);
      if (index === -1) throw new Error(`no entry ${label} in ${entries.join(', ')}`);
      return index;
    };
    command = new MenuCommand(makeConfig(), db, silentLogger, { display, rating, runMenu });
    notifications.length = 0;
  });
  afterEach(() => db.close());

  it('shows the playing item and runs the picked action once for the monitor under the pointer', async () => {
    picks = ['keep 3 and next'];
    await command.open();
    expect(shown).to.have.length(1);
    expect(shown[0].entries).to.deep.equal(['keep 1', 'keep 2', 'keep 3', 'keep 3 and next', 'skip', 'undo', 'next',
      'next (random)', 'prev', 'go-next', 'speed ▸', 'dim ▸', 'mode: switch to images', 'monitor: DP-1 ▸']);
    expect(shown[0].message).to.equal(`#${playing.media.id}  video  3840x2160\n0:18 · 25 fps · ★★☆ · DP-1\nocean, waves\nspeed 0.8`);
    expect(rating.keep.calledOnceWithExactly(3, { monitor: 'DP-1', next: true })).to.be.true;
  });

  it('offers only what applies: no rating, speed or dim with nothing playing, no speed for images', async () => {
    playing = { media: null, rating: null };
    await command.open();
    expect(shown[0].entries).to.deep.equal(['undo', 'next', 'next (random)', 'prev', 'mode: switch to images', 'monitor: DP-1 ▸']);
    expect(shown[0].message).to.equal('DP-1: nothing from the library playing');

    const image = db.addMedia({ kind: 'image', source: 'local', source_id: 2, path: '/m/i.png', width: 1920, height: 1080 });
    playing = { media: db.getMedia(image), rating: null };
    await command.open();
    expect(shown[1].entries).to.include('dim ▸').and.not.include('speed ▸');
  });

  it('keeps the speed submenu open for repeated steps, then closes', async () => {
    picks = ['speed ▸', '0.75', '+0.1', null];
    await command.open();
    expect(display.speed.args).to.deep.equal([['0.75', { monitor: 'DP-1' }], ['+0.1', { monitor: 'DP-1' }]]);
    expect(shown.map(menu => menu.prompt)).to.deep.equal(['backdrop', 'speed (now 0.8)', 'speed (now 0.8)', 'speed (now 0.8)']);
  });

  it('retargets another monitor and, with --stay, reopens after each action until dismissed', async () => {
    picks = ['monitor: DP-1 ▸', 'HDMI-1', 'next', 'prev', null];
    await command.open({ stay: true });
    expect(display.next.calledOnceWithExactly({ monitor: 'HDMI-1', random: false })).to.be.true;
    expect(display.prev.calledOnceWithExactly({ monitor: 'HDMI-1' })).to.be.true;
    expect(shown.at(-1).entries).to.include('monitor: HDMI-1 ▸');
  });

  it('switches to the other mode and does not list a monitor entry with one monitor', async () => {
    display.control.state.resolves({ monitors: [monitors[0]] });
    picks = ['mode: switch to images'];
    await command.open();
    expect(display.mode.calledOnceWithExactly('image', { monitor: 'DP-1' })).to.be.true;
    expect(shown[0].entries.some(entry => entry.startsWith('monitor'))).to.be.false;
  });

  it('sends errors as critical notifications, failing the command, or staying open with --stay', async () => {
    rating.undo.rejects(new Error('nothing <restorable>'));
    picks = ['undo'];
    let caught;
    try { await command.open(); } catch (error) { caught = error; }
    expect(caught.message).to.equal('nothing <restorable>');
    expect(notifications[0]).to.include('--urgency=critical').and.include('nothing &lt;restorable&gt;');

    picks = ['undo', 'next', null];
    await command.open({ stay: true });
    expect(notifications).to.have.length(2);
    expect(display.next.calledOnce).to.be.true;
  });

  describe('rofiMenu', () => {
    function fakeSpawn(code, output = '', error = null) {
      const calls = [];
      const spawn = (file, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        let input = '';
        child.stdin = { end: text => { input = text; } };
        calls.push({ file, args, input: () => input });
        setImmediate(() => {
          if (error) { child.emit('error', error); return; }
          if (output) child.stdout.emit('data', output);
          child.emit('close', code);
        });
        return child;
      };
      return { spawn, calls };
    }

    it('passes entries on stdin and returns the picked index', async () => {
      const { spawn, calls } = fakeSpawn(0, '2\n');
      const picked = await rofiMenu(['-theme', 'x.rasi'], spawn)(['a', 'b', 'c'], { prompt: 'backdrop', message: 'msg' });
      expect(picked).to.equal(2);
      expect(calls[0].file).to.equal('rofi');
      expect(calls[0].args).to.deep.equal(['-dmenu', '-i', '-no-custom', '-format', 'i', '-p', 'backdrop', '-mesg', 'msg', '-theme', 'x.rasi']);
      expect(calls[0].input()).to.equal('a\nb\nc\n');
    });

    it('returns null when dismissed and fails when rofi is missing or errors', async () => {
      expect(await rofiMenu([], fakeSpawn(1).spawn)(['a'], { prompt: 'p' })).to.be.null;
      let caught;
      try { await rofiMenu([], fakeSpawn(0, '', Object.assign(new Error('spawn'), { code: 'ENOENT' })).spawn)(['a'], { prompt: 'p' }); } catch (error) { caught = error; }
      expect(caught.message).to.equal('rofi is not installed');
      caught = null;
      try { await rofiMenu([], fakeSpawn(65).spawn)(['a'], { prompt: 'p' }); } catch (error) { caught = error; }
      expect(caught.message).to.equal('rofi exited with code 65');
    });
  });
});
