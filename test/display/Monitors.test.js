import { expect } from 'chai';
import {
  parseMonitors, selectMonitors, missingMonitors, listMonitors, geometry, monitorAt, parsePointer, pointerMonitor
} from '../../src/display/Monitors.js';
import { LISTMONITORS_ONE, LISTMONITORS_TWO } from '../helpers/fakes.js';

describe('Monitors', () => {
  describe('parseMonitors', () => {
    it('parses name, size, offset and primary flag', () => {
      expect(parseMonitors(LISTMONITORS_TWO)).to.deep.equal([
        { name: 'DP-1', width: 2560, height: 1440, x: 0, y: 0, primary: true },
        { name: 'HDMI-1', width: 1080, height: 1920, x: 2560, y: 0, primary: false }
      ]);
    });

    it('handles negative offsets and no header', () => {
      expect(parseMonitors(' 0: +eDP-1 1920/344x1080/193+-1920+-200  eDP-1')).to.deep.equal([
        { name: 'eDP-1', width: 1920, height: 1080, x: -1920, y: -200, primary: false }
      ]);
    });

    it('returns nothing for output without monitors', () => {
      expect(parseMonitors('Monitors: 0\n')).to.deep.equal([]);
    });
  });

  describe('selectMonitors', () => {
    const monitors = parseMonitors(LISTMONITORS_TWO);

    it('returns all monitors for auto', () => {
      expect(selectMonitors(monitors, 'auto')).to.have.length(2);
      expect(selectMonitors(monitors, undefined)).to.have.length(2);
    });

    it('filters by configured names', () => {
      expect(selectMonitors(monitors, ['HDMI-1']).map(m => m.name)).to.deep.equal(['HDMI-1']);
      expect(selectMonitors(monitors, 'DP-1').map(m => m.name)).to.deep.equal(['DP-1']);
    });

    it('keeps the active configured monitors and reports the missing ones', () => {
      expect(selectMonitors(monitors, ['DP-1', 'DP-9']).map(m => m.name)).to.deep.equal(['DP-1']);
      expect(missingMonitors(monitors, ['DP-1', 'DP-9'])).to.deep.equal(['DP-9']);
      expect(missingMonitors(monitors, 'auto')).to.deep.equal([]);
      expect(selectMonitors(monitors, 'DP-9')).to.deep.equal([]);
    });
  });

  it('lists monitors through xrandr', async () => {
    const calls = [];
    const monitors = await listMonitors(async (file, args) => {
      calls.push([file, ...args]);
      return LISTMONITORS_ONE;
    });

    expect(calls).to.deep.equal([['xrandr', '--listactivemonitors']]);
    expect(monitors.map(m => m.name)).to.deep.equal(['DP-3']);
  });

  it('formats xwinwrap geometry', () => {
    expect(geometry({ width: 1080, height: 1920, x: 2560, y: -5 })).to.equal('1080x1920+2560+-5');
  });

  describe('pointer', () => {
    const monitors = parseMonitors(LISTMONITORS_TWO);

    it('finds the monitor containing a point, edges inclusive on the left only', () => {
      expect(monitorAt(monitors, 0, 0).name).to.equal('DP-1');
      expect(monitorAt(monitors, 2559, 1439).name).to.equal('DP-1');
      expect(monitorAt(monitors, 2560, 1500).name).to.equal('HDMI-1');
      expect(monitorAt(monitors, 2000, 1500)).to.be.null;
    });

    it('parses xdotool shell output', () => {
      expect(parsePointer('X=2016\nY=1049\nSCREEN=0\nWINDOW=1\n')).to.deep.equal({ x: 2016, y: 1049 });
      expect(() => parsePointer('nope')).to.throw('Cannot read pointer location');
    });

    it('returns the monitor under the pointer', async () => {
      const exec = async (file, args) => {
        expect([file, ...args]).to.deep.equal(['xdotool', 'getmouselocation', '--shell']);
        return 'X=3000\nY=100\n';
      };
      expect((await pointerMonitor(monitors, exec)).name).to.equal('HDMI-1');
    });
  });
});
