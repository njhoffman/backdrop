import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import sinon from 'sinon';
import { MusicWatcher } from '../../src/audio/MusicWatcher.js';

describe('MusicWatcher', () => {
  let playing, volume, children, changes, warnings, execError, clock;
  const exec = async (file, args) => {
    if (execError) throw execError;
    if (args.includes('sink-inputs')) {
      return JSON.stringify(playing ? [{ index: 1, sink: 130, corked: false, properties: { 'application.name': 'spotify' } }] : []);
    }
    if (args.includes('sinks')) {
      return JSON.stringify([{ index: 130, name: 'bluez', mute: false, volume: { 'front-left': { value_percent: `${volume}%` } } }]);
    }
    return 'bluez\n';
  };
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push({ file, args, child });
    return child;
  };
  const watcher = () => new MusicWatcher({
    players: ['spotify'], grace: 1000, recheckDelay: 10, restartDelay: 50, exec, spawn,
    logger: { warn: (message, meta) => warnings.push([message, meta]) },
    onChange: snapshot => changes.push(snapshot)
  });
  const event = line => children.at(-1).child.stdout.write(`${line}\n`);
  const tick = ms => clock.tickAsync(ms);

  beforeEach(() => {
    playing = false;
    volume = 54;
    children = [];
    changes = [];
    warnings = [];
    execError = null;
    clock = sinon.useFakeTimers();
  });

  afterEach(() => clock.restore());

  it('reports music at once and its end only after the grace, unless it comes back', async () => {
    const music = watcher();
    expect(await music.start()).to.include({ active: false });
    expect(children[0]).to.deep.include({ file: 'pactl', args: ['subscribe'] });
    expect(changes.map(change => change.active)).to.deep.equal([false]);

    playing = true;
    event("Event 'new' on sink-input #150");
    await tick(20);
    expect(changes.map(change => change.active)).to.deep.equal([false, true]);
    expect(changes[1]).to.include({ player: 'spotify', sink: 'bluez', volume: 54 });

    // A gap between tracks shorter than the grace: nothing reported
    playing = false;
    event("Event 'remove' on sink-input #150");
    await tick(500);
    playing = true;
    event("Event 'new' on sink-input #151");
    await tick(1500);
    expect(changes).to.have.length(2);

    playing = false;
    event("Event 'remove' on sink-input #151");
    await tick(500);
    expect(changes).to.have.length(2);
    await tick(600);
    expect(changes.map(change => change.active)).to.deep.equal([false, true, false]);
    music.stop();
  });

  it('reports a volume change while music plays, and ignores events that change nothing', async () => {
    playing = true;
    const music = watcher();
    await music.start();
    event("Event 'change' on client #3");
    await tick(20);
    expect(changes).to.have.length(1);
    volume = 70;
    event("Event 'change' on sink #130");
    await tick(20);
    expect(changes.map(change => change.volume)).to.deep.equal([54, 70]);
    music.stop();
  });

  it('counts music as stopped when pactl fails, warning once, and watches again after pactl exits', async () => {
    playing = true;
    const music = watcher();
    await music.start();
    execError = new Error('Connection refused');
    children[0].child.emit('exit', 1);
    await tick(60);
    expect(children).to.have.length(2);
    await tick(1100);
    expect(changes.map(change => change.active)).to.deep.equal([true, false]);
    expect(warnings).to.have.length(1);
    music.stop();
    expect(children[1].child.killed).to.be.true;
  });
});
