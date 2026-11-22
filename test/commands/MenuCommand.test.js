import { expect } from 'chai';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MenuCommand, minimalView, NO_SCREENSHOT, panelView, PANEL_THEME } from '../../src/commands/MenuCommand.js';
import { statePath } from '../../src/display/Daemon.js';
import { setMode, setModeHold } from '../../src/display/Playlist.js';
import { readNextFilters } from '../../src/display/nextFilters.js';
import { stillFor, thumbnailFor } from '../../src/library/thumbnail.js';
import { notifications } from '../helpers/setup.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('MenuCommand', () => {
  const monitors = [{ name: 'DP-1', width: 1920, height: 1080 }, { name: 'HDMI-1', width: 1920, height: 1080 }];
  let db, config, display, rating, shown, picks, command, playing, thumbnail, workspace, leave, runtime;

  beforeEach(async () => {
    runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-menu-'));
    // readState treats the state as live because this test process's pid is running
    await fs.writeJson(statePath(runtime), { pid: process.pid, monitors });
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
      speed: sinon.stub().resolves(), dim: sinon.stub().resolves(), bounce: sinon.stub().resolves() };
    rating = { keep: sinon.stub().resolves(), skip: sinon.stub().resolves(), undo: sinon.stub().resolves() };
    shown = [];
    picks = [];
    // Picks entries by label, or a { key }, in order; null is Escape, { inspect: label } presses i on that entry, and
    // running out of picks quits
    const view = async menu => {
      shown.push(menu);
      if (!picks.length) return { key: 'q' };
      const pick = picks.shift();
      if (pick?.inspect) return { key: 'i', index: menu.entries.findIndex(entry => entry.label === pick.inspect) };
      if (pick === null || typeof pick === 'object') return pick;
      const index = menu.entries.findIndex(entry => entry.label === pick);
      if (index === -1) throw new Error(`no entry ${pick} in ${menu.entries.map(entry => entry.label).join(', ')}`);
      return index;
    };
    thumbnail = sinon.stub().resolves('/cache/thumbnails/1.jpg');
    config = makeConfig({ 'paths.runtime': runtime });
    leave = sinon.stub().resolves();
    workspace = sinon.stub().resolves(leave);
    command = new MenuCommand(config, db, silentLogger, { display, rating, view, thumbnail, workspace });
    notifications.length = 0;
  });
  afterEach(async () => {
    db.close();
    await fs.remove(runtime);
  });

  const labels = menu => menu.entries.map(entry => entry.label);
  const flagged = (menu, flag) => menu.entries.flatMap(entry => (entry[flag] ? [entry.label] : []));

  it('draws a fixed two-row grid with keys, highlighting the rating and changed speed', async () => {
    picks = ['keep 3'];
    await command.open();
    expect(shown).to.have.length(2);
    expect(labels(shown[0])).to.deep.equal(['next', 'keep 1', 'keep 2', 'keep 3', 'speed ▸', 'prev', 'skip', 'undo',
      'mode: switch to images', 'dim ▸']);
    expect(shown[0].entries.map(entry => entry.key)).to.deep.equal(['n', '1', '2', '3', 'v', 'p', 's', 'u', 'm', 'd']);
    // Nerd Font glyphs are private-use characters that editors can drop silently
    expect(shown[0].entries.every(entry => /[\u2605\uf000-\uf8ff]/.test(entry.icon))).to.be.true;
    expect(shown[0]).to.include({ title: 'ocean-waves.mp4', preview: '/cache/thumbnails/1.jpg', columns: 5 });
    expect(shown[0].keys).to.deep.equal(['q', 'z', 'o', 'Tab']);
    expect(shown[0].message).to.equal(
      `#${playing.media.id}  video  <b>3840x2160</b>\n<b>0:18</b> · 25 fps · ★★☆ · DP-1\nocean, waves\n<b>speed 0.8</b>`);
    expect(flagged(shown[0], 'active')).to.deep.equal(['keep 2', 'speed ▸']);
    expect(shown[0].entries[4].caption).to.equal('speed 0.8');
    expect(flagged(shown[0], 'disabled')).to.deep.equal([]);
    // The order and filters for the advance are the stored ones, which keep reads itself
    expect(rating.keep.calledOnceWithExactly(3, { monitor: 'DP-1' })).to.be.true;
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
    picks = [{ key: 'n' }, { key: 'p' }, { key: 's' }, { key: 'u' }, { key: 'm' }, null];
    await command.open();
    expect(shown).to.have.length(6);
    expect(display.next.calledOnceWithExactly({ monitor: 'DP-1' })).to.be.true;
    expect(display.prev.calledOnceWithExactly({ monitor: 'DP-1' })).to.be.true;
    expect(rating.skip.calledOnceWithExactly({ monitor: 'DP-1' })).to.be.true;
    expect(rating.undo.calledOnce).to.be.true;
    expect(display.mode.calledOnceWithExactly('image', { monitor: 'DP-1' })).to.be.true;
  });

  it('stores the order and filters it was opened with for next, and shows the stored ones on each redraw', async () => {
    db.addSearch('pexels', 'Ocean Waves');
    picks = [{ key: 'n' }, { key: '2' }];
    // next run elsewhere while the menu is open changes what the next redraw shows
    display.next.callsFake(async () => fs.writeJson(path.join(runtime, 'next-filters.json'), { pid: process.pid, tag: ['sky'] }));
    await command.open({ random: false, query: ['ocean waves'], tag: ['sunset', 'sea'] });
    expect(shown[0].status).to.deep.equal([
      'random  <b>off</b>', 'query  <b>"ocean waves"</b>', 'tags  <b>sunset, sea</b>', 'visualizer  <b>menu</b>  (z)', 'web  <b>off</b>  (o opens it)', 'monitor  <b>DP-1</b>  (Tab)'
    ]);
    // display.order defaults to random
    expect(shown[1].status).to.deep.equal(['random  <b>on</b>', 'tags  <b>sky</b>', 'visualizer  <b>menu</b>  (z)', 'web  <b>off</b>  (o opens it)', 'monitor  <b>DP-1</b>  (Tab)']);

    // Opening without any keeps what is stored; a mistyped query fails before anything is stored
    await command.open();
    expect(shown.at(-1).status[1]).to.equal('tags  <b>sky</b>');
    let caught;
    try { await command.open({ query: ['ocean'] }); } catch (error) { caught = error; }
    expect(caught.message).to.include('No search used the query "ocean"');
    expect(notifications.at(-1).join(' ')).to.include('No search used the query');
    expect(await readNextFilters(runtime)).to.deep.equal({ tag: ['sky'] });
  });

  it('shows the playlist filter in the status, apart from next\'s filters', async () => {
    db.setSetting('playlist_filter', { tag: ['ocean'], query: ['sea'] });
    picks = [{ key: 'q' }];
    await command.open();
    expect(shown[0].status[1]).to.equal('playlist  <b>tags ocean · query "sea"</b>');
  });

  it('clears the monitor picked with Tab, giving the first its windows back', async () => {
    const order = [];
    const leaves = name => async () => { order.push(`leave ${name}`); };
    workspace.callsFake(async (name, monitor) => { order.push(`enter ${monitor}`); return leaves(monitor); });
    const main = sinon.stub(command, 'mainMenu');
    main.onCall(0).resolves({ monitor: 'HDMI-1' });
    main.onCall(1).resolves({ monitor: 'HDMI-1' });
    main.onCall(2).resolves({ quit: true });
    await command.open({});
    expect(order).to.deep.equal(['enter DP-1', 'leave DP-1', 'enter HDMI-1', 'leave HDMI-1']);
    expect(main.lastCall.args[0]).to.equal('HDMI-1');
  });

  it('shows the menu workspace while open and returns from it however the menu closes', async () => {
    await command.open();
    expect(workspace.calledOnceWith('backdrop', 'DP-1')).to.be.true;
    expect(leave.calledOnce).to.be.true;

    config.set('menu.workspace', 'wall');
    display.control.selected.rejects(new Error('backdrop daemon is not running'));
    let caught;
    try { await command.open(); } catch (error) { caught = error; }
    expect(caught.message).to.equal('backdrop daemon is not running');
    expect(workspace.lastCall.args[0]).to.equal('wall');
    expect(leave.calledTwice).to.be.true;

    config.set('menu.workspace', false);
    display.control.selected.resolves({ monitor: monitors[0], ...playing });
    await command.open();
    expect(workspace.lastCall.args[0]).to.be.null;
  });

  it('draws every button of the main menu and the speed panel with an icon', async () => {
    picks = [{ key: 'v' }, null, { key: 'q' }];
    await command.open();
    for (const menu of shown.slice(0, 2)) {
      const blank = menu.entries.filter(entry => typeof entry.icon !== 'string' || !entry.icon.trim()).map(entry => entry.label);
      expect(blank, menu.prompt).to.deep.equal([]);
    }
    expect(shown[1].entries.find(entry => entry.label === 'bounce').icon).to.equal('\u{f0ec}');
  });

  it('opens the web interface\'s page with o: the running server\'s, else one started for it, and closes', async () => {
    const opened = [];
    let started = 0;
    let web = { pid: 9, port: 7737, token: 'abc' };
    const withWeb = new MenuCommand(config, db, silentLogger, {
      display, rating, view: command.view, thumbnail, workspace,
      webInfo: async () => web, openUrl: url => opened.push(url), startWeb: () => { started++; }
    });
    picks = [{ key: 'o' }];
    await withWeb.open();
    expect(opened).to.deep.equal(['http://127.0.0.1:7737/?token=abc']);
    expect(shown[0].status).to.include('web  <b>port 7737</b>  (o opens it)');
    // The menu closed: one menu shown, nothing after
    expect(shown).to.have.length(1);

    web = null;
    picks = [{ key: 'o' }];
    await withWeb.open();
    expect(started).to.equal(1);
    expect(opened).to.have.length(1);
  });

  it('labels the mode button from the chosen mode, and captions a load hold', async () => {
    const button = () => shown[0].entries.find(entry => entry.key === 'm');
    setMode(db, 'video');
    setModeHold(db, 'image');
    picks = [null];
    await command.open();
    // Video is still the choice, so the button offers images, and shows what holds the wallpaper there
    expect(button()).to.include({ label: 'mode: switch to images', caption: 'mode, held: images', active: true });
    shown.length = 0;
    setModeHold(db, null);
    await command.open();
    expect(button()).to.include({ label: 'mode: switch to images', caption: 'mode', active: false });
  });

  it('captions the bounce button "reversing" while its reversed copy is made', async () => {
    db.setBounce(playing.media.id, true);
    playing.media = db.getMedia(playing.media.id);
    picks = [{ key: 'v' }, null, { key: 'q' }];
    await command.open();
    expect(shown[1].entries.find(entry => entry.label === 'bounce')).to.include({ caption: 'reversing', active: true });
  });

  it('turns the video\'s bounce on and off from the speed submenu', async () => {
    picks = [{ key: 'v' }, 'bounce', null, { key: 'q' }];
    await command.open();
    expect(display.bounce.args).to.deep.equal([['on', { monitor: 'DP-1' }]]);
    expect(flagged(shown[1], 'active')).to.not.include('bounce');

    db.setBounce(playing.media.id, true);
    playing.media = db.getMedia(playing.media.id);
    picks = [{ key: 'v' }, 'bounce', null, { key: 'q' }];
    await command.open();
    expect(flagged(shown.at(-3), 'active')).to.include('bounce');
    expect(display.bounce.lastCall.args[0]).to.equal('off');
  });

  it('steps speed in a submenu until Escape returns to the main menu; q there closes it', async () => {
    db.setSpeed(playing.media.id, 1);
    playing.media = db.getMedia(playing.media.id);
    picks = [{ key: 'v' }, '0.65', '+0.1', null, 'dim ▸', { key: 'q' }];
    await command.open();
    expect(labels(shown[1])).to.deep.equal(['0.4', '0.5', '0.65', '0.75', '0.85', '1', '1.25', '1.5', '2', '-0.1', '+0.1', 'bounce']);
    // The fake leaves the speed at 1, where +0.1 goes on above it
    expect(display.speed.args).to.deep.equal([['0.65', { monitor: 'DP-1' }], ['+0.1', { monitor: 'DP-1' }]]);
    expect(shown.map(menu => menu.prompt)).to.deep.equal(['backdrop', 'speed (now 1)', 'speed (now 1)', 'speed (now 1)', 'backdrop', 'dim (now 0)']);
    // Two rows of six
    expect(shown[1]).to.include({ columns: 6 });
    expect(flagged(shown[1], 'active')).to.deep.equal(['1']);
    expect(flagged(shown[0], 'active')).to.deep.equal(['keep 2']);

    db.setSpeed(playing.media.id, 0.85);
    playing.media = db.getMedia(playing.media.id);
    picks = [{ key: 'v' }, '+0.1', null];
    await command.open();
    expect(display.speed.lastCall.args[0]).to.equal('+0.1');

    // +0.1 stops at 2, the fastest button
    db.setSpeed(playing.media.id, 1.95);
    playing.media = db.getMedia(playing.media.id);
    picks = [{ key: 'v' }, '1.5', '+0.1', null];
    await command.open();
    expect(display.speed.args.slice(-2).map(args => args[0])).to.deep.equal(['1.5', '2']);
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
    expect(shown.at(-1).keys).to.deep.equal(['q', 'z', 'o']);
    expect(shown.at(-1).status.some(line => line.includes('monitor'))).to.be.false;
  });

  it('makes no thumbnail for the minimal style and rejects an unknown style', async () => {
    await command.open({ style: 'minimal' });
    expect(thumbnail.called).to.be.false;
    expect(shown[0].preview).to.be.null;
    config.set('menu.style', 'fancy');
    let caught;
    try { await command.open(); } catch (error) { caught = error; }
    expect(caught.message).to.equal('menu.style must be panel or minimal, not "fancy"');
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

  it('announces the playlist warnings of a rating, also when it fails after the rating', async () => {
    rating.keep.resolves({ rated: playing.media, warnings: ['Could not update the playlist: socket gone'], playing: null });
    const failed = Object.assign(new Error('next failed'), { done: { rated: playing.media, warnings: ['Could not remove it from the playlist'] } });
    rating.skip.rejects(failed);
    picks = ['keep 3', 'skip'];
    await command.open();
    const bodies = notifications.map(args => args.at(-1));
    expect(bodies).to.deep.equal(['Could not update the playlist: socket gone', 'Could not remove it from the playlist', 'next failed']);
    expect(notifications.every(args => args.includes('--urgency=critical'))).to.be.true;
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
        '-kb-element-next', '', '-me-select-entry', '', '-me-accept-entry', 'MousePrimary', '-kb-custom-1', '1', '-kb-custom-2', '0', '-kb-custom-3', 'q', '-kb-custom-4', 'Tab',
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

    it('panel: pictures as rofi icons, detail lines, the row to start on and a tall banner', async () => {
      const { spawn, calls } = fakeSpawn(0, '0\n');
      await panelView([], spawn)({
        prompt: 'load', message: 'm', selected: 1, banner: 'tall', preview: '/t/ring.jpg',
        entries: [{ icon: 'P', label: 'none', detail: 'No preset' }, { icon: 'P', label: 'ring', image: '/t/ring.jpg', detail: 'A ring | here' }]
      });
      const { args } = calls[0];
      expect(args).to.include.members(['-show-icons', 'element-icon { size: 112px; }', 'preview { padding: 205px 0px; }', '-selected-row', '1']);
      expect(args[args.indexOf('-eh') + 1]).to.equal('4');
      expect(calls[0].input()).to.equal('<span font_size="x-large">P</span>\nnone\n<span font_size="small" alpha="70%">No preset</span>|'
        + 'ring\n<span font_size="small" alpha="70%">A ring ¦ here</span>\0icon\x1f/t/ring.jpg');
      // Without pictures or details, as before
      const plain = fakeSpawn(0, '0\n');
      await panelView([], plain.spawn)(menu);
      expect(plain.calls[0].args).to.not.include('-show-icons');
      expect(plain.calls[0].args[plain.calls[0].args.indexOf('-eh') + 1]).to.equal('3');
      const minimal = fakeSpawn(0, '0\n');
      await minimalView([], minimal.spawn)({ prompt: 'load', entries: [{ icon: 'P', label: 'ring', detail: 'A ring' }] });
      expect(minimal.calls[0].input()).to.equal('P  ring  - A ring\n');
    });

    it('returns the entry under the cursor with a pressed key', async () => {
      expect(await panelView([], fakeSpawn(11, '4\n').spawn)(menu)).to.deep.equal({ key: '0', index: 4 });
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

    it('makes the notification\'s 16:9 still beside the banner, cached the same way', async () => {
      const file = path.join(dir, 'v.mp4');
      await fs.outputFile(file, 'video');
      const exec = sinon.stub().callsFake(async (cmd, args) => fs.outputFile(args.at(-1), 'jpg'));
      const media = { id: 7, kind: 'video', path: file, duration: 18 };
      expect(await stillFor(media, dir, { exec })).to.equal(path.join(dir, '7.still.jpg'));
      expect(exec.firstCall.args[1]).to.include('scale=320:180:force_original_aspect_ratio=increase,crop=320:180');
      await stillFor(media, dir, { exec });
      expect(exec.calledOnce).to.be.true;
      expect(await thumbnailFor(media, dir, { exec })).to.equal(path.join(dir, '7.jpg'));
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

  describe('with the wallpaper off', () => {
    beforeEach(() => {
      // The daemon reports a null socket for each monitor while the wallpaper is off
      const off = monitors.map(monitor => ({ ...monitor, socket: null }));
      display.control.state = sinon.stub().resolves({ monitors: off, visualizer: { enabled: true, preset: null, presets: [], instances: ['main'], live: {} } });
      display.control.selected = sinon.stub().rejects(new Error('The wallpaper is off; turn it on with `backdrop start --wallpaper`'));
      display.start = sinon.stub().resolves();
    });

    it('opens without asking mpv, fades the buttons that need it, and turns the wallpaper on with w', async () => {
      picks = [{ key: 'w' }, { key: 'q' }];
      await command.open();
      const menu = shown[0];
      expect(display.control.selected.called).to.equal(false);
      expect(menu.message).to.equal('DP-1: wallpaper off');
      expect(menu.preview).to.equal(undefined);
      expect(menu.entries.filter(entry => entry.disabled).map(entry => entry.label))
        .to.deep.equal(['next', 'keep 1', 'keep 2', 'keep 3', 'speed ▸', 'prev', 'skip', 'dim ▸']);
      expect(menu.keys).to.include('w');
      expect(menu.status[0]).to.equal('wallpaper  <b>off</b>  (w turns it on)');
      expect(display.start.calledOnceWith({ wallpaper: true })).to.equal(true);
      expect(notifications).to.deep.equal([]);
    });

    it('opens the visualizer menu without a preview', async () => {
      picks = [null];
      await command.open({ page: 'visualizer' });
      expect(shown[0].prompt).to.equal('visualizer');
      expect(shown[0].preview).to.equal(undefined);
      expect(notifications).to.deep.equal([]);
    });
  });

  describe('visualizer menu', () => {
    let vis, requests, asked, configFile;
    // The daemon's side of the control requests: changes merge per instance, reset drops them
    const sendControl = async (runtimeDir, state, change) => {
      requests.push(change);
      if (change.visualizer_set) {
        const { instance, changes } = change.visualizer_set;
        if (!change.refuse) vis.live = { ...vis.live, [instance]: { ...(vis.live[instance] ?? {}), ...changes } };
      }
      if (change.visualizer_reset) vis.live = {};
      if (change.preset !== undefined) vis.preset = change.preset;
      if (typeof change.visualizer === 'boolean') vis.enabled = change.visualizer;
      return { monitors, visualizer: vis };
    };
    const open = (overrides = {}) => new MenuCommand(config, db, silentLogger, {
      display, rating, thumbnail, workspace, view: command.view, control: sendControl, ask: async prompt => { asked.push(prompt); return asked.answer ?? null; }, ...overrides
    });

    beforeEach(async () => {
      requests = [];
      asked = [];
      vis = { enabled: true, error: null, preset: null, presets: ['subtle', 'ring', 'wave', 'party'], instances: ['main'], live: {} };
      display.control.state = sinon.stub().callsFake(async () => ({ monitors, visualizer: vis }));
      configFile = path.join(runtime, 'config.yaml');
      await fs.writeFile(configFile, 'visualizer:\n  enabled: true     # kept\n  bars: { amplify: 300 }\n');
      config.configPath = configFile;
      config.set('visualizer', { enabled: true, bars: { amplify: 300 } });
    });

    it('opens from the main menu with z and as `menu visualizer`, showing the instance\'s settings', async () => {
      picks = [{ key: 'z' }, null, { key: 'q' }];
      await open().open();
      const menu = shown[1];
      expect(menu.prompt).to.equal('visualizer');
      expect(menu.entries.map(entry => entry.caption ?? entry.label)).to.deep.equal(
        ['on', 'wallpaper', 'bars', 'opacity 0.8', 'amplify 300', 'bottom', 'fixed colors', 'load', 'reset', 'save']);
      expect(menu.entries.find(entry => entry.label === 'reset').disabled).to.equal(true);
      expect(menu.status).to.deep.equal(['preset  <b>none</b>', 'colors  <b>#33aacc</b>']);
      expect(shown[2].prompt).to.equal('backdrop');

      shown.length = 0;
      picks = [null];
      await open().open({ page: 'visualizer' });
      expect(shown.map(item => item.prompt)).to.deep.equal(['visualizer']);
    });

    it('applies steps, picks, colors and reset live through control requests', async () => {
      picks = [
        'opacity ▸', '0.4', '+0.1', null,
        'module ▸', 'radial',
        'colors ▸', 'wallpaper complement', 'ember', null,
        'reset', null
      ];
      await open().open({ page: 'visualizer' });
      expect(requests).to.deep.equal([
        { visualizer_set: { instance: 'main', changes: { opacity: 0.4 } } },
        { visualizer_set: { instance: 'main', changes: { opacity: 0.5 } } },
        { visualizer_set: { instance: 'main', changes: { module: 'radial' } } },
        { visualizer_set: { instance: 'main', changes: { palette: { source: 'wallpaper', pick: 'complement' } } } },
        // radial has a gradient: the swatch's pair, as fixed colors
        { visualizer_set: { instance: 'main', changes: { palette: { source: 'config' }, radial: { colors: ['#3d0c02', '#ff7a33'] } } } },
        { visualizer_reset: true }
      ]);
      const colorsMenu = shown.find(item => item.prompt === 'colors');
      expect(colorsMenu.entries.find(entry => entry.label === 'ember').icon).to.equal('<span foreground="#3d0c02">\u25cf</span><span foreground="#ff7a33">\u25cf</span>');
      const changed = shown.filter(item => item.prompt === 'visualizer').at(-2);
      expect(changed.status.at(-1)).to.equal('changed  <b>until restart (r resets)</b>');
    });

    it('checks a change before sending it, and reports one the daemon refused', async () => {
      config.set('visualizer.bars', { amplify: 300, colors: ['#000000', '#33aacc', '#ffffff'] });
      picks = ['opacity ▸', '0.4', null, null];
      await open().open({ page: 'visualizer' }).catch(() => {});
      expect(requests).to.deep.equal([]);
      expect(notifications.at(-1).at(-1)).to.include('visualizer.bars.colors must be one color, or two for a gradient');

      config.set('visualizer.bars', { amplify: 300 });
      notifications.length = 0;
      picks = ['opacity ▸', '0.4', null, null];
      const refusing = async (runtimeDir, state, change) => { requests.push(change); return { monitors, visualizer: vis }; };
      await open({ control: refusing }).open({ page: 'visualizer' });
      expect(notifications.at(-1).at(-1)).to.include('The daemon refused the change');
    });

    it('turns it off and on, and switches presets', async () => {
      picks = ['turn off', 'turn on', 'load ▸', 'ring', 'ring', 'load ▸', 'none', 'keep', null];
      await open().open({ page: 'visualizer' });
      expect(requests).to.deep.equal([{ visualizer: false }, { visualizer: true }, { preset: 'ring' }, { preset: null }]);
    });

    it('tries presets live in load, going back to the one in force on Escape', async () => {
      picks = ['load ▸', 'ring', 'wave', null, null];
      await open().open({ page: 'visualizer' });
      expect(requests).to.deep.equal([{ preset: 'ring' }, { preset: 'wave' }, { preset: null }]);
      const loads = shown.filter(menu => menu.prompt === 'load');
      expect(loads[0].entries[0].label).to.equal('none');
      expect(loads[2].entries[0].caption).to.equal('keep wave');
      expect(loads[2].message).to.include('trying wave');
      expect(vis.preset).to.equal(null);
    });

    it('shows each preset\'s screenshot and description in load, and one in full with i', async () => {
      const thumbs = path.join(runtime, 'thumbs');
      config.set('paths.thumbnails', thumbs);
      await fs.outputFile(path.join(thumbs, 'visualizer-ring.jpg'), 'jpeg');
      config.set('visualizer.presets', { calm: { opacity: 0.3 } });
      picks = ['load ▸', { inspect: 'ring' }, { inspect: 'wave' }, 'wave', null, null, null];
      await open().open({ page: 'visualizer' });
      const [grid, ring, wave, tried, back] = shown.filter(menu => menu.prompt === 'load');
      const entry = (menu, label) => menu.entries.find(item => item.label === label);
      expect(entry(grid, 'ring')).to.include({ image: path.join(thumbs, 'visualizer-ring.jpg'), detail: 'A radial ring in the middle of the screen' });
      // Once one has a screenshot, the others show a stand-in, since rofi leaves room for a picture on every button
      expect(entry(grid, 'wave').image).to.equal(NO_SCREENSHOT);
      // Without a description, the summary
      expect(entry(grid, 'calm').detail).to.equal('bars bottom');
      expect(entry(grid, 'none').detail).to.equal('No preset: the visualizer section as the config file sets it');
      expect(grid.message).to.include('i shows the one under the cursor');
      // In full: the screenshot as a tall banner, the grid without pictures, the cursor kept on it
      expect(ring).to.include({ title: 'visualizer  ·  ring', preview: path.join(thumbs, 'visualizer-ring.jpg'), banner: 'tall', selected: grid.entries.indexOf(entry(grid, 'ring')) });
      expect(ring.message).to.include('<b>ring</b>  A radial ring in the middle of the screen').and.include('radial center');
      expect(entry(ring, 'ring')).to.not.have.property('image');
      expect(wave).to.not.have.property('preview');
      expect(wave.message).to.include('No screenshot yet');
      // A pick while inspecting tries it and keeps describing what is tried, the cursor following past keep
      expect(requests).to.deep.equal([{ preset: 'wave' }, { preset: null }]);
      expect(tried.title).to.equal('visualizer  ·  wave');
      expect(tried.selected).to.equal(tried.entries.indexOf(entry(tried, 'wave')));
      // Escape leaves the inspection for the pictures first, then the menu, going back to the preset in force
      expect(back.title).to.equal('visualizer  ·  load a preset');
      expect(entry(back, 'ring').image).to.equal(path.join(thumbs, 'visualizer-ring.jpg'));
    });

    it('keeps the load buttons without pictures while no preset has a screenshot', async () => {
      config.set('paths.thumbnails', path.join(runtime, 'empty'));
      picks = ['load ▸', null, null];
      await open().open({ page: 'visualizer' });
      const load = shown.find(menu => menu.prompt === 'load');
      expect(load.entries.filter(item => item.image)).to.deep.equal([]);
      expect(load.entries.find(item => item.label === 'ring').detail).to.equal('A radial ring in the middle of the screen');
    });

    it('turns the wallpaper off and on, but not off while the visualizer is off', async () => {
      const sendWallpaper = async (runtimeDir, state, change) => {
        requests.push(change);
        if (typeof change.wallpaper === 'boolean') wallpaperOn = change.wallpaper;
        return { monitors, visualizer: vis, wallpaper: wallpaperOn };
      };
      let wallpaperOn = true;
      display.control.state = sinon.stub().callsFake(async () => ({ monitors, visualizer: vis, wallpaper: wallpaperOn }));
      picks = ['wallpaper off', 'wallpaper on', null];
      await open({ control: sendWallpaper }).open({ page: 'visualizer' });
      expect(requests).to.deep.equal([{ wallpaper: false }, { wallpaper: true }]);
      const captions = shown.map(menu => menu.entries.find(entry => entry.key === 'w').caption);
      expect(captions).to.deep.equal(['wallpaper', 'no wallpaper', 'wallpaper']);

      vis.enabled = false;
      shown.length = 0;
      requests.length = 0;
      picks = ['wallpaper off', null];
      await open({ control: sendWallpaper }).open({ page: 'visualizer' });
      expect(shown[0].entries.find(entry => entry.key === 'w').disabled).to.equal(true);
      expect(requests).to.deep.equal([]);
    });

    it('saves the look as a preset in the file, keeping its comments, and switches to it', async () => {
      vis.live = { main: { opacity: 0.5 } };
      asked.answer = 'evening';
      picks = ['save as preset', null];
      await open().open({ page: 'visualizer' });
      expect(asked).to.deep.equal(['preset name']);
      expect(await fs.readFile(configFile, 'utf8')).to.equal(
        'visualizer:\n  enabled: true     # kept\n  bars: { amplify: 300 }\n  presets:\n    evening:\n      opacity: 0.5\n');
      expect(requests).to.deep.equal([{ reload_config: true, visualizer_reset: true, preset: 'evening' }]);
    });

    it('asks before replacing a preset, and rejects a bad name', async () => {
      asked.answer = 'ring';
      picks = ['save as preset', 'keep it', null];
      await open().open({ page: 'visualizer' });
      expect(requests).to.deep.equal([]);
      expect(shown.find(item => item.prompt === 'replace?').title).to.equal('replace preset ring?');

      asked.answer = 'my look';
      picks = ['save as preset', null];
      await open().open({ page: 'visualizer' });
      expect(notifications.at(-1).at(-1)).to.include('A preset name is letters, digits, - and _, not "my look"');
    });

    it('deletes a saved preset from the preset menu with x, after a confirmation', async () => {
      await fs.appendFile(configFile, '  presets:\n    evening:\n      opacity: 0.5\n');
      config.set('visualizer', { enabled: true, bars: { amplify: 300 }, presets: { evening: { opacity: 0.5 } } });
      picks = ['load ▸', { key: 'x' }, 'evening', 'keep it', 'load ▸', { key: 'x' }, 'evening', 'delete', null];
      await open().open({ page: 'visualizer' });
      const presetMenu = shown.find(menu => menu.prompt === 'load');
      expect(presetMenu.keys).to.deep.equal(['q', 'i', 'x']);
      expect(shown.find(menu => menu.prompt === 'delete preset').entries.map(entry => entry.label)).to.deep.equal(['evening']);
      expect(await fs.readFile(configFile, 'utf8')).to.equal('visualizer:\n  enabled: true     # kept\n  bars: { amplify: 300 }\n');
      expect(requests).to.deep.equal([{ reload_config: true }]);
    });

    it('offers projectM its frame rate and preset time instead of GLava\'s controls', async () => {
      config.set('visualizer', { enabled: true, instances: [{ name: 'main', engine: 'projectm' }] });
      picks = ['fps ▸', '24', null, null];
      await open().open({ page: 'visualizer' });
      expect(shown[0].entries.map(entry => entry.caption ?? entry.label)).to.deep.equal(
        ['on', 'wallpaper', 'fps 30', '30s each', 'opacity 1', 'bottom', 'load', 'reset', 'save']);
      expect(shown[0].status).to.deep.equal(['preset  <b>none</b>']);
      expect(requests[0]).to.deep.equal({ visualizer_set: { instance: 'main', changes: { projectm: { fps: 24 } } } });
    });

    it('gives each of several instances its own menu, which Escape leaves for the visualizer menu', async () => {
      vis.instances = ['low', 'ring'];
      config.set('visualizer.instances', [{ name: 'low' }, { name: 'ring', module: 'radial' }]);
      picks = ['ring ▸', 'module ▸', 'wave', null, 'low ▸', null, null];
      await open().open({ page: 'visualizer' });
      expect(shown[0].entries.map(entry => entry.caption ?? entry.label)).to.deep.equal(['on', 'wallpaper', 'low', 'ring', 'load', 'reset', 'save']);
      expect(shown[0].status).to.deep.equal(['preset  <b>none</b>']);
      expect(shown[1].title).to.equal('visualizer  ·  ring');
      expect(shown[1].entries.map(entry => entry.caption ?? entry.label)).to.deep.equal(['shown', 'radial', 'opacity 0.8', 'amplify 300', 'bottom', 'fixed colors']);
      expect(requests).to.deep.equal([{ visualizer_set: { instance: 'ring', changes: { module: 'wave' } } }]);
      expect(shown.map(menu => menu.prompt)).to.deep.equal(['visualizer', 'ring', 'module', 'ring', 'visualizer', 'low', 'visualizer']);
    });

    it('hides and shows one instance of several, leaving the others and the visualizer on', async () => {
      vis.instances = ['lyrics', 'ring'];
      config.set('visualizer.instances', [{ name: 'lyrics', engine: 'sleeve' }, { name: 'ring', module: 'radial' }]);
      picks = ['ring ▸', 'hide', null, 'ring ▸', 'show', null, null];
      await open().open({ page: 'visualizer' });
      expect(requests).to.deep.equal([
        { visualizer_set: { instance: 'ring', changes: { visible: false } } },
        { visualizer_set: { instance: 'ring', changes: { visible: true } } }
      ]);
      expect(shown[3].entries.find(entry => entry.label === 'ring ▸').caption).to.equal('ring (hidden)');
      expect(vis.enabled).to.equal(true);
    });

    it('shows the colors last sent to a sleeve instance as colors', async () => {
      vis.instances = ['lyrics', 'ring'];
      config.set('visualizer.instances', [{ name: 'lyrics', engine: 'sleeve', palette: { source: 'wallpaper' } }, { name: 'ring', module: 'radial' }]);
      const sent = { background: '#0a0f1a', main: [{ color: '#aabbcc', share: 0.6 }, { color: '#334455', share: 0.4 }] };
      display.control.state = sinon.stub().callsFake(async () => ({
        monitors: monitors.map(item => ({ ...item, visualizers: [{ instance: 'lyrics', colors: sent }] })), visualizer: vis
      }));
      picks = ['lyrics ▸', null, null];
      await open().open({ page: 'visualizer' });
      expect(shown[1].status).to.deep.equal(['preset  <b>none</b>', 'colors  <b>#0a0f1a to #aabbcc to #334455</b>']);
    });
  });
});
