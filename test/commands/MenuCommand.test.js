import { expect } from 'chai';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MenuCommand, minimalView, panelView, PANEL_THEME } from '../../src/commands/MenuCommand.js';
import { thumbnailFor } from '../../src/library/thumbnail.js';
import { notifications } from '../helpers/setup.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('MenuCommand', () => {
  const monitors = [{ name: 'DP-1', width: 1920, height: 1080 }, { name: 'HDMI-1', width: 1920, height: 1080 }];
  let db, config, display, rating, shown, picks, command, playing, thumbnail;

  beforeEach(() => {
    db = new DatabaseManager(); db.initialize(':memory:');
    const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/local-1.mp4', original_name: 'ocean-waves.mp4',
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
    const view = async menu => {
      shown.push(menu);
      const label = picks.shift() ?? null;
      if (label === null) return null;
      const index = menu.entries.findIndex(entry => entry.label === label);
      if (index === -1) throw new Error(`no entry ${label} in ${menu.entries.map(entry => entry.label).join(', ')}`);
      return index;
    };
    thumbnail = sinon.stub().resolves('/cache/thumbnails/1.jpg');
    config = makeConfig();
    command = new MenuCommand(config, db, silentLogger, { display, rating, view, thumbnail });
    notifications.length = 0;
  });
  afterEach(() => db.close());

  const labels = menu => menu.entries.map(entry => entry.label);

  it('shows the item with its file name and preview, and keeps always advance to the next item', async () => {
    picks = ['keep 3'];
    await command.open();
    expect(shown).to.have.length(1);
    expect(labels(shown[0])).to.deep.equal(['keep 1', 'keep 2', 'keep 3', 'skip', 'undo', 'prev', 'next',
      'next (random)', 'go-next', 'speed ▸', 'dim ▸', 'mode: switch to images', 'monitor: DP-1 ▸']);
    expect(shown[0].entries.every(entry => entry.icon)).to.be.true;
    expect(shown[0]).to.include({ title: 'ocean-waves.mp4', preview: '/cache/thumbnails/1.jpg' });
    expect(shown[0].message).to.equal(`#${playing.media.id}  video  3840x2160\n0:18 · 25 fps · ★★☆ · DP-1\nocean, waves\nspeed 0.8`);
    // The current rating (2) is highlighted
    expect(shown[0].active).to.deep.equal([1]);
    expect(rating.keep.calledOnceWithExactly(3, { monitor: 'DP-1', next: true })).to.be.true;
  });

  it('offers only what applies: no rating, speed or dim with nothing playing, no speed for images', async () => {
    playing = { media: null, rating: null };
    await command.open();
    expect(labels(shown[0])).to.deep.equal(['undo', 'prev', 'next', 'next (random)', 'mode: switch to images', 'monitor: DP-1 ▸']);
    expect(shown[0].message).to.equal('DP-1: nothing from the library playing');

    const image = db.addMedia({ kind: 'image', source: 'pexels', source_id: 2, path: '/m/remote-2.jpg', width: 1920, height: 1080 });
    playing = { media: db.getMedia(image), rating: null };
    await command.open();
    expect(labels(shown[1])).to.include('dim ▸').and.not.include('speed ▸');
    expect(shown[1].title).to.equal('remote-2.jpg');
    expect(shown[1].active).to.deep.equal([]);
  });

  it('keeps the speed submenu open for repeated steps, highlighting the current value, then closes', async () => {
    db.setSpeed(playing.media.id, 1);
    playing.media = db.getMedia(playing.media.id);
    picks = ['speed ▸', '0.75', '+0.1', null];
    await command.open();
    expect(display.speed.args).to.deep.equal([['0.75', { monitor: 'DP-1' }], ['+0.1', { monitor: 'DP-1' }]]);
    expect(shown.slice(1).map(menu => menu.prompt)).to.deep.equal(['speed (now 1)', 'speed (now 1)', 'speed (now 1)']);
    expect(shown[1]).to.include({ columns: 7 });
    expect(shown[1].active).to.deep.equal([2]);
  });

  it('retargets another monitor and, with --stay, reopens after each action until dismissed', async () => {
    picks = ['monitor: DP-1 ▸', 'HDMI-1', 'next', 'prev', null];
    await command.open({ stay: true });
    expect(shown[1].active).to.deep.equal([0]);
    expect(display.next.calledOnceWithExactly({ monitor: 'HDMI-1', random: false })).to.be.true;
    expect(display.prev.calledOnceWithExactly({ monitor: 'HDMI-1' })).to.be.true;
    expect(labels(shown.at(-1))).to.include('monitor: HDMI-1 ▸');
  });

  it('switches to the other mode and does not list a monitor entry with one monitor', async () => {
    display.control.state.resolves({ monitors: [monitors[0]] });
    picks = ['mode: switch to images'];
    await command.open();
    expect(display.mode.calledOnceWithExactly('image', { monitor: 'DP-1' })).to.be.true;
    expect(labels(shown[0]).some(label => label.startsWith('monitor'))).to.be.false;
  });

  it('makes no thumbnail for the minimal style and rejects an unknown style', async () => {
    await command.open({ style: 'minimal' });
    expect(thumbnail.called).to.be.false;
    expect(shown[0].preview).to.be.null;
    config.set('menu.style', 'fancy');
    let caught;
    try { await command.open(); } catch (error) { caught = error; }
    expect(caught.message).to.equal('menu.style must be panel or minimal, not fancy');
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

  describe('views', () => {
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
    const menu = {
      prompt: 'backdrop', title: 'a "b".mp4', message: 'msg', preview: '/t/1 "x".jpg', active: [1],
      entries: [{ icon: 'I', label: 'keep 1' }, { icon: 'J', label: 'next (random)', caption: 'random' }, { label: 'a|b <c>' }]
    };

    it('minimal: one line per entry with its icon, returning the picked index', async () => {
      const { spawn, calls } = fakeSpawn(0, '1\n');
      expect(await minimalView(['-theme', 'x.rasi'], spawn)(menu)).to.equal(1);
      expect(calls[0].file).to.equal('rofi');
      expect(calls[0].args).to.deep.equal(['-dmenu', '-i', '-no-custom', '-format', 'i', '-p', 'backdrop', '-mesg', 'msg', '-a', '1', '-theme', 'x.rasi']);
      expect(calls[0].input()).to.equal('I  keep 1\nJ  next (random)\na|b <c>\n');
    });

    it('panel: buttons with an icon over a caption, sized grid, title and preview image', async () => {
      const { spawn, calls } = fakeSpawn(0, '0\n');
      expect(await panelView([], spawn)(menu)).to.equal(0);
      const { args } = calls[0];
      expect(args).to.include.members(['-markup-rows', '-theme', PANEL_THEME, '-p', 'a "b".mp4', '-mesg', 'msg', '-a', '1']);
      expect(args[args.indexOf('-sep') + 1]).to.equal('|');
      expect(args).to.include('listview { columns: 3; lines: 1; }');
      const grid = async count => {
        const fake = fakeSpawn(0, '0\n');
        await panelView([], fake.spawn)({ ...menu, entries: Array.from({ length: count }, (_, i) => ({ label: String(i) })) });
        return fake.calls[0].args.find(arg => arg.startsWith('listview'));
      };
      expect(await grid(13)).to.equal('listview { columns: 7; lines: 2; }');
      expect(await grid(12)).to.equal('listview { columns: 6; lines: 2; }');
      expect(await grid(6)).to.equal('listview { columns: 6; lines: 1; }');
      expect(args).to.include('preview { background-image: url("/t/1 \\"x\\".jpg", width); }');
      expect(calls[0].input()).to.equal('<span font_size="x-large">I</span>\nkeep 1|<span font_size="x-large">J</span>\nrandom|'
        + '<span font_size="x-large"> </span>\na¦b &lt;c&gt;');
      expect(await fs.pathExists(PANEL_THEME)).to.be.true;
    });

    it('returns null when dismissed and fails when rofi is missing or errors', async () => {
      expect(await minimalView([], fakeSpawn(1).spawn)(menu)).to.be.null;
      let caught;
      try { await panelView([], fakeSpawn(0, '', Object.assign(new Error('spawn'), { code: 'ENOENT' })).spawn)(menu); } catch (error) { caught = error; }
      expect(caught.message).to.equal('rofi is not installed');
      caught = null;
      try { await minimalView([], fakeSpawn(65).spawn)(menu); } catch (error) { caught = error; }
      expect(caught.message).to.equal('rofi exited with code 65');
    });
  });

  describe('thumbnailFor', () => {
    let dir;
    beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-thumb-')); });
    afterEach(async () => { await fs.remove(dir); });

    it('extracts a frame once per file version and caches it', async () => {
      const file = path.join(dir, 'v.mp4');
      await fs.outputFile(file, 'video');
      const exec = sinon.stub().callsFake(async (cmd, args) => fs.outputFile(args.at(-1), 'jpg'));
      const media = { id: 7, kind: 'video', path: file, duration: 18 };
      const thumbs = path.join(dir, 'thumbs');
      expect(await thumbnailFor(media, thumbs, { exec })).to.equal(path.join(thumbs, '7.jpg'));
      expect(exec.firstCall.args[1].slice(3, 9)).to.deep.equal(['-ss', '1', '-i', file, '-frames:v', '1']);
      await thumbnailFor(media, thumbs, { exec });
      expect(exec.calledOnce).to.be.true;
      // A replaced file (download --upgrade) gets a new thumbnail
      const later = new Date(Date.now() + 5000);
      await fs.utimes(file, later, later);
      await thumbnailFor(media, thumbs, { exec });
      expect(exec.calledTwice).to.be.true;
    });

    it('scales images without seeking and returns null when ffmpeg fails', async () => {
      const file = path.join(dir, 'i.png');
      await fs.outputFile(file, 'png');
      const exec = sinon.stub().callsFake(async (cmd, args) => fs.outputFile(args.at(-1), 'jpg'));
      await thumbnailFor({ id: 8, kind: 'image', path: file }, dir, { exec });
      expect(exec.firstCall.args[1]).to.not.include('-ss');
      const failing = sinon.stub().rejects(new Error('ffmpeg failed'));
      expect(await thumbnailFor({ id: 9, kind: 'image', path: file }, dir, { exec: failing })).to.be.null;
      expect(await thumbnailFor({ id: 10, kind: 'image', path: null }, dir, { exec })).to.be.null;
    });
  });
});
