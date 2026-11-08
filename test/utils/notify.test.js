import { expect } from 'chai';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import {
  configureNotify, describeNotification, notifyMode, notifyPlaying, notifyCommand
} from '../../src/utils/notify.js';
import { notifications, closedNotifications } from '../helpers/setup.js';
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

  it('sets the time apart and colors the tags in desktop notifications', () => {
    const media = { ...video(), fps: 25 };
    const tags = ['sea', 'r&b', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { summary, body } = describeNotification({ monitor, media, rating: { rating: 2 }, tags }, { rich: true });
    expect(summary).to.equal(`#${media.id}  video  3840x2160`);
    const [first, second] = body.split('\n');
    expect(first).to.equal('<span size="large" weight="bold">0:18</span>  <span alpha="70%">25 fps · ★★☆ · DP-1</span>');
    expect(second).to.equal(['sea', 'r&amp;b', 'a', 'b', 'c', 'd', 'e', 'f']
      .map((tag, index) => `<span foreground="${['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff'][index % 5]}">${tag}</span>`).join('  '));
    // An image has no time to show
    const image = { id: 7, kind: 'image', width: 1920, height: 1080, duration: null };
    expect(describeNotification({ monitor, media: image, rating: null }, { rich: true }).body).to.equal('<span alpha="70%">unrated · DP-1</span>');
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

  it('shows a still of the item as a file:// image-path hint, the icon only when there is no still', async () => {
    const asked = [];
    configureNotify({ still: async (media, dir) => { asked.push([media.id, dir]); return `/cache/thumbs/${media.id} a.still.jpg`; } });
    try {
      const media = video();
      await notifyPlaying(db, { monitor, media, rating: null }, { thumbnails: '/cache/thumbs' });
      expect(asked).to.deep.equal([[media.id, '/cache/thumbs']]);
      expect(recorded[0]).to.include(`--hint=string:image-path:file:///cache/thumbs/${media.id}%20a.still.jpg`);
      expect(recorded[0].some(arg => arg.startsWith('--icon='))).to.equal(false);

      configureNotify({ still: async () => null });
      await notifyPlaying(db, { monitor, media, rating: null }, { thumbnails: '/cache/thumbs' });
      expect(recorded[1]).to.include('--icon=video-x-generic');
      // A failing still falls back the same way
      configureNotify({ still: async () => { throw new Error('ffmpeg missing'); } });
      await notifyPlaying(db, { monitor, media, rating: null }, { thumbnails: '/cache/thumbs' });
      expect(recorded[2]).to.include('--icon=video-x-generic');
    } finally {
      configureNotify({ still: async () => null });
    }
  });

  it('passes the thumbnail folder from the config for command notifications', async () => {
    const dirs = [];
    configureNotify({ still: async (media, dir) => { dirs.push(dir); return null; } });
    try {
      const config = makeConfig({ 'display.notify': 'commands', 'paths.thumbnails': '/cache/thumbs' });
      await notifyCommand(config, db, { monitor, media: video(), rating: null });
      expect(dirs).to.deep.equal(['/cache/thumbs']);
    } finally {
      configureNotify({ still: async () => null });
    }
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
    expect(() => notifyMode({ notify: 'always' })).to.throw('display.notify must be commands, all or off, not "always"');
  });

  describe('a server that does not replace', () => {
    const playing = { monitor: { name: 'DP-1' }, media: { id: 1, kind: 'image', path: '/m/a.png', width: 1, height: 1 }, rating: null };
    const database = { settings: new Map(), getSetting(key) { return this.settings.get(key); }, setSetting(key, value) { this.settings.set(key, value); }, getTags: () => [] };
    let ids;
    let closed;

    beforeEach(() => {
      database.settings.clear();
      closed = [];
      configureNotify({
        exec: async (file, args) => {
          if (file === 'gdbus') { closed.push(args.at(-1)); return '()\n'; }
          return `${ids.shift()}\n`;
        }
      });
    });
    afterEach(() => {
      configureNotify({ exec: async (file, args) => {
        if (file === 'gdbus') { closedNotifications.push(args.at(-1)); return '()\n'; }
        notifications.push(args);
        return `${notifications.length}\n`;
      } });
    });

    it('closes the previous notification when a new id comes back, as deadd answers', async () => {
      ids = [837, 838];
      await notifyPlaying(database, playing);
      expect(closed).to.deep.equal([]);
      await notifyPlaying(database, playing);
      expect(closed).to.deep.equal(['837']);
      expect(database.getSetting('notify_id:DP-1')).to.equal(838);
    });

    it('closes nothing when the id stays the same, as dunst answers', async () => {
      ids = [837, 837];
      await notifyPlaying(database, playing);
      await notifyPlaying(database, playing);
      expect(closed).to.deep.equal([]);
    });

    it('keeps going when the close fails', async () => {
      configureNotify({ exec: async file => { if (file === 'gdbus') throw new Error('no such notification'); return `${ids.shift()}\n`; } });
      ids = [837, 838];
      await notifyPlaying(database, playing);
      await notifyPlaying(database, playing);
      expect(database.getSetting('notify_id:DP-1')).to.equal(838);
    });
  });
});
