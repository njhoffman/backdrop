import { expect } from 'chai';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import {
  configureNotify, describeNotification, notifyMode, notifyPlaying, notifyCommand
} from '../../src/utils/notify.js';
import { notifications } from '../helpers/setup.js';
import { makeConfig } from '../helpers/fakes.js';

describe('notify', () => {
  const monitor = { name: 'DP-1', width: 2560, height: 1440 };
  let db, recorded;

  beforeEach(() => {
    db = new DatabaseManager(); db.initialize(':memory:');
    notifications.length = 0;
    recorded = notifications;
  });
  afterEach(() => db.close());

  const video = () => db.getMedia(db.addMedia({
    kind: 'video', source: 'local', source_id: 1, path: '/m/v.mp4', width: 3840, height: 2160, duration: 18
  }));

  it('describes videos with duration and rating, images without a duration', () => {
    const media = { ...video(), fps: 25 };
    expect(describeNotification({ monitor, media, rating: { rating: 2 } })).to.deep.equal({
      summary: `#${media.id}  video  3840x2160`, body: '0:18 · 25 fps · ★★☆ · DP-1'
    });
    const image = { id: 7, kind: 'image', width: 1920, height: 1080, duration: null };
    expect(describeNotification({ monitor, media: image, rating: null, tags: ['sea', 'r&b'] }).body)
      .to.equal('unrated · DP-1\nsea, r&amp;b');
    expect(describeNotification({ monitor, media: image, rating: { rating: 0 } }).body).to.equal('skipped · DP-1');
  });

  it('replaces the previous notification of the same monitor', async () => {
    const media = video();
    await notifyPlaying(db, { monitor, media, rating: null });
    await notifyPlaying(db, { monitor, media, rating: null });
    expect(recorded).to.have.length(2);
    expect(recorded[0]).to.include('--icon=video-x-generic').and.include('--hint=string:x-dunst-stack-tag:backdrop-DP-1');
    expect(recorded[0].some(arg => arg.startsWith('--replace-id'))).to.be.false;
    expect(recorded[1]).to.include('--replace-id=1');
    expect(db.getSetting('notify_id:DP-1')).to.equal(2);
  });

  it('uses the image itself as the icon and skips files outside the library', async () => {
    const id = db.addMedia({ kind: 'image', source: 'local', source_id: 2, path: '/m/i.png', width: 1, height: 1 });
    await notifyPlaying(db, { monitor, media: db.getMedia(id), rating: null });
    await notifyPlaying(db, { monitor, media: null, rating: null });
    expect(recorded).to.have.length(1);
    expect(recorded[0]).to.include('--icon=/m/i.png');
  });

  it('only logs when notify-send fails', async () => {
    const warnings = [];
    const exec = async (file, args) => { notifications.push(args); return `${notifications.length}\n`; };
    configureNotify({ exec: async () => { throw new Error('spawn notify-send ENOENT'); } });
    try {
      await notifyPlaying(db, { monitor, media: video(), rating: null }, { logger: { warn: (...args) => warnings.push(args) } });
    } finally {
      configureNotify({ exec });
    }
    expect(warnings[0][1].error).to.include('ENOENT');
  });

  it('notifies from commands only in commands mode and validates the setting', async () => {
    const config = makeConfig();
    const playing = { monitor, media: video(), rating: null };
    expect(notifyMode(config.get().display)).to.equal('commands');
    await notifyCommand(config, db, playing);
    config.set('display.notify', 'all');
    await notifyCommand(config, db, playing);
    config.set('display.notify', 'off');
    await notifyCommand(config, db, playing);
    expect(recorded).to.have.length(1);
    expect(() => notifyMode({ notify: 'always' })).to.throw('display.notify must be commands, all, off');
  });
});
