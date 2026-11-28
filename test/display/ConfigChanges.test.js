import { expect } from 'chai';
import { ConfigChanges } from '../../src/display/daemon/ConfigChanges.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('ConfigChanges.applySettings', () => {
  let config, daemon, calls;

  beforeEach(() => {
    config = makeConfig();
    calls = [];
    daemon = {
      config, logger: silentLogger,
      writeState: async () => { calls.push('writeState'); },
      audioRelay: { reconfigure: async () => { calls.push('audioRelay'); } },
      load: { reconfigure: async () => { calls.push('load'); } }
    };
  });

  const saved = change => {
    const next = structuredClone(config.get());
    change(next);
    return new ConfigChanges(daemon).applySettings(next);
  };

  it('takes a saved offload change in, for the next job and host check, with no restart', async () => {
    const { applied, restart } = await saved(next => {
      next.offload.hosts = ['minerva'];
      next.offload.memory_max = '2G';
    });
    expect(config.get().offload).to.include({ memory_max: '2G' });
    expect(config.get().offload.hosts).to.deep.equal(['minerva']);
    expect(restart).to.deep.equal([]);
    expect(applied).to.deep.equal([]);
  });

  it('starts the audio relay again on a change to its section, and only then', async () => {
    await saved(next => { next.offload.hosts = ['minerva']; });
    expect(calls).to.not.include('audioRelay');
    await saved(next => {
      next.audio_relay.enabled = true;
      next.audio_relay.peer = 'charon';
    });
    expect(calls).to.include('audioRelay');
    expect(config.get().audio_relay).to.include({ enabled: true, peer: 'charon' });
  });
});
