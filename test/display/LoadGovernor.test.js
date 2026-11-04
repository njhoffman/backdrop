import { expect } from 'chai';
import { LoadGovernor } from '../../src/display/LoadGovernor.js';

describe('LoadGovernor', () => {
  let settings;
  let load;
  let time;
  let governor;

  // A reading at the second given, with the load given
  const at = (seconds, value) => {
    time = seconds * 1000;
    load = value;
    return governor.check();
  };

  beforeEach(() => {
    settings = { enabled: true, window: 1, image_above: 10, off_above: 20, resume_ratio: 0.5, sustain: 60, resume_after: 300 };
    load = 0;
    time = 0;
    governor = new LoadGovernor({ settings: () => settings, loadavg: () => [load, load / 2, load / 4], now: () => time });
  });

  it('ignores a burst shorter than sustain', () => {
    expect(at(0, 15)).to.equal('normal');
    expect(at(30, 15)).to.equal('normal');
    expect(at(45, 5)).to.equal('normal');
    expect(at(60, 15)).to.equal('normal');
    expect(at(90, 15)).to.equal('normal');
  });

  it('drops to images once load has held over the threshold for sustain', () => {
    at(0, 15);
    expect(at(59, 15)).to.equal('normal');
    expect(at(60, 15)).to.equal('image');
  });

  it('drops straight to off from normal', () => {
    at(0, 25);
    expect(at(60, 25)).to.equal('off');
  });

  it('times each threshold separately', () => {
    at(0, 15);
    expect(at(60, 25)).to.equal('image');
    expect(at(119, 25)).to.equal('image');
    expect(at(120, 25)).to.equal('off');
  });

  it('stays down in the band between the resume level and the threshold', () => {
    at(0, 15);
    at(60, 15);
    expect(at(120, 8)).to.equal('image');
    expect(at(1000, 8)).to.equal('image');
  });

  it('recovers after resume_after under the resume level, and a rise restarts the wait', () => {
    at(0, 15);
    at(60, 15);
    at(100, 4);
    expect(at(399, 4)).to.equal('image');
    at(400, 8);
    at(700, 4);
    expect(at(999, 4)).to.equal('image');
    expect(at(1000, 4)).to.equal('normal');
  });

  it('recovers one step at a time, waiting again at each', () => {
    at(0, 25);
    at(60, 25);
    at(100, 2);
    expect(at(400, 2)).to.equal('image');
    expect(at(415, 2)).to.equal('image');
    expect(at(714, 2)).to.equal('image');
    expect(at(715, 2)).to.equal('normal');
  });

  it('stays on images when load falls only under the off resume level', () => {
    at(0, 25);
    at(60, 25);
    at(100, 9);
    expect(at(400, 9)).to.equal('image');
    expect(at(2000, 9)).to.equal('image');
  });

  it('skips a step without a threshold, both ways', () => {
    settings.image_above = null;
    at(0, 15);
    expect(at(60, 15)).to.equal('normal');
    at(100, 25);
    expect(at(160, 25)).to.equal('off');
    at(200, 2);
    expect(at(500, 2)).to.equal('normal');
  });

  it('never drops with both thresholds null', () => {
    Object.assign(settings, { image_above: null, off_above: null });
    at(0, 500);
    expect(at(1000, 500)).to.equal('normal');
  });

  it('reads the configured window', () => {
    settings.window = 5;
    at(0, 25);
    expect(governor.value).to.equal(12.5);
    settings.window = 15;
    at(1, 40);
    expect(governor.value).to.equal(10);
  });

  it('begin applies the load now without waiting', () => {
    load = 25;
    expect(governor.begin()).to.equal('off');
    load = 15;
    expect(governor.begin()).to.equal('image');
    load = 1;
    expect(governor.begin()).to.equal('normal');
  });

  it('turning off ends any level at once', () => {
    load = 25;
    governor.begin();
    settings.enabled = false;
    expect(governor.check()).to.equal('normal');
    expect(governor.summary()).to.equal(null);
  });

  it('rounds the level it recovers under', () => {
    Object.assign(settings, { image_above: 7, resume_ratio: 0.7 });
    load = 15;
    governor.begin();
    expect(governor.summary().resume_below).to.equal(4.9);
  });

  it('summarizes the level and what ends it', () => {
    load = 15;
    governor.begin();
    expect(governor.summary()).to.deep.equal({ level: 'image', value: 15, window: 1, limit: 10, resume_below: 5 });
    load = 1;
    governor.begin();
    expect(governor.summary()).to.deep.equal({ level: 'normal', value: 1, window: 1, limit: 10, resume_below: null });
  });
});
