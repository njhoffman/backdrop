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
      selected: sinon.stub().callsFake(async name => ({ monitor: monitors.find(m => m.name === name), path: playing.media?.path ?? null, ...playing })),
      state: sinon.stub().resolves({ monitors })
    };
    display = { control, next: sinon.stub().resolves(), prev: sinon.stub().resolves(), mode: sinon.stub().resolves(),
      speed: sinon.stub().resolves(), dim: sinon.stub().resolves() };
    rating = { keep: sinon.stub().resolves(), skip: sinon.stub().resolves(), undo: sinon.stub().resolves() };
    shown = [];
    picks = [];
    // Picks entries by label, or a { key }, in order; null is Escape, and running out of picks quits
    const view = async menu => {
      shown.push(menu);
      if (!picks.length) return { key: 'q' };
      const pick = picks.shift();
      if (pick === null || typeof pick === 'object') return pick;
      const index = menu.entries.findIndex(entry => entry.label === pick);
      if (index === -1) throw new Error(`no entry ${pick} in ${menu.entries.map(entry => entry.label).join(', ')}`);
      return index;
    };
    thumbnail = sinon.stub().resolves('/cache/thumbnails/1.jpg');
    config = makeConfig();
    command = new MenuCommand(config, db, silentLogger, { display, rating, view, thumbnail });
    notifications.length = 0;
  });
  afterEach(() => db.close());

  const labels = menu => menu.entries.map(entry => entry.label);
  const flagged = (menu, flag) => menu.entries.flatMap(entry => (entry[flag] ? [entry.label] : []));

  it('draws a fixed two-row grid with keys, highlighting the rating and changed speed', async () => {
    picks = ['keep 3'];
    await command.open();
    expect(shown).to.have.length(2);
    expect(labels(shown[0])).to.deep.equal(['next', 'keep 1', 'keep 2', 'keep 3', 'speed ▸', 'prev', 'skip', 'undo',
      'mode: switch to images', 'dim ▸']);
    expect(shown[0].entries.map(entry => entry.key)).to.deep.equal(['n', '1', '2', '3', 's', 'p', '0', 'u', 'm', 'd']);
    // Nerd Font glyphs are private-use characters that editors can drop silently
    expect(shown[0].entries.every(entry => /[\u2605\uf000-\uf8ff]/.test(entry.icon))).to.be.true;
    expect(shown[0]).to.include({ title: 'ocean-waves.mp4', preview: '/cache/thumbnails/1.jpg', columns: 5 });
    expect(shown[0].keys).to.deep.equal(['q', 'Tab']);
    expect(shown[0].message).to.equal(`#${playing.media.id}  video  3840x2160\n0:18 · 25 fps · ★★☆ · DP-1\nocean, waves\n<b>speed 0.8</b>`);
    expect(flagged(shown[0], 'active')).to.deep.equal(['keep 2', 'speed ▸']);
    expect(shown[0].entries[4].caption).to.equal('speed 0.8');
    expect(flagged(shown[0], 'disabled')).to.deep.equal([]);
    // display.order defaults to random, so keep's advance is random too
    expect(rating.keep.calledOnceWithExactly(3, { monitor: 'DP-1', random: true, query: undefined, tag: undefined,
      keywords: undefined, next: true })).to.be.true;
  });

  it('keeps every slot, fading what does not apply, and ignores picks of faded buttons', async () => {
    playing = { media: null, rating: null };
    picks = ['skip', { key: '1' }];
    await command.open();
    expect(labels(shown[0])).to.have.length(10);
    expect(flagged(shown[0], 'disabled')).to.deep.equal(['keep 1', 'keep 2', 'keep 3', 'speed ▸', 'skip', 'dim ▸']);
    expect(shown[0].message).to.equal('DP-1: nothing from the library playing');
    expect(shown).to.have.length(3);
    expect(rating.skip.called || rating.keep.called).to.be.false;

    const image = db.addMedia({ kind: 'image', source: 'pexels', source_id: 2, path: '/m/remote-2.jpg', width: 1920, height: 1080, dim: 30 });
    playing = { media: db.getMedia(image), rating: null };
    await command.open();
    expect(flagged(shown.at(-1), 'disabled')).to.deep.equal(['speed ▸']);
    expect(flagged(shown.at(-1), 'active')).to.deep.equal(['dim ▸']);
    expect(shown.at(-1).entries[9].caption).to.equal('dim 30');
    expect(shown.at(-1).title).to.equal('remote-2.jpg');
  });

  it('runs buttons by key and stays open until q or Escape on the main menu', async () => {
    picks = [{ key: 'n' }, { key: 'p' }, { key: '0' }, { key: 'u' }, { key: 'm' }, null];
    await command.open();
    expect(shown).to.have.length(6);
    expect(display.next.calledOnceWith(sinon.match({ monitor: 'DP-1', random: true }))).to.be.true;
    expect(display.prev.calledOnceWithExactly({ monitor: 'DP-1' })).to.be.true;
    expect(rating.skip.calledOnceWith(sinon.match({ monitor: 'DP-1', random: true }))).to.be.true;
    expect(rating.undo.calledOnce).to.be.true;
    expect(display.mode.calledOnceWithExactly('image', { monitor: 'DP-1' })).to.be.true;
  });

  it('shows random and the filters it was opened with, and passes them to next, keep and skip', async () => {
    db.addSearch('pexels', 'Ocean Waves');
    picks = [{ key: 'n' }, { key: '2' }];
    await command.open({ random: false, query: ['ocean waves'], tag: ['sunset', 'sea'] });
    expect(shown[0].status).to.deep.equal([
      'random  <b>off</b>', 'query  <b>"ocean waves"</b>', 'tags  <b>sunset, sea</b>', 'monitor  <b>DP-1</b>  (Tab)'
    ]);
    const filters = { monitor: 'DP-1', random: false, query: ['ocean waves'], tag: ['sunset', 'sea'], keywords: undefined };
    expect(display.next.calledOnceWithExactly(filters)).to.be.true;
    expect(rating.keep.calledOnceWithExactly(2, { ...filters, next: true })).to.be.true;

    let caught;
    try { await command.open({ query: ['ocean'] }); } catch (error) { caught = error; }
    expect(caught.message).to.include('No search used the query "ocean"');
    expect(notifications.at(-1).join(' ')).to.include('No search used the query');
  });

  it('steps speed in a submenu until Escape returns to the main menu; q there closes it', async () => {
    db.setSpeed(playing.media.id, 1);
    playing.media = db.getMedia(playing.media.id);
    picks = [{ key: 's' }, '0.75', '+0.1', null, 'dim ▸', { key: 'q' }];
    await command.open();
    expect(display.speed.args).to.deep.equal([['0.75', { monitor: 'DP-1' }], ['+0.1', { monitor: 'DP-1' }]]);
    expect(shown.map(menu => menu.prompt)).to.deep.equal(['backdrop', 'speed (now 1)', 'speed (now 1)', 'speed (now 1)', 'backdrop', 'dim (now 0)']);
    expect(shown[1]).to.include({ columns: 7 });
    expect(flagged(shown[1], 'active')).to.deep.equal(['1']);
    expect(flagged(shown[0], 'active')).to.deep.equal(['keep 2']);
  });

  it('retargets another monitor with Tab, and offers no Tab with one monitor', async () => {
    picks = [{ key: 'Tab' }, 'HDMI-1', { key: 'n' }, { key: 'Tab' }, null, null];
    await command.open();
    expect(flagged(shown[1], 'active')).to.deep.equal(['DP-1']);
    expect(display.next.calledOnceWith(sinon.match({ monitor: 'HDMI-1' }))).to.be.true;
    expect(shown.at(-1).status.at(-1)).to.include('HDMI-1');

    display.control.state.resolves({ monitors: [monitors[0]] });
    picks = [];
    await command.open({ stay: true });
    expect(shown.at(-1).keys).to.deep.equal(['q']);
    expect(shown.at(-1).status.some(line => line.includes('monitor'))).to.be.false;
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

  it('announces a failed action and stays open, but closes when it cannot read what plays', async () => {
    rating.undo.rejects(new Error('nothing <restorable>'));
    picks = [{ key: 'u' }, { key: 'n' }];
    await command.open();
    expect(notifications[0]).to.include('--urgency=critical').and.include('nothing &lt;restorable&gt;');
    expect(display.next.calledOnce).to.be.true;

    display.control.selected.rejects(new Error('backdrop daemon is not running'));
    let caught;
    try { await command.open(); } catch (error) { caught = error; }
    expect(caught.message).to.equal('backdrop daemon is not running');
    expect(notifications).to.have.length(2);
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
      prompt: 'backdrop', title: 'a "b".mp4', message: 'msg', preview: '/t/1 "x".jpg', status: ['random  <b>on</b>', "tags  \"sea\" it's a\\b"],
      keys: ['q', 'Tab'],
      entries: [{ icon: 'I', label: 'keep 1', key: '1' }, { icon: 'J', label: 'speed ▸', caption: 'speed 0.8', key: '0', active: true },
        { label: 'a|b <c>', disabled: true }]
    };

    it('minimal: one line per entry with its icon and key, the status under the message', async () => {
      const { spawn, calls } = fakeSpawn(0, '1\n');
      expect(await minimalView(['-theme', 'x.rasi'], spawn)(menu)).to.equal(1);
      expect(calls[0].file).to.equal('rofi');
      expect(calls[0].args).to.deep.equal(['-dmenu', '-i', '-no-custom', '-format', 'i',
        '-kb-element-next', '', '-kb-custom-1', '1', '-kb-custom-2', '0', '-kb-custom-3', 'q', '-kb-custom-4', 'Tab',
        '-p', 'backdrop', '-mesg', 'msg\nrandom  <b>on</b>  ·  tags  "sea" it\'s a\\b', '-a', '1', '-theme', 'x.rasi']);
      expect(calls[0].input()).to.equal('I  1  keep 1\nJ  0  speed ▸\na|b <c>\n');
    });

    it('panel: buttons with an icon over key and caption, sized grid, status, title and preview image', async () => {
      const { spawn, calls } = fakeSpawn(0, '0\n');
      expect(await panelView([], spawn)(menu)).to.equal(0);
      const { args } = calls[0];
      expect(args).to.include.members(['-markup-rows', '-theme', PANEL_THEME, '-p', 'a "b".mp4', '-mesg', 'msg', '-a', '1']);
      expect(args[args.indexOf('-sep') + 1]).to.equal('|');
      expect(args).to.include('listview { columns: 3; lines: 1; }');
      // rasi takes no line breaks or quotes inside a string, so they arrive escaped and as entities
      expect(args).to.include('textbox-status { content: "random  <b>on</b>\\ntags  &quot;sea&quot; it&apos;s a&#92;b"; }');
      const grid = async (count, columns) => {
        const fake = fakeSpawn(0, '0\n');
        await panelView([], fake.spawn)({ ...menu, columns, entries: Array.from({ length: count }, (_, i) => ({ label: String(i) })) });
        return fake.calls[0].args.find(arg => arg.startsWith('listview'));
      };
      expect(await grid(10, 5)).to.equal('listview { columns: 5; lines: 2; }');
      expect(await grid(13)).to.equal('listview { columns: 7; lines: 2; }');
      expect(await grid(6)).to.equal('listview { columns: 6; lines: 1; }');
      expect(args).to.include('preview { background-image: url("/t/1 \\"x\\".jpg", width); }');
      expect(calls[0].input()).to.equal('<span font_size="x-large">I</span>\n<span alpha="55%">1</span>  keep 1|'
        + '<span font_size="x-large">J</span>\n<span alpha="55%">0</span>  <b>speed 0.8</b>|'
        + '<span alpha="35%"><span font_size="x-large"> </span>\na¦b &lt;c&gt;</span>');
      expect(await fs.pathExists(PANEL_THEME)).to.be.true;
    });

    it('returns a pressed key, null when dismissed, and fails when rofi is missing or errors', async () => {
      expect(await panelView([], fakeSpawn(10).spawn)(menu)).to.deep.equal({ key: '1' });
      expect(await panelView([], fakeSpawn(13).spawn)(menu)).to.deep.equal({ key: 'Tab' });
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

    it('runs ffmpeg at the lowest priority with nice', async () => {
      const file = path.join(dir, 'i.png');
      await fs.outputFile(file, 'png');
      const exec = sinon.stub().callsFake(async (cmd, args) => fs.outputFile(args.at(-1), 'jpg'));
      expect(await thumbnailFor({ id: 11, kind: 'image', path: file }, dir, { exec, nice: true })).to.equal(path.join(dir, '11.jpg'));
      expect(exec.firstCall.args[0]).to.equal('nice');
      expect(exec.firstCall.args[1].slice(0, 3)).to.deep.equal(['-n', '19', 'ffmpeg']);
    });
  });
});
