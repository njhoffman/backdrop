import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { AudioWatcher } from '../../src/visualizer/audio.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('AudioWatcher', () => {
  let state, children, changes, warnings, execError;
  // pactl as PipeWire's pulse server answers it, with the default output's state in `state`
  const exec = async (file, args) => {
    if (execError) throw execError;
    if (args[0] === 'get-default-sink') return 'bluez_output.AC_BF.1\n';
    if (args.join(' ') === 'list short sinks') {
      return `98\talsa_output.hdmi\tPipeWire\ts24-32le 2ch 48000Hz\tSUSPENDED\n128\tbluez_output.AC_BF.1\tPipeWire\ts16le 2ch 48000Hz\t${state}\n`;
    }
    if (args.join(' ') === 'list short sources') return '50\talsa_input.mic\tPipeWire\ts16le 2ch 48000Hz\tRUNNING\n';
    throw new Error(`unexpected pactl ${args.join(' ')}`);
  };
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push({ file, args, child });
    return child;
  };
  const watcher = (options = {}) => new AudioWatcher({
    exec, spawn, grace: 30, recheckDelay: 1, restartDelay: 5,
    logger: { warn: (message, meta) => warnings.push([message, meta]) },
    onChange: playing => changes.push(playing), ...options
  });
  const event = (child, line) => child.stdout.write(`${line}\n`);

  beforeEach(() => {
    state = 'RUNNING';
    children = [];
    changes = [];
    warnings = [];
    execError = null;
  });

  it('reads the default output at start and follows it, reporting silence only after the grace period', async () => {
    const audio = watcher();
    expect(await audio.start()).to.be.true;
    expect(children[0]).to.deep.include({ file: 'pactl', args: ['subscribe'] });
    const { child } = children[0];

    state = 'IDLE';
    event(child, "Event 'change' on sink #128");
    await pause(10);
    expect(changes).to.deep.equal([]);
    // Sound again within the grace period: no change at all
    state = 'RUNNING';
    event(child, "Event 'change' on sink-input #150");
    await pause(40);
    expect(changes).to.deep.equal([]);

    state = 'SUSPENDED';
    event(child, "Event 'change' on sink #128");
    await pause(50);
    expect(changes).to.deep.equal([false]);
    // Events about other things are ignored
    state = 'RUNNING';
    event(child, "Event 'new' on client #77");
    await pause(10);
    expect(changes).to.deep.equal([false]);
    event(child, "Event 'change' on server #-1");
    await pause(10);
    expect(changes).to.deep.equal([false, true]);
    audio.stop();
    expect(child.killed).to.be.true;
  });

  it('checks a named sink through its monitor source, or a source by name', async () => {
    expect(await watcher({ source: 'alsa_output.hdmi.monitor' }).check()).to.be.false;
    expect(await watcher({ source: 'alsa_input.mic' }).check()).to.be.true;
  });

  it('assumes sound when pactl fails or the source is unknown, warning once', async () => {
    execError = new Error('spawn pactl ENOENT');
    const audio = watcher();
    expect(await audio.check()).to.be.true;
    expect(await audio.check()).to.be.true;
    expect(warnings).to.have.length(1);
    expect(warnings[0][0]).to.equal('Cannot read the audio state, assuming it plays');
    execError = null;
    expect(await watcher({ source: 'nothing.monitor' }).check()).to.be.true;
  });

  it('watches again when pactl subscribe exits, until stopped', async () => {
    const audio = watcher();
    await audio.start();
    children[0].child.emit('exit', 1);
    await pause(10);
    expect(children).to.have.length(2);
    audio.stop();
    children[1].child.emit('exit', null);
    await pause(10);
    expect(children).to.have.length(2);
  });
});
