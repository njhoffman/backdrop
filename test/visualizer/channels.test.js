import { expect } from 'chai';
import { ChannelSources, channelSource } from '../../src/visualizer/channels.js';

describe('ChannelSources', () => {
  let calls, modules, failing, warnings;
  const MASTER = 'bluez_output.AC.1.monitor';
  const exec = async (file, args) => {
    calls.push(args.join(' '));
    if (failing) throw new Error('pactl: Connection refused');
    if (args[0] === 'get-default-sink') return 'bluez_output.AC.1\n';
    if (args.join(' ') === 'list short modules') return modules.map(([id, name, line]) => `${id}\t${name}\t${line}`).join('\n');
    if (args[0] === 'unload-module') modules = modules.filter(([id]) => id !== args[1]);
    if (args[0] === 'load-module') modules.push([String(100 + modules.length), args[1], args.slice(2).join(' ')]);
    return '';
  };
  const sources = () => new ChannelSources({ exec, logger: { info() {}, warn: message => warnings.push(message) } });
  const loads = () => calls.filter(call => call.startsWith('load-module'));

  beforeEach(() => {
    calls = [];
    modules = [['7', 'module-null-sink', 'sink_name=other']];
    failing = false;
    warnings = [];
  });

  it('makes a mono remap source of each wanted channel from the default output\'s monitor', async () => {
    const ready = await sources().sync(['left', 'right', 'both'], 'auto');
    expect([...ready]).to.deep.equal(['left', 'right']);
    expect(loads()).to.deep.equal([
      `load-module module-remap-source master=${MASTER} source_name=backdrop_left channels=1 master_channel_map=front-left channel_map=mono source_properties=device.description=backdrop-left`,
      `load-module module-remap-source master=${MASTER} source_name=backdrop_right channels=1 master_channel_map=front-right channel_map=mono source_properties=device.description=backdrop-right`
    ]);
    expect(channelSource('left')).to.equal('backdrop_left');
  });

  it('reuses one still loaded from the same output, and replaces one from another or no longer wanted', async () => {
    modules.push(['20', 'module-remap-source', `master=${MASTER} source_name=backdrop_left channels=1`]);
    modules.push(['21', 'module-remap-source', 'master=old.monitor source_name=backdrop_right channels=1']);
    const ready = await sources().sync(['left', 'right'], 'auto');
    expect([...ready].sort()).to.deep.equal(['left', 'right']);
    expect(calls).to.include('unload-module 21');
    expect(calls).to.not.include('unload-module 20');
    expect(loads()).to.have.length(1);

    // Nothing wanted: every one of its own goes, others' modules stay
    await sources().release();
    expect(modules.map(([id]) => id)).to.deep.equal(['7']);
  });

  it('takes a named source as the master, and asks nothing when none is wanted', async () => {
    await sources().sync(['right'], 'alsa_output.hdmi.monitor');
    expect(loads()[0]).to.include('master=alsa_output.hdmi.monitor');
    expect(calls).to.not.include('get-default-sink');
  });

  it('leaves out what it cannot make, warning once', async () => {
    failing = true;
    const made = sources();
    expect([...await made.sync(['left'], 'auto')]).to.deep.equal([]);
    expect([...await made.sync(['left'], 'auto')]).to.deep.equal([]);
    expect(warnings).to.have.length(1);
  });

  it('clears remap sources left from before and says nothing without a sound server', async () => {
    modules.push(['41', 'module-remap-source', `master=${MASTER} source_name=backdrop_left channels=1`]);
    await sources().clear();
    expect(calls).to.include('unload-module 41');
    expect(modules.map(([id]) => id)).to.deep.equal(['7']);

    failing = true;
    await sources().clear();
    expect(warnings).to.deep.equal([]);
  });
});
