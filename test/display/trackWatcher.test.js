import { expect } from 'chai';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import sinon from 'sinon';
import { TrackWatcher } from '../../src/display/trackWatcher.js';

describe('TrackWatcher', () => {
  let clock, children, songs, warnings, watcher;

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
    songs = [];
    warnings = [];
    watcher = new TrackWatcher({ spawn, logger: { warn: message => warnings.push(message) }, onTrack: song => songs.push(song), settle: 1000, restartDelay: 5000 });
  });

  afterEach(() => {
    watcher.stop();
    clock.restore();
  });

  it('follows every player and reports a new song once its metadata settles, not the song each player had', async () => {
    watcher.start();
    expect(children[0].file).to.equal('playerctl');
    expect(children[0].args).to.include.members(['--all-players', '--follow', 'metadata']);
    await say('spotify\tA\tOne', 'chromium\t\tVideo');
    await clock.tickAsync(2000);
    expect(songs).to.deep.equal([]);
    // The title comes before its artist: one report, the settled song
    await say('spotify\tA\tTwo', 'spotify\tB\tTwo');
    await clock.tickAsync(999);
    expect(songs).to.deep.equal([]);
    await clock.tickAsync(1);
    expect(songs).to.deep.equal([{ player: 'spotify', artist: 'B', title: 'Two' }]);
  });

  it('ignores repeats of the same song and lines without a title', async () => {
    watcher.start();
    await say('spotify\tA\tOne', 'spotify\tA\tOne', 'spotify\t\t', '');
    await clock.tickAsync(2000);
    expect(songs).to.deep.equal([]);
  });

  it('follows again after playerctl ends, keeping the songs it saw, and stops for good on stop', async () => {
    watcher.start();
    await say('spotify\tA\tOne');
    children[0].emit('exit', 0);
    await clock.tickAsync(5000);
    expect(children).to.have.length(2);
    // The restarted playerctl repeats the song first: no change
    await say('spotify\tA\tOne');
    await clock.tickAsync(2000);
    expect(songs).to.deep.equal([]);
    await say('spotify\tA\tTwo');
    watcher.stop();
    await clock.tickAsync(2000);
    expect(songs).to.deep.equal([]);
    expect(children[1].kill.calledWith('SIGTERM')).to.equal(true);
    children[1].emit('exit', 0);
    await clock.tickAsync(10_000);
    expect(children).to.have.length(2);
  });

  it('warns once when playerctl cannot run', async () => {
    watcher.start();
    children[0].emit('error', new Error('ENOENT'));
    children[0].emit('error', new Error('ENOENT'));
    expect(warnings).to.have.length(1);
  });
});
