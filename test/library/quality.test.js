import { expect } from 'chai';
import sinon from 'sinon';
import { targetResolution } from '../../src/library/quality.js';
import { parseMonitors } from '../../src/display/Monitors.js';
import { makeConfig, LISTMONITORS_TWO } from '../helpers/fakes.js';

describe('targetResolution', () => {
  const active = async () => parseMonitors(LISTMONITORS_TWO);
  let warnings;
  beforeEach(() => {
    warnings = [];
    sinon.stub(console, 'error').callsFake(line => warnings.push(line));
  });
  afterEach(() => sinon.restore());

  it('takes the largest width and height of the selected monitors', async () => {
    expect(await targetResolution(makeConfig(), undefined, active)).to.deep.equal({ width: 2560, height: 1920 });
  });

  it('sizes for the configured monitors that are active and warns about the rest', async () => {
    const config = makeConfig({ 'display.monitors': ['DP-1', 'DP-9'] });
    expect(await targetResolution(config, undefined, active)).to.deep.equal({ width: 2560, height: 1440 });
    expect(warnings.join('\n')).to.include('Configured monitors not active: DP-9; sizing for DP-1');
  });

  it('fails when no configured monitor is active, unless upscaling is allowed', async () => {
    const config = makeConfig({ 'display.monitors': ['DP-9'] });
    let caught;
    try { await targetResolution(config, undefined, active); } catch (error) { caught = error; }
    expect(caught.message).to.include('configured monitors not active: DP-9').and.include('--resolution');
    config.set('display.allow_upscale', true);
    expect(await targetResolution(config, undefined, active)).to.deep.equal({ width: 1, height: 1 });
  });

  it('prefers an explicit resolution', async () => {
    expect(await targetResolution(makeConfig(), '1920x1080', active)).to.deep.equal({ width: 1920, height: 1080 });
  });
});
