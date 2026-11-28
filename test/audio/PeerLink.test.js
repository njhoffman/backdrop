import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import sinon from 'sinon';
import { PeerLink, watchCommand } from '../../src/audio/PeerLink.js';

describe('PeerLink', () => {
  let children, states, warnings, clock;
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = signal => { child.killed = signal; };
    children.push({ file, args, child });
    return child;
  };
  const link = () => new PeerLink({
    host: 'minerva', spawn, firstDelay: 100, maxDelay: 200, now: () => clock.now,
    logger: { warn: (message, meta) => warnings.push([message, meta]) },
    onState: state => states.push(state)
  });
  const say = (line, index = -1) => children.at(index).child.stdout.write(`${line}\n`);

  beforeEach(() => {
    children = [];
    states = [];
    warnings = [];
    clock = sinon.useFakeTimers();
  });

  afterEach(() => clock.restore());

  it('runs the watch in a login shell on the peer', () => {
    expect(watchCommand('backdrop audio watch')).to.equal("bash -lc 'exec backdrop audio watch'");
    link().start();
    expect(children[0].file).to.equal('ssh');
    expect(children[0].args).to.include.members(['minerva', '--', "bash -lc 'exec backdrop audio watch'"]);
  });

  it('passes on each snapshot, leaving out lines of another protocol or not JSON', async () => {
    link().start();
    say('{"v":1,"host":"minerva","active":true,"player":"mpd","sink":"x","volume":40,"muted":false}');
    say('backdrop 3.7.0');
    say('{"v":2,"active":false}');
    say('{"v":1,"active":"yes"}');
    await clock.tickAsync(1);
    expect(states).to.deep.equal([{ host: 'minerva', active: true, player: 'mpd', sink: 'x', volume: 40, muted: false }]);
  });

  it('reports the peer gone when the session ends, and connects again with a growing delay', async () => {
    link().start();
    say('{"v":1,"active":true}');
    await clock.tickAsync(1);
    children[0].child.stderr.write('ssh: connect to host minerva port 22: No route to host\n');
    await clock.tickAsync(1);
    children[0].child.emit('exit', 255);
    expect(states.at(-1)).to.be.null;
    expect(warnings[0][1]).to.include({ host: 'minerva', error: 'ssh: connect to host minerva port 22: No route to host', delay: 100 });
    await clock.tickAsync(100);
    expect(children).to.have.length(2);
    // A connection that fails again reports null only once
    children[1].child.emit('exit', 255);
    expect(states.filter(state => state === null)).to.have.length(1);
    await clock.tickAsync(199);
    expect(children).to.have.length(2);
    await clock.tickAsync(1);
    expect(children).to.have.length(3);
  });

  it('reports the peer unreachable when the first connection fails', () => {
    link().start();
    children[0].child.emit('error', new Error('spawn ssh ENOENT'));
    expect(states).to.deep.equal([null]);
  });

  it('stops without connecting again', async () => {
    const peer = link();
    peer.start();
    peer.stop();
    expect(children[0].child.killed).to.equal('SIGTERM');
    children[0].child.emit('exit', null);
    await clock.tickAsync(1000);
    expect(children).to.have.length(1);
    expect(warnings).to.be.empty;
  });
});
