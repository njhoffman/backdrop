import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { WebServer } from '../../src/web/server.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// A real server on a free port with stand-ins for the services and the event hub, so the run stays offline
describe('WebServer', () => {
  const token = 'test-token-0123456789';
  let dir, db, config, server, base, display, rating, library, hub, thumbs, id;

  const monitor = { name: 'DP-1', width: 1920, height: 1080 };
  const cookie = `backdrop_token=${token}`;
  const get = (url, headers = {}) => fetch(`${base}${url}`, { headers: { cookie, ...headers }, redirect: 'manual' });
  const post = (url, body, headers = {}) => fetch(`${base}${url}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'x-backdrop-token': token, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-web-'));
    await fs.outputFile(path.join(dir, 'static', 'index.html'), '<meta content="{{token}}">');
    await fs.outputFile(path.join(dir, 'static', 'library.html'), '<p>library {{token}}</p>');
    await fs.outputFile(path.join(dir, 'static', 'app.js'), 'export {};');
    await fs.outputFile(path.join(dir, 'thumb.jpg'), 'jpeg');
    config = makeConfig({ 'paths.runtime': dir, 'display.video_loop': 'bounce' });
    db = new DatabaseManager();
    db.initialize(':memory:');
    id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, path: '/m/1.mp4', width: 1920, height: 1080, duration: 12 });
    const playing = { monitor, path: '/m/1.mp4', media: db.getMedia(id), rating: null };
    display = {
      status: sinon.stub().resolves({ mode: 'video', daemon: { running: true }, monitors: [] }),
      durations: sinon.stub().resolves({ image: { seconds: 300, set: false }, video: { seconds: 600, set: false } }),
      next: sinon.stub().resolves({ playing }), prev: sinon.stub().resolves({ playing }),
      speed: sinon.stub().resolves({ monitor, speed: 0.5 }),
      dim: sinon.stub().resolves({ monitor, dim: 20, shown: 30 }),
      bounce: sinon.stub().rejects(new Error('Invalid bounce: maybe')),
      mode: sinon.stub().resolves({ mode: 'image', held: null }),
      start: sinon.stub().resolves({ action: 'changed' }), stop: sinon.stub().resolves({ action: 'changed' }),
      setDurations: sinon.stub().resolves({ image: { seconds: 90, set: true }, video: { seconds: 600, set: false } })
    };
    rating = {
      keep: sinon.stub().resolves({ rated: db.getMedia(id), warnings: ['playlist update failed'], playing: null }),
      skip: sinon.stub().resolves({ rated: db.getMedia(id), warnings: [], playing }),
      undo: sinon.stub().resolves({ action: 'none', media: null, warnings: [] })
    };
    library = {
      list: sinon.stub().returns({ total: 0, page: 1, pages: 1, per_page: 48, items: [] }),
      facets: sinon.stub().returns({ tags: [], queries: [] }),
      item: sinon.stub().throws(Object.assign(new Error('No library item #5'), { status: 404 })),
      rate: sinon.stub().resolves({ item: { id: 5 }, warnings: [] }),
      adjust: sinon.stub().resolves({ id: 5, dim: 10 }),
      play: sinon.stub().resolves(playing)
    };
    hub = { start: sinon.stub().resolves(), stop: sinon.stub().resolves(), changed: sinon.spy(), add: sinon.stub().callsFake(async response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('event: state\ndata: {}\n\n');
    }) };
    thumbs = [];
    server = new WebServer({
      config, database: db, logger: silentLogger, display, rating, library, token, version: '9.9.9', hub,
      staticDir: path.join(dir, 'static'),
      thumbnail: async media => { thumbs.push(media.id); return path.join(dir, 'thumb.jpg'); }
    });
    const port = await server.listen(0);
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.close();
    db.close();
    await fs.remove(dir);
  });

  it('swaps the first visit\'s token for a cookie and sends the page with the token in it', async () => {
    const first = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    expect(first.status).to.equal(303);
    expect(first.headers.get('location')).to.equal('/');
    expect(first.headers.get('set-cookie')).to.include('HttpOnly');
    const page = await get('/');
    expect(await page.text()).to.equal(`<meta content="${token}">`);
    expect(page.headers.get('content-security-policy')).to.include("script-src 'self'");
    expect(page.headers.get('referrer-policy')).to.equal('no-referrer');
  });

  it('refuses requests without the cookie, or changes without the page token', async () => {
    expect((await fetch(`${base}/api/state`)).status).to.equal(401);
    expect((await post('/api/undo', {}, { 'x-backdrop-token': 'wrong' })).status).to.equal(403);
    expect(rating.undo.called).to.equal(false);
  });

  it('answers the state with the status, durations, the settings items fall back to and the version', async () => {
    const body = await (await get('/api/state')).json();
    expect(body).to.deep.equal({
      status: { mode: 'video', daemon: { running: true }, monitors: [] },
      durations: { image: { seconds: 300, set: false }, video: { seconds: 600, set: false } },
      settings: { video_loop: 'bounce' },
      version: '9.9.9'
    });
  });

  it('plays next on the monitor named in the path and tells the pages', async () => {
    const response = await post('/api/monitors/DP-1/next');
    const body = await response.json();
    expect(display.next.firstCall.args[0]).to.deep.equal({ monitor: 'DP-1' });
    expect(body.monitor).to.deep.equal({ name: 'DP-1', width: 1920, height: 1080 });
    expect(body.item).to.include({ id, kind: 'video' });
    expect(hub.changed.calledOnce).to.equal(true);
  });

  it('keeps and skips the playing item, passing on playlist warnings', async () => {
    const kept = await (await post('/api/monitors/DP-1/keep', { rating: 2 })).json();
    expect(rating.keep.firstCall.args).to.deep.equal([2, { monitor: 'DP-1', next: false }]);
    expect(kept.warnings).to.deep.equal(['playlist update failed']);
    expect(kept.item.id).to.equal(id);
    const skipped = await (await post('/api/monitors/DP-1/skip')).json();
    expect(skipped.playing.item.id).to.equal(id);
  });

  it('applies speed and dim, and returns a service\'s error as a 400', async () => {
    expect(await (await post('/api/monitors/DP-1/speed', { value: 0.5 })).json()).to.deep.equal({ speed: 0.5 });
    expect(display.speed.firstCall.args).to.deep.equal(['0.5', { monitor: 'DP-1' }]);
    expect(await (await post('/api/monitors/DP-1/dim', { value: '20' })).json()).to.deep.equal({ dim: 20, shown: 30 });
    const refused = await post('/api/monitors/DP-1/bounce', { value: 'maybe' });
    expect(refused.status).to.equal(400);
    expect(await refused.json()).to.deep.equal({ error: 'Invalid bounce: maybe' });
    expect(hub.changed.callCount).to.equal(2);
  });

  it('checks bodies: JSON objects only, values present', async () => {
    expect((await post('/api/mode', 'not json')).status).to.equal(400);
    expect((await post('/api/mode', [1])).status).to.equal(400);
    expect(await (await post('/api/mode', {})).json()).to.deep.equal({ error: 'Missing mode' });
    expect(await (await post('/api/mode', { mode: 'image', monitor: 'DP-1' })).json()).to.deep.equal({ mode: 'image', held: null });
    expect(display.mode.firstCall.args).to.deep.equal(['image', { monitor: 'DP-1' }]);
  });

  it('turns parts on and off, starting the daemon for parts turned on', async () => {
    await post('/api/parts', { wallpaper: true, visualizer: false });
    expect(display.start.firstCall.args[0]).to.deep.equal({ wallpaper: true });
    expect(display.stop.firstCall.args[0]).to.deep.equal({ visualizer: true });
    expect((await post('/api/parts', {})).status).to.equal(400);
    await post('/api/daemon', { running: true });
    expect(display.start.secondCall.args[0]).to.deep.equal({});
    expect((await post('/api/daemon', { running: 'yes' })).status).to.equal(400);
  });

  it('sets the durations as next does, or drops them with clear', async () => {
    const body = await (await post('/api/durations', { image: '90s' })).json();
    expect(display.setDurations.firstCall.args[0]).to.deep.equal({ clear: false, imageDuration: '90s' });
    expect(body.durations.image).to.deep.equal({ seconds: 90, set: true });
    await post('/api/durations', { clear: true });
    expect(display.setDurations.secondCall.args[0]).to.deep.equal({ clear: true });
  });

  it('undoes the last rating', async () => {
    expect(await (await post('/api/undo')).json()).to.deep.equal({ action: 'none', item: null, warnings: [] });
  });

  it('serves thumbnails of library items and the static files, and nothing else', async () => {
    const thumb = await get(`/thumbs/${id}.jpg`);
    expect(thumb.headers.get('content-type')).to.equal('image/jpeg');
    expect(await thumb.text()).to.equal('jpeg');
    expect(thumbs).to.deep.equal([id]);
    expect((await get('/thumbs/999.jpg')).status).to.equal(404);
    expect((await get('/static/app.js')).headers.get('content-type')).to.include('text/javascript');
    expect((await get('/static/missing.js')).status).to.equal(404);
    expect((await get('/static/index.html')).status).to.equal(404);
    expect((await get('/static/..%2Fthumb.jpg')).status).to.equal(404);
    expect((await get('/nowhere')).status).to.equal(404);
    expect((await get('/api/undo')).status).to.equal(405);
  });

  describe('library', () => {
    it('serves the library page and lists items, passing the filters as the service takes them', async () => {
      expect(await (await get('/library')).text()).to.equal(`<p>library ${token}</p>`);
      await get('/api/media?kind=video&tag=ocean&tag=night&keywords=waves%20%20blue&query=storm&page=2&ignored=1');
      expect(library.list.firstCall.args[0]).to.deep.equal({
        kind: 'video', page: '2', tag: ['ocean', 'night'], keywords: ['waves', 'blue'], query: ['storm']
      });
      expect(await (await get('/api/media/facets')).json()).to.deep.equal({ tags: [], queries: [] });
    });

    it('answers an unknown item with the service\'s 404', async () => {
      const response = await get('/api/media/5');
      expect(response.status).to.equal(404);
      expect(await response.json()).to.deep.equal({ error: 'No library item #5' });
    });

    it('rates, adjusts and plays an item, and changing one needs the page token', async () => {
      expect(await (await post('/api/media/5/rating', { rating: 0 })).json()).to.deep.equal({ item: { id: 5 }, warnings: [] });
      expect(library.rate.firstCall.args).to.deep.equal(['5', 0]);
      const patch = body => fetch(`${base}/api/media/5`, { method: 'PATCH', headers: { cookie, 'x-backdrop-token': token }, body: JSON.stringify(body) });
      expect(await (await patch({ dim: '+10' })).json()).to.deep.equal({ item: { id: 5, dim: 10 } });
      expect(library.adjust.firstCall.args).to.deep.equal(['5', { dim: '+10' }]);
      const unsigned = await fetch(`${base}/api/media/5`, { method: 'PATCH', headers: { cookie }, body: '{}' });
      expect(unsigned.status).to.equal(403);
      const played = await (await post('/api/media/5/play', { monitor: 'DP-1' })).json();
      expect(library.play.firstCall.args).to.deep.equal(['5', 'DP-1']);
      expect(played.item.id).to.equal(id);
      expect((await post('/api/media/5/play', {})).status).to.equal(400);
      expect(hub.changed.callCount).to.equal(3);
    });

    it('passes next the library\'s filters, checking they are lists of strings', async () => {
      await post('/api/monitors/DP-1/next', { tag: ['ocean', ' '], keywords: ['waves'], random: 1 });
      expect(display.next.firstCall.args[0]).to.deep.equal({ monitor: 'DP-1', tag: ['ocean'], keywords: ['waves'], random: true });
      const refused = await post('/api/monitors/DP-1/next', { tag: 'ocean' });
      expect(await refused.json()).to.deep.equal({ error: 'tag must be a list of strings' });
    });

    it('makes at most two thumbnails at once', async () => {
      let running = 0;
      let most = 0;
      const ids = [1, 2, 3, 4, 5].map(n => db.addMedia({ kind: 'image', source: 'local', source_id: `t${n}`, path: `/m/t${n}.jpg` }));
      const limitedServer = new WebServer({
        config, database: db, logger: silentLogger, display, rating, library, token, hub, staticDir: path.join(dir, 'static'),
        thumbnail: async () => {
          running++;
          most = Math.max(most, running);
          await new Promise(resolve => setTimeout(resolve, 20));
          running--;
          return path.join(dir, 'thumb.jpg');
        }
      });
      const port = await limitedServer.listen(0);
      try {
        await Promise.all(ids.map(item => fetch(`http://127.0.0.1:${port}/thumbs/${item}.jpg`, { headers: { cookie } }).then(response => response.text())));
      } finally {
        await limitedServer.close();
      }
      expect(most).to.equal(2);
    });
  });

  it('hands the event stream to the hub', async () => {
    const response = await get('/api/events');
    expect(response.headers.get('content-type')).to.equal('text/event-stream');
    expect(await response.text()).to.include('event: state');
  });

  it('takes a free port when the one asked for is in use', async () => {
    const other = new WebServer({ config, database: db, logger: silentLogger, display, rating, token, hub });
    const port = await other.listen(Number(new URL(base).port));
    try {
      expect(port).to.not.equal(Number(new URL(base).port));
    } finally {
      await other.close();
    }
  });
});
