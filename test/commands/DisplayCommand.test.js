import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { DisplayCommand } from '../../src/commands/DisplayCommand.js';
import { statePath } from '../../src/display/Daemon.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('DisplayCommand', () => {
  let dir, db, config, command, lines;
  const monitors = [
    { name: 'DP-1', width: 1920, height: 1080, x: 0, y: 0, socket: '/run/DP-1.sock' },
    { name: 'DP-2', width: 3840, height: 2160, x: 1920, y: 0, socket: '/run/DP-2.sock' }
  ];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-display-'));
    config = makeConfig({ 'paths.runtime': dir });
    db = new DatabaseManager();
    db.initialize(':memory:');
    // readState treats the state as live because this test process's pid is running
    await fs.writeJson(statePath(dir), { pid: process.pid, monitors });
    command = new DisplayCommand(config, db, silentLogger);
    lines = [];
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(dir);
  });

  const addVideo = (sourceId, width, height, extra = {}) => db.addMedia({
    kind: 'video', source: 'local', source_id: sourceId, path: `/m/${sourceId}.mp4`, width, height, ...extra
  });

  describe('status', () => {
    it('shows eligible counts and explains a monitor too large for the library', async () => {
      const id = addVideo(1, 1920, 1080, { speed: 0.8, dim: 20 });
      db.addRating(id, 2);
      command.control = {
        current: async name => (name === 'DP-1' ? { path: '/m/1.mp4', media: db.getMedia(id) } : { path: null })
      };

      await command.status();

      const text = lines.join('\n');
      expect(text).to.include('DP-1 1920x1080, 1 videos eligible');
      expect(text).to.include(`#${id}  video  1920x1080  landscape  speed 0.8, dim 20`);
      expect(text).to.include('    /m/1.mp4');
      expect(text).to.include('DP-2 3840x2160, 0 videos eligible\n    nothing playing');
      expect(text).to.include('No videos at least 3840x2160').and.include('display.allow_upscale');
    });

    it('points at unplayable files when eligible media exists but nothing loaded', async () => {
      const id = addVideo(1, 3840, 2160);
      db.addRating(id, 2);
      command.control = { current: async () => ({ path: null }) };

      await command.status();

      expect(lines.join('\n')).to.include('1 videos fit but none loaded');
    });

    it('shows each monitor\'s recent mpv CPU and decoder, and the item\'s average in current', async () => {
      const id = addVideo(1, 1920, 1080);
      await fs.writeJson(statePath(dir), { pid: process.pid, monitors: [{ ...monitors[0], cpu: 3.25, hwdec: 'vaapi' }] });
      db.addPlaybackSample(id, 750, 30);
      db.setDecoder(id, 'no');
      const playing = { monitor: monitors[0], path: '/m/1.mp4', media: db.getMedia(id), rating: null };
      command.control = { current: async () => playing };

      await command.status();
      await command.current({});

      const text = lines.join('\n');
      expect(text).to.include('DP-1 1920x1080, 1 videos eligible, cpu 3.3% vaapi');
      expect(text).to.include('cpu 4.0% over 12m30s, software');
    });

    it('prints status, current and a stopped mode switch as JSON', async () => {
      const id = addVideo(1, 1920, 1080, { duration: 12, fps: 30 });
      db.addRating(id, 3, '1920x1080');
      db.addPlaybackSample(id, 100, 5); db.setDecoder(id, 'vaapi');
      await fs.writeJson(statePath(dir), { pid: process.pid, monitors: [{ ...monitors[0], cpu: 2.345, hwdec: 'vaapi' }] });
      const playing = { monitor: monitors[0], path: '/m/1.mp4', media: db.getMedia(id), rating: db.getLatestRating(id) };
      command.control = { current: async () => playing };

      await command.status({ json: true });
      const status = JSON.parse(lines.at(-1));
      expect(status).to.deep.include({ mode: 'video', daemon: { running: true, pid: process.pid } });
      expect(status.monitors[0]).to.include({ name: 'DP-1', eligible: 1, cpu_percent: 2.3, decoder: 'vaapi' });
      expect(status.monitors[0].playing).to.include({ id, duration: 12, fps: 30 });
      expect(status.monitors[0].playing.playback).to.deep.equal({ cpu_percent: 5, seconds: 100, decoder: 'vaapi' });

      await command.current({ json: true });
      const current = JSON.parse(lines.at(-1));
      expect(current.monitor).to.deep.equal({ name: 'DP-1', width: 1920, height: 1080 });
      expect(current.item.rating.value).to.equal(3);

      command.control = { current: async () => ({ monitor: monitors[0], path: null, media: null, rating: null }) };
      await command.current({ json: true });
      expect(JSON.parse(lines.at(-1)).item).to.be.null;

      await fs.remove(statePath(dir));
      command = new DisplayCommand(config, db, silentLogger);
      await command.mode('image', { json: true });
      expect(JSON.parse(lines.at(-1))).to.deep.equal({ mode: 'image', monitor: null, item: null });
      await command.status({ json: true });
      expect(JSON.parse(lines.at(-1))).to.deep.equal({ mode: 'image', daemon: { running: false, pid: null }, monitors: [] });
    });

    it('says the daemon waits when none of its configured monitors is active', async () => {
      await fs.writeJson(statePath(dir), { pid: process.pid, monitors: [] });
      await command.status();
      expect(lines.join('\n')).to.include('waiting for the monitors in display.monitors');
      let caught;
      try { await command.next({}); } catch (error) { caught = error; }
      expect(caught.message).to.include('waiting for its configured monitors');
    });

    it('suggests importing when upscaling is allowed and the library is empty', async () => {
      config.set('display.allow_upscale', true);
      command.control = { current: async () => ({ path: null }) };

      await command.status();

      expect(lines.join('\n')).to.include('No videos in the library');
    });
  });

  describe('navigation', () => {
    it('shows the item next switched to, randomly when display.order is random', async () => {
      const id = addVideo(1, 1920, 1080);
      db.addRating(id, 3);
      const playing = { monitor: monitors[0], path: '/m/1.mp4', media: db.getMedia(id), rating: db.getLatestRating(id) };
      command.control = { next: sinon.stub().resolves(playing), prev: sinon.stub().resolves(playing) };
      config.set('display.order', 'random');

      await command.next({ monitor: 'DP-1' });
      await command.prev({ line: true });

      expect(command.control.next.calledOnceWithExactly('DP-1', { random: true })).to.be.true;
      expect(lines[0]).to.equal(`#${id}  video  1920x1080  landscape  3/3 landscape  DP-1`);
      expect(lines.at(-1)).to.equal(`#${id}\tvideo\t1920x1080\t\t\tlandscape\t3/3\tlocal\t\t/m/1.mp4`);
      await command.next({ random: false });
      expect(command.control.next.lastCall.args[1]).to.deep.equal({ random: false });
    });

    it('passes the displayable items matching --query/--tag to next and validates queries first', async () => {
      const ocean = addVideo(1, 1920, 1080);
      const skipped = addVideo(2, 1920, 1080);
      db.addRating(skipped, 0);
      db.addMedia({ kind: 'video', source: 'pexels', source_id: 3 });
      const search = db.addSearch('pexels', 'Ocean');
      for (const id of [ocean, skipped]) db.addSearchResult(search, id, 1);
      const playing = { monitor: monitors[0], path: '/m/1.mp4', media: db.getMedia(ocean), rating: null };
      command.control = { next: sinon.stub().resolves(playing) };
      config.set('display.order', 'shuffle');

      await command.next({ query: ['ocean'] });
      const [, { random, matches }] = command.control.next.lastCall.args;
      expect(random).to.be.false;
      expect(matches.map(m => m.id)).to.deep.equal([ocean]);
      let caught; try { await command.next({ query: ['oceans'] }); } catch (error) { caught = error; }
      expect(caught.message).to.include('No search used the query "oceans"');
      expect(command.control.next.callCount).to.equal(1);
    });

    it('prints one line for current --line', async () => {
      const id = addVideo(1, 1920, 1080);
      command.control = { current: async () => ({ monitor: monitors[0], path: '/m/1.mp4', media: db.getMedia(id), rating: null }) };
      await command.current({ line: true });
      expect(lines).to.deep.equal([`#${id}\tvideo\t1920x1080\t\t\tlandscape\tunrated\tlocal\t\t/m/1.mp4`]);
    });

    it('shows what the target monitor plays after a mode switch, or only the mode when stopped', async () => {
      const id = addVideo(1, 1920, 1080);
      const switchTo = sinon.stub().callsFake(async (name, change) => (
        { monitor: monitors[1], path: '/m/1.mp4', media: db.getMedia(id), rating: null, result: await change() }
      ));
      command.control = { state: async () => ({}), switchTo,
        mode: async () => ({ mode: 'video', running: true, counts: { 'DP-1': 1, 'DP-2': 0 } }) };

      await command.mode('video', { monitor: 'DP-2', line: true });

      expect(switchTo.firstCall.args[0]).to.equal('DP-2');
      expect(lines).to.deep.equal(['Mode: video', '  DP-1: 1 items', '  DP-2: no videos at this resolution',
        `#${id}\tvideo\t1920x1080\t\t\tlandscape\tunrated\tlocal\t\t/m/1.mp4`]);

      lines.length = 0;
      command.control = { state: async () => null, mode: async () => ({ mode: 'image', running: false, counts: {} }) };
      await command.mode('image', {});
      expect(lines).to.deep.equal(['Mode: image']);
    });
  });

  it('prints the stored dim for the target monitor', async () => {
    command.control = { dim: sinon.stub().resolves({ monitor: { name: 'DP-2' }, dim: 30 }) };

    await command.dim('+10', { monitor: 'DP-2' });

    expect(command.control.dim.calledOnceWithExactly('+10', 'DP-2')).to.be.true;
    expect(lines).to.deep.equal(['DP-2: dim 30']);
  });
});
