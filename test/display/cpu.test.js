import { expect } from 'chai';
import { parseProcStat, readCpuSeconds, isSoftwareDecoder, isLargeVideo, cpuPercent } from '../../src/display/cpu.js';

describe('cpu', () => {
  it('reads user and system ticks from /proc stat, even with spaces in the command name', () => {
    const fields = 'S 1 2 3 4 5 6 7 8 9 10 250 50 0 0';
    expect(parseProcStat(`123 (mpv) ${fields}`)).to.equal(3);
    expect(parseProcStat(`123 (mpv (x) y) ${fields}`)).to.equal(3);
    expect(() => parseProcStat('garbage')).to.throw('Unexpected');
  });

  it('reads the stat file of a pid', async () => {
    expect(await readCpuSeconds(process.pid)).to.be.a('number');
  });

  it('classifies decoders, sizes and percentages', () => {
    expect(isSoftwareDecoder('no')).to.be.true;
    expect(isSoftwareDecoder('')).to.be.true;
    expect(isSoftwareDecoder('vaapi')).to.be.false;
    expect(isLargeVideo({ width: 1920, height: 1080 })).to.be.false;
    expect(isLargeVideo({ width: 2560, height: 1440 })).to.be.true;
    expect(cpuPercent(3, 60)).to.equal(5);
    expect(cpuPercent(0, 0)).to.be.null;
  });
});
