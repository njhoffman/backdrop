import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import sinon from 'sinon';
import { RelayPipe, recordCommand, relayModules } from '../../src/audio/RelayPipe.js';

const MODULES_WITH_SINK = '12\tmodule-null-sink\tsink_name=backdrop_relay sink_properties=device.description=x\t\n13\tmodule-remap-source\tmaster=x\t\n';

describe('RelayPipe', () => {
  let children, calls, modules, clock, warnings;
  const exec = async (file, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'list') return modules;
    if (args[0] === 'load-module') modules = MODULES_WITH_SINK;
    if (args[0] === 'unload-module') modules = '';
    return '';
  };
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = signal => { child.killed = signal; };
    children.push({ file, args, child });
    return child;
  };
  const pipe = () => new RelayPipe({
    host: 'charon', exec, spawn, firstDelay: 100, maxDelay: 300, now: () => clock.now,
    logger: { info() {}, debug() {}, warn: (message, meta) => warnings.push([message, meta]) }
  });

  beforeEach(() => {
    children = [];
    calls = [];
    modules = '';
    warnings = [];
    clock = sinon.useFakeTimers();
  });

  afterEach(() => clock.restore());

  it('finds its own null sink among the modules', () => {
    expect(relayModules(MODULES_WITH_SINK)).to.deep.equal(['12']);
    expect(relayModules('14\tmodule-null-sink\tsink_name=backdrop_relay_other\t\n')).to.deep.equal([]);
    expect(relayModules('')).to.deep.equal([]);
  });

  it('records the monitor of the server sink with a short latency', () => {
    expect(recordCommand("bluez_output.AC'BF.1")).to.equal(
      "exec parec -d 'bluez_output.AC'\\''BF.1.monitor' --format=s16le --rate=48000 --channels=2 --latency-msec=20"
    );
  });

  it('makes the sink, then pipes ssh parec into pacat on it', async () => {
    const relay = pipe();
    await relay.start('bluez_output.1');
    expect(calls.find(call => call.startsWith('load-module'))).to.match(/^load-module module-null-sink sink_name=backdrop_relay /);
    expect(children.map(child => child.file)).to.deep.equal(['ssh', 'pacat']);
    const ssh = children[0].args;
    expect(ssh).to.include.members(['-T', 'BatchMode=yes', 'charon', '--']);
    expect(ssh.at(-1)).to.equal(recordCommand('bluez_output.1'));
    expect(children[1].args).to.include.members(['--playback', '-d', 'backdrop_relay', '--latency-msec=20']);

    // Bytes from ssh reach pacat
    const received = [];
    children[1].child.stdin.on('data', chunk => received.push(String(chunk)));
    children[0].child.stdout.write('pcm');
    await clock.tickAsync(1);
    expect(received.join('')).to.equal('pcm');
  });

  it('keeps a sink a killed daemon left, and starts again on a new sink only when it moves', async () => {
    modules = MODULES_WITH_SINK;
    const relay = pipe();
    await relay.start('a');
    await relay.start('a');
    expect(calls.filter(call => call.startsWith('load-module'))).to.be.empty;
    expect(children).to.have.length(2);
    await relay.start('b');
    expect(children).to.have.length(4);
    expect(children[0].child.killed).to.equal('SIGTERM');
    expect(children[2].args.at(-1)).to.equal(recordCommand('b'));
  });

  it('starts again after the pipe ends, waiting longer each time', async () => {
    const relay = pipe();
    await relay.start('a');
    children[0].child.emit('exit', 255);
    expect(children[1].child.killed).to.equal('SIGTERM');
    await clock.tickAsync(99);
    expect(children).to.have.length(2);
    await clock.tickAsync(1);
    expect(children).to.have.length(4);
    children[3].child.emit('exit', 1);
    await clock.tickAsync(199);
    expect(children).to.have.length(4);
    await clock.tickAsync(1);
    expect(children).to.have.length(6);
    expect(warnings.map(([message]) => message)).to.deep.equal(['Audio relay ended, starting it again', 'Audio relay ended, starting it again']);
  });

  it('stops the pipe and removes the sink, starting nothing after', async () => {
    const relay = pipe();
    await relay.start('a');
    await relay.stop();
    expect(children.every(child => child.child.killed === 'SIGTERM')).to.be.true;
    expect(calls.at(-1)).to.equal('unload-module 12');
    children[0].child.emit('exit', null);
    await clock.tickAsync(1000);
    expect(children).to.have.length(2);
    expect(warnings).to.be.empty;
  });
});
