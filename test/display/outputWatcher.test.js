import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import sinon from 'sinon';
import { OutputWatcher } from '../../src/display/outputWatcher.js';

const FIRST = '{"first":true,"payload":""}';
const OUTPUT = '{"change":"unspecified"}';

describe('OutputWatcher', () => {
  let clock, children, changes, warnings, watcher;

  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.file = file;
    child.args = args;
    child.stdout = new PassThrough();
    child.kill = sinon.spy();
    children.push(child);
    return child;
  };
  const say = async (...lines) => {
    for (const line of lines) children.at(-1).stdout.write(`${line}\n`);
    await clock.tickAsync(0);
  };

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    children = [];
    changes = 0;
    warnings = [];
    watcher = new OutputWatcher({ spawn, logger: { warn: message => warnings.push(message) }, onChange: () => { changes++; }, settle: 500, restartDelay: 5000 });
  });

  afterEach(() => {
    watcher.stop();
    clock.restore();
  });

  it('subscribes to output and tick events, and is connected from the first tick on', async () => {
    watcher.start();
    expect(children[0].file).to.equal('i3-msg');
    expect(children[0].args).to.deep.equal(['-t', 'subscribe', '-m', '["output","tick"]']);
    expect(watcher.connected).to.equal(false);
    await say(FIRST);
    expect(watcher.connected).to.equal(true);
    // The first subscription's tick is not a change
    await clock.tickAsync(1000);
    expect(changes).to.equal(0);
  });

  it('reports a burst of output events once they settle', async () => {
    watcher.start();
    await say(FIRST, OUTPUT, OUTPUT);
    await clock.tickAsync(300);
    await say(OUTPUT);
    await clock.tickAsync(499);
    expect(changes).to.equal(0);
    await clock.tickAsync(1);
    expect(changes).to.equal(1);
  });

  it('ignores ticks other clients send, lines that are not JSON, and events before it is connected', async () => {
    watcher.start();
    await say(OUTPUT);
    await say(FIRST, '{"first":false,"payload":"probe"}', 'not json', '', '[]');
    await clock.tickAsync(1000);
    expect(changes).to.equal(0);
  });

  it('is disconnected after a failed subscription reply', async () => {
    watcher.start();
    await say(FIRST, '{"success":false}');
    expect(watcher.connected).to.equal(false);
    await say(OUTPUT);
    await clock.tickAsync(1000);
    expect(changes).to.equal(0);
  });

  it('subscribes again after i3-msg ends, disconnected meanwhile, and reports a change when it is back', async () => {
    watcher.start();
    await say(FIRST);
    children[0].emit('exit', 0);
    expect(watcher.connected).to.equal(false);
    await clock.tickAsync(4999);
    expect(children).to.have.length(1);
    await clock.tickAsync(1);
    expect(children).to.have.length(2);
    await say(FIRST);
    expect(watcher.connected).to.equal(true);
    await clock.tickAsync(500);
    expect(changes).to.equal(1);
  });

  it('warns once without i3-msg and keeps trying', async () => {
    watcher.start();
    const missing = Object.assign(new Error('spawn i3-msg ENOENT'), { code: 'ENOENT' });
    children[0].emit('error', missing);
    children[0].emit('exit', null);
    await clock.tickAsync(5000);
    children[1].emit('error', missing);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.match(/polling xrandr/);
    expect(watcher.connected).to.equal(false);
  });

  it('stops for good: kills i3-msg, drops a pending change, and does not subscribe again', async () => {
    watcher.start();
    await say(FIRST, OUTPUT);
    watcher.stop();
    expect(children[0].kill.calledWith('SIGTERM')).to.equal(true);
    expect(watcher.connected).to.equal(false);
    children[0].emit('exit', null);
    await clock.tickAsync(10_000);
    expect(changes).to.equal(0);
    expect(children).to.have.length(1);
  });
});
