import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { Bounce } from '../../src/display/daemon/Bounce.js';
import { playUrl } from '../../src/display/bounce.js';
import { FakeMpvClient, makeConfig, silentLogger } from '../helpers/fakes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Bounce (daemon)', () => {
  let dir, db, config, daemon, encodes, bounce;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-bounceq-'));
    db = new DatabaseManager();
    db.initialize(':memory:');
    config = makeConfig({ 'paths.bounce': path.join(dir, 'bounce'), 'display.video_loop': 'bounce' });
    encodes = [];
    // Each encode waits for the test: finish(true) writes the copy, finish(false) fails it
    daemon = {
      config, database: db, logger: silentLogger, stopping: false, screens: new Map(), load: { level: 'normal' },
      enqueue: task => task(),
      reverse: (media, { signal }) => new Promise(resolve => {
        encodes.push({
          media, signal,
          finish: async ok => {
            if (ok) await fs.outputFile(path.join(dir, 'bounce', `${media.id}.mp4`), 'reversed');
            resolve(ok ? path.join(dir, 'bounce', `${media.id}.mp4`) : null);
          }
        });
        signal.addEventListener('abort', () => resolve(null));
      })
    };
    bounce = new Bounce(daemon);
  });

  afterEach(async () => {
    await bounce.stop();
    db.close();
    await fs.remove(dir);
  });

  async function video(id) {
    const file = path.join(dir, 'media', `${id}.mp4`);
    await fs.outputFile(file, 'video');
    return db.getMedia(db.addMedia({ kind: 'video', source: 'local', source_id: id, duration: 10, path: file }));
  }

  function screen(playlist) {
    const value = { monitor: { name: 'DP-3' }, client: new FakeMpvClient({ playlist }) };
    daemon.screens.set('DP-3', value);
    return value;
  }

  it('reverses the loaded item, then the next entry, one at a time', async () => {
    const playing = await video(1);
    const next = await video(2);
    const shown = screen([{ id: 1, filename: playing.path, current: true }, { id: 2, filename: next.path }]);

    await bounce.onLoaded(shown, playing);
    expect(encodes.map(encode => encode.media.id)).to.deep.equal([1]);
    await encodes[0].finish(true);
    await tick();
    expect(encodes.map(encode => encode.media.id)).to.deep.equal([1, 2]);
    // The playing entry waits for its next play
    expect([...bounce.pending]).to.deep.equal([1]);
  });

  it('swaps the next entry for its bounce URL when its copy is ready', async () => {
    const playing = await video(1);
    const next = await video(2);
    const shown = screen([{ id: 1, filename: playing.path, current: true }, { id: 2, filename: next.path }]);
    bounce.want(next);
    await encodes[0].finish(true);
    await tick();
    expect(shown.client.commands).to.deep.include(['loadfile', playUrl(next, config.get()), 'insert-at', 1]);
    expect(bounce.pending.size).to.equal(0);
  });

  it('waits while the load is up and starts again from the item it stopped', async () => {
    const media = await video(1);
    bounce.want(media);
    daemon.load.level = 'images';
    bounce.pause();
    await tick();
    await tick();
    expect(encodes[0].signal.aborted).to.equal(true);
    expect([...bounce.queue.keys()]).to.deep.equal([1]);

    daemon.load.level = 'normal';
    bounce.kick();
    expect(encodes).to.have.length(2);
  });

  it('leaves items that failed, or need nothing, out of the queue', async () => {
    const media = await video(1);
    bounce.want(media);
    await encodes[0].finish(false);
    await tick();
    bounce.want(media);
    expect(encodes).to.have.length(1);

    // Turned on again by hand: tried once more
    db.setBounce(media.id, true);
    await bounce.changed(media.id);
    expect(encodes).to.have.length(2);

    const image = db.getMedia(db.addMedia({ kind: 'image', source: 'local', source_id: 9, path: '/m/i.png' }));
    bounce.want(image);
    expect(encodes).to.have.length(2);
  });

  it('looks ahead only when something can bounce', async () => {
    config.set('display.video_loop', 'loop');
    const media = await video(1);
    const shown = screen([{ id: 1, filename: media.path, current: true }]);
    await bounce.onLoaded(shown, media);
    expect(shown.client.commands).to.deep.equal([]);
    expect(encodes).to.have.length(0);

    db.setBounce(media.id, true);
    await bounce.onLoaded(shown, db.getMedia(media.id));
    expect(encodes).to.have.length(1);
  });

  it('removes work an earlier daemon left on start', async () => {
    await fs.outputFile(path.join(dir, 'bounce', '3.99.tmp', 'c00000.mp4'), 'chunk');
    await bounce.begin();
    expect(await fs.readdir(path.join(dir, 'bounce'))).to.deep.equal([]);
  });
});
