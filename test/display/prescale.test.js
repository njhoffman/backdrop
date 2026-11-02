import { expect } from 'chai';
import { prescaleFactor, prescaleFilter, loadMedia } from '../../src/display/prescale.js';
import { FakeMpvClient } from '../helpers/fakes.js';

const MONITOR = { name: 'DP-3', width: 1920, height: 1080 };
const image = (width, height) => ({ kind: 'image', path: '/m/1.jpg', width, height });

describe('prescale', () => {
  describe('prescaleFactor', () => {
    it('scales a huge portrait original so its shorter side covers the monitor\'s longer one', () => {
      expect(prescaleFactor(image(7499, 14998), MONITOR)).to.be.closeTo(1920 / 7499, 1e-9);
      expect(prescaleFactor(image(4340, 6597), MONITOR)).to.be.closeTo(1920 / 4340, 1e-9);
    });

    it('leaves images that keep at least half their pixels to mpv', () => {
      // 4K on 1080p keeps (1920 / 2160)^2, about 0.79
      expect(prescaleFactor(image(3840, 2160), MONITOR)).to.be.null;
      expect(prescaleFactor(image(1920, 1200), MONITOR)).to.be.null;
      expect(prescaleFactor(image(1280, 1024), MONITOR)).to.be.null;
      // Exactly half kept is not enough to bother
      expect(prescaleFactor(image(Math.floor(1920 * Math.SQRT2), 6000), MONITOR)).to.be.null;
    });

    it('is the same for either orientation of the stored size', () => {
      expect(prescaleFactor(image(14998, 7499), MONITOR)).to.equal(prescaleFactor(image(7499, 14998), MONITOR));
      const portrait = { name: 'DP-1', width: 1080, height: 1920 };
      expect(prescaleFactor(image(7499, 14998), portrait)).to.equal(prescaleFactor(image(7499, 14998), MONITOR));
    });

    it('never filters videos, GIFs or items without a known size', () => {
      expect(prescaleFactor({ kind: 'video', width: 7680, height: 4320 }, MONITOR)).to.be.null;
      expect(prescaleFactor({ kind: 'gif', width: 7680, height: 4320 }, MONITOR)).to.be.null;
      expect(prescaleFactor({ kind: 'image', width: null, height: 4320 }, MONITOR)).to.be.null;
      expect(prescaleFactor(image(7499, 14998), { name: 'X' })).to.be.null;
      expect(prescaleFactor(undefined, MONITOR)).to.be.null;
    });
  });

  describe('prescaleFilter', () => {
    it('rounds the factor up and the sizes up to even numbers, with no commas mpv would split on', () => {
      const filter = prescaleFilter(image(7499, 14998), MONITOR);
      expect(filter).to.equal('scale=w=ceil(iw*0.2561/2)*2:h=ceil(ih*0.2561/2)*2:flags=lanczos');
      expect(filter).to.not.include(',');
      // The decoded short side comes out at least as long as the monitor's long side
      expect(Math.ceil((7499 * 0.2561) / 2) * 2).to.be.at.least(1920);
    });

    it('is null when no prescale is needed', () => {
      expect(prescaleFilter(image(3840, 2160), MONITOR)).to.be.null;
    });
  });

  describe('loadMedia', () => {
    it('passes the prescale as a per-file option only when the item needs one', async () => {
      const client = new FakeMpvClient();
      await loadMedia(client, image(7499, 14998), 'append', MONITOR);
      await loadMedia(client, { ...image(3840, 2160), path: '/m/2.jpg' }, 'append-play', MONITOR);
      expect(client.commands).to.deep.equal([
        ['loadfile', '/m/1.jpg', 'append', -1, `vf=${prescaleFilter(image(7499, 14998), MONITOR)}`],
        ['loadfile', '/m/2.jpg', 'append-play']
      ]);
    });
  });
});
