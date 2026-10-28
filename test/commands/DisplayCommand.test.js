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

    it('suggests importing when upscaling is allowed and the library is empty', async () => {
      config.set('display.allow_upscale', true);
      command.control = { current: async () => ({ path: null }) };

      await command.status();

      expect(lines.join('\n')).to.include('No videos in the library');
    });
  });

  it('prints the stored dim for the target monitor', async () => {
    command.control = { dim: sinon.stub().resolves({ monitor: { name: 'DP-2' }, dim: 30 }) };

    await command.dim('+10', { monitor: 'DP-2' });

    expect(command.control.dim.calledOnceWithExactly('+10', 'DP-2')).to.be.true;
    expect(lines).to.deep.equal(['DP-2: dim 30']);
  });
});
