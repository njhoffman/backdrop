import { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { DisplayControl, parseSpeed, parseDim } from '../../src/display/DisplayControl.js';
import { statePath } from '../../src/display/Daemon.js';
import { getMode, setMode } from '../../src/display/Playlist.js';
import { FakeMpvClient, makeConfig } from '../helpers/fakes.js';

const MONITORS = [
  { name: 'DP-1', width: 2560, height: 1440, x: 0, y: 0, primary: true },
  { name: 'HDMI-1', width: 1080, height: 1920, x: 2560, y: 0, primary: false }
];

describe('DisplayControl', () => {
  describe('parseSpeed', () => {
    it('accepts absolute values', () => {
      expect(parseSpeed('0.8', 1)).to.equal(0.8);
      expect(parseSpeed('2', 1)).to.equal(2);
      expect(parseSpeed('.5', 1)).to.equal(0.5);
    });

    it('applies relative steps to the current speed, rounding float noise', () => {
      expect(parseSpeed('+0.1', 0.7)).to.equal(0.8);
      expect(parseSpeed('-0.25', 1)).to.equal(0.75);
      expect(parseSpeed('-.1', 0.3)).to.equal(0.2);
    });

    it('resets to 1', () => {
      expect(parseSpeed('reset', 0.4)).to.equal(1);
    });

    it('rejects anything else', () => {
      for (const bad of ['fast', '', '1.2.3', '+', '--1']) {
        expect(() => parseSpeed(bad, 1), bad).to.throw('Invalid speed');
      }
    });
  });

  describe('parseDim', () => {
    it('accepts absolute amounts, clamped steps and reset', () => {
      expect(parseDim('30', 0)).to.equal(30);
      expect(parseDim('+10', 30)).to.equal(40);
      expect(parseDim('-10', 30)).to.equal(20);
      expect(parseDim('+50', 80)).to.equal(100);
      expect(parseDim('-50', 20)).to.equal(0);
      expect(parseDim('reset', 60)).to.equal(0);
    });

    it('rejects values outside 0-100 and anything else', () => {
      for (const bad of ['101', '-', '1.5', 'dark', '', '+']) {
        expect(() => parseDim(bad, 0), bad).to.throw('Invalid dim');
      }
    });
  });

  describe('with a running daemon', () => {
    let tempDir;
    let db;
    let control;
    let clients;
    let pointer;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-control-'));
      db = new DatabaseManager();
      db.initialize(':memory:');
      clients = new Map();
      pointer = 'X=10\nY=10\n';

      const monitors = MONITORS.map(m => ({ ...m, socket: path.join(tempDir, `${m.name}.sock`) }));
      await fs.writeJson(statePath(tempDir), { pid: process.pid, monitors });

      control = new DisplayControl({
        config: makeConfig({ 'paths.runtime': tempDir }),
        database: db,
        exec: async () => pointer,
        connect: async socketPath => {
          if (!clients.has(socketPath)) {
            clients.set(socketPath, new FakeMpvClient());
          }
          return clients.get(socketPath);
        }
      });
    });

    afterEach(async () => {
      db.close();
      await fs.remove(tempDir);
    });

    const clientFor = name => {
      const socketPath = path.join(tempDir, `${name}.sock`);
      if (!clients.has(socketPath)) {
        clients.set(socketPath, new FakeMpvClient());
      }
      return clients.get(socketPath);
    };

    describe('targetMonitor', () => {
      it('uses the monitor under the pointer', async () => {
        pointer = 'X=3000\nY=500\n';
        expect((await control.targetMonitor()).name).to.equal('HDMI-1');
      });

      it('falls back to the primary monitor when the pointer is outside all monitors', async () => {
        pointer = 'X=2000\nY=1600\n';
        expect((await control.targetMonitor()).name).to.equal('DP-1');
      });

      it('uses a named monitor and rejects unknown names', async () => {
        expect((await control.targetMonitor('HDMI-1')).name).to.equal('HDMI-1');
        try {
          await control.targetMonitor('DP-9');
          expect.fail('should have thrown');
        } catch (error) {
          expect(error.message).to.include('Monitor DP-9 is not managed');
        }
      });
    });

    it('reports the current item with its latest rating', async () => {
      const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4' });
      db.addRating(id, 3);
      clientFor('DP-1').properties.path = '/m/v.mp4';

      const current = await control.current();

      expect(current.monitor.name).to.equal('DP-1');
      expect(current.media.id).to.equal(id);
      expect(current.rating.rating).to.equal(3);
      expect(clientFor('DP-1').closed).to.be.true;
    });

    it('reports nothing playing when mpv is idle', async () => {
      const current = await control.current('HDMI-1');
      expect(current.path).to.be.null;
      expect(current.media).to.be.null;
    });

    it('moves forward and back in the playlist', async () => {
      await control.next();
      await control.prev('HDMI-1');

      expect(clientFor('DP-1').commands).to.deep.equal([['playlist-next', 'force']]);
      expect(clientFor('HDMI-1').commands).to.deep.equal([['playlist-prev', 'force']]);
    });

    describe('speed', () => {
      it('changes the playing video now and stores it', async () => {
        const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4', speed: 0.7 });
        clientFor('DP-1').properties.path = '/m/v.mp4';

        const { speed } = await control.speed('+0.1');

        expect(speed).to.equal(0.8);
        expect(db.getMedia(id).speed).to.equal(0.8);
        expect(clientFor('DP-1').properties.speed).to.equal(0.8);
      });

      it('refuses images, idle monitors and out-of-range values', async () => {
        db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/i.png' });
        db.addMedia({ kind: 'gif', source: 'local', source_id: 2, path: '/m/g.gif' });
        clientFor('DP-1').properties.path = '/m/i.png';
        clientFor('HDMI-1').properties.path = '/m/g.gif';

        const failure = async (...args) => {
          try {
            await control.speed(...args);
            return null;
          } catch (error) {
            return error.message;
          }
        };

        expect(await failure('0.5')).to.equal('Speed only applies to videos and GIFs');
        expect(await failure('200', 'HDMI-1')).to.include('Speed must be');
        expect(clientFor('HDMI-1').properties).to.not.have.property('speed');
        delete clientFor('DP-1').properties.path;
        expect(await failure('0.5')).to.include('Nothing from the library is playing');
      });

      it('accepts speed changes on GIFs', async () => {
        db.addMedia({ kind: 'gif', source: 'local', source_id: 1, path: '/m/g.gif' });
        clientFor('DP-1').properties.path = '/m/g.gif';
        expect((await control.speed('2')).speed).to.equal(2);
      });
    });

    describe('dim', () => {
      it('dims the playing image or video now as negative brightness and stores it', async () => {
        const image = db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/i.png' });
        clientFor('DP-1').properties.path = '/m/i.png';

        expect((await control.dim('30')).dim).to.equal(30);
        expect(db.getMedia(image).dim).to.equal(30);
        expect(clientFor('DP-1').properties.brightness).to.equal(-30);

        await control.dim('reset');
        expect(clientFor('DP-1').properties.brightness).to.equal(0);
        expect(db.getMedia(image).dim).to.equal(0);
      });

      it('refuses idle monitors', async () => {
        let message;
        try { await control.dim('10'); } catch (error) { message = error.message; }
        expect(message).to.include('Nothing from the library is playing');
      });
    });

    describe('appendMedia', () => {
      it('appends to every monitor in the current mode', async () => {
        const id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4', width: 4000, height: 4000 });

        expect(await control.appendMedia([id])).to.deep.equal({ 'DP-1': 1, 'HDMI-1': 1 });
        expect(clientFor('DP-1').commands).to.deep.equal([['get_property', 'playlist'], ['loadfile', '/m/v.mp4', 'append-play']]);
      });

      it('skips connecting when there is nothing to add', async () => {
        expect(await control.appendMedia([])).to.deep.equal({});
        expect(clients.size).to.equal(0);
      });
    });

    describe('removeMedia', () => {
      it('removes every occurrence from every monitor, in descending index order', async () => {
        clientFor('DP-1').properties.playlist = [
          { filename: '/m/a.mp4', current: true },
          { filename: '/m/b.mp4' },
          { filename: '/m/a.mp4' }
        ];
        clientFor('HDMI-1').properties.playlist = [{ filename: '/m/a.mp4', current: true }];

        await control.removeMedia({ path: '/m/a.mp4' });

        expect(clientFor('DP-1').commands.filter(cmd => cmd[0] === 'playlist-remove'))
          .to.deep.equal([['playlist-remove', 2], ['playlist-remove', 0]]);
        expect(clientFor('HDMI-1').commands.filter(cmd => cmd[0] === 'playlist-remove'))
          .to.deep.equal([['playlist-remove', 0]]);
        expect(clientFor('DP-1').closed).to.be.true;
        expect(clientFor('HDMI-1').closed).to.be.true;
      });

      it('leaves unrelated playlist entries alone', async () => {
        for (const name of ['DP-1', 'HDMI-1']) {
          clientFor(name).properties.playlist = [{ filename: '/m/other.mp4' }];
        }
        await control.removeMedia({ path: '/m/a.mp4' });
        for (const name of ['DP-1', 'HDMI-1']) {
          expect(clientFor(name).commands.some(cmd => cmd[0] === 'playlist-remove')).to.be.false;
        }
      });
    });

    describe('mode', () => {
      it('toggles and reloads every monitor', async () => {
        db.addMedia({ kind: 'image', source: 'local', source_id: 1, path: '/m/i.png', width: 4000, height: 4000 });

        const result = await control.mode();

        expect(result).to.deep.equal({ mode: 'image', running: true, counts: { 'DP-1': 1, 'HDMI-1': 1 } });
        expect(getMode(db)).to.equal('image');
        for (const name of ['DP-1', 'HDMI-1']) {
          expect(clientFor(name).commands.some(cmd => cmd[0] === 'loadlist')).to.be.true;
        }
      });

      it('sets an explicit mode', async () => {
        setMode(db, 'image');
        expect((await control.mode('image')).mode).to.equal('image');
        expect((await control.mode('video')).mode).to.equal('video');
      });

      it('rejects unknown modes without changing the stored one', async () => {
        try {
          await control.mode('slideshow');
          expect.fail('should have thrown');
        } catch (error) {
          expect(error.message).to.include('Unknown mode: slideshow');
        }
        expect(getMode(db)).to.equal('video');
      });
    });
  });

  describe('without a running daemon', () => {
    let tempDir;
    let db;
    let control;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-control-'));
      db = new DatabaseManager();
      db.initialize(':memory:');
      control = new DisplayControl({ config: makeConfig({ 'paths.runtime': tempDir }), database: db });
    });

    afterEach(async () => {
      db.close();
      await fs.remove(tempDir);
    });

    it('has nothing to append to', async () => {
      expect(await control.appendMedia([1])).to.deep.equal({});
    });

    it('can remove library media without a running daemon', async () => {
      await control.removeMedia({ path: '/m/a.mp4' });
      await control.removeMedia({ path: null });
    });

    it('still stores the mode', async () => {
      expect(await control.mode()).to.deep.equal({ mode: 'image', running: false, counts: {} });
      expect(getMode(db)).to.equal('image');
    });

    it('explains that the daemon must be started for playback commands', async () => {
      try {
        await control.next();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('backdrop daemon is not running');
      }
    });
  });
});
