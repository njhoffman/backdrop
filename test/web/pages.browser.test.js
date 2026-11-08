import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { WebServer } from '../../src/web/server.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

// The real pages and their scripts in headless Chrome, against a server with stand-in services, so a script error, a
// blocked request (the content security policy) or a page that draws nothing fails here. Skipped when no Chrome or
// Chromium is installed or playwright-core is missing (it is a devDependency and downloads no browser).
const BROWSERS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = BROWSERS.find(file => fs.existsSync(file));
let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  chromium = null;
}

// Each step's own deadline, well inside the test's, so a stuck one fails naming itself; Playwright's waits take it as
// their timeout, and the calls without one (opening and closing pages) go through within
const STEP_MS = 15000;

function within(step, promise) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Chrome took over ${STEP_MS / 1000} s ${step}`)), STEP_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Chrome talks to the session and system buses even headless, and waits on a call there (25 s each) before it opens a
// page, so a desktop bus slow to answer failed both tests on their 60 s timeout. A missing socket is refused at once.
const NO_BUS = 'unix:path=/nonexistent/backdrop-test-bus';

(executablePath && chromium ? describe : describe.skip)('web pages in a browser', function () {
  this.timeout(60000);
  const token = 'browser-test-token-0123456789';
  const monitor = { name: 'DP-1', width: 1920, height: 1080 };
  let dir, db, config, server, browser, base, display, id, errors;

  before(async () => {
    browser = await chromium.launch({
      executablePath, headless: true, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: NO_BUS, DBUS_SYSTEM_BUS_ADDRESS: NO_BUS }
    });
  });

  after(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-browser-'));
    config = makeConfig({ 'paths.runtime': dir });
    db = new DatabaseManager();
    db.initialize(':memory:');
    id = db.addMedia({ kind: 'video', source: 'local', source_id: 1, original_name: 'ocean.mp4', path: '/m/ocean.mp4', width: 1920, height: 1080, duration: 12 });
    const item = { id, kind: 'video', file: 'ocean.mp4', width: 1920, height: 1080, duration: 12, fps: 30, speed: 1, dim: 0, bounce: null,
      status: 'new', rating: null, tags: ['ocean'], queries: [], playback: null, author: null, page_url: null, source: 'local' };
    const status = {
      mode: 'video', chosen_mode: 'video',
      daemon: { running: true, pid: 4242, wallpaper: true, visualizer: false, compositor: null, load: null, wallpaper_hidden: false },
      monitors: [{ ...monitor, eligible: 1, cpu_percent: 4.2, decoder: 'vaapi', gpu_memory_bytes: null, visualizer: null, visualizers: [], overlays: [], playing: item }],
      screensaver: { active: false }, web: null, config_warnings: []
    };
    display = {
      status: sinon.stub().resolves(status),
      durations: sinon.stub().resolves({ image: { seconds: 300, set: false }, video: { seconds: 600, set: false } }),
      next: sinon.stub().resolves({ playing: { monitor, path: '/m/ocean.mp4', media: db.getMedia(id), rating: null } })
    };
    const library = {
      list: sinon.stub().returns({ total: 1, page: 1, pages: 1, per_page: 48, items: [item] }),
      facets: sinon.stub().returns({ tags: [{ tag: 'ocean', count: 1 }], queries: [] })
    };
    const visualizer = {
      describe: sinon.stub().resolves({
        running: true, enabled: true, error: null, wallpaper: true, preset: null, changed: false,
        presets: [{ name: 'ring', source: 'built in' }],
        instances: [{ name: 'main', changed: false, sent: null, yaml: { settings: 'opacity: 0.8\n', live: '' },
          look: { module: 'bars', opacity: 0.8, anchor: 'bottom', palette: { source: 'config', pick: 'vivid' }, amplify: 200, colors: ['#000000', '#33aacc'], colorOption: 'colors' } }],
        choices: { modules: ['bars', 'radial'], anchors: ['bottom', 'top'], picks: ['vivid'], swatches: { ocean: ['#003a5c', '#33aacc'] }, sleeve: { now: [], positions: [], aligns: [] } }
      })
    };
    const settings = {
      describe: sinon.stub().resolves({ path: '/home/me/.config/backdrop/config.yaml', errors: [], warnings: [], fields: [
        { key: 'display.order', kind: 'choice', choices: ['shuffle', 'random'], help: 'How next picks', value: 'random', default: 'random', inFile: false, applies: 'live' },
        { key: 'sources.pexels.api_key', kind: 'secret', help: 'API key', set: true, fromEnvironment: false, inFile: true, applies: 'command' }
      ] })
    };
    const stats = { collect: sinon.stub().resolves({
      library: { kinds: [{ kind: 'video', total: 1, new: 1, kept: 0, skipped: 0, pending: 0, duration: 12 }], total: { kind: 'total', total: 1, new: 1, kept: 0, skipped: 0, pending: 0, duration: 12 } },
      ratings: { byRating: [0, 0, 0, 0], rated: 0, orientations: { landscape: 0, portrait: 0 }, changes: 0, last: null },
      resolutions: [{ bucket: '1080p', count: 1 }], sources: [], queries: [],
      recent: { days: 7, added: 1, ratings: 0, searches: 0, searches_all_time: 0, duplicates: 0 },
      storage: { dirs: [{ name: 'media', path: '/m', files: 1, bytes: 1024 }], bytes: 1024, trashDays: 30 },
      monitors: null, playback: { groups: [], expensive: [], software: 0 }, quota: null
    }) };
    const doctor = { check: sinon.stub().resolves({ ok: true, failed: 0, warned: 0, checks: [{ group: 'tools', name: 'mpv', status: 'ok', detail: 'plays the wallpaper' }] }) };
    server = new WebServer({
      config, database: db, logger: silentLogger, display, library, visualizer, settings, stats, doctor, token, version: '9.9.9',
      thumbnail: async () => null
    });
    base = `http://127.0.0.1:${await server.listen(0)}`;
  });

  afterEach(async () => {
    await server.close();
    db.close();
    await fs.remove(dir);
  });

  // A page signed in through the token address, recording console errors and failed requests
  async function open(pathname) {
    const page = await within('opening a page', browser.newPage());
    page.setDefaultTimeout(STEP_MS);
    errors = [];
    // Failed requests by URL; the stand-in has no thumbnails, so those 404s are expected
    page.on('response', response => {
      if (response.status() >= 400 && !/\/thumbs\/\d+\.jpg$/.test(response.url())) errors.push(`${response.status()} ${response.url()}`);
    });
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?token=${token}`);
    if (pathname !== '/') await page.goto(`${base}${pathname}`);
    return page;
  }

  it('draws Now playing from the event stream and sends next', async () => {
    const page = await open('/');
    await page.waitForSelector('.card .item-title');
    expect(await page.textContent('.card .monitor-name')).to.equal('DP-1');
    expect(await page.textContent('.card .item-title')).to.include('ocean.mp4');
    expect(await page.textContent('#daemon')).to.equal('running, pid 4242');
    // The address bar lost the token
    expect(new URL(page.url()).search).to.equal('');
    await page.click('button[data-action="next"]');
    await page.waitForFunction(() => !document.querySelector('.card.busy'));
    expect(display.next.firstCall.args[0]).to.deep.equal({ monitor: 'DP-1' });
    expect(errors).to.deep.equal([]);
    await within('closing a page', page.close());
  });

  it('draws the Library, Visualizer, Config and Status pages', async () => {
    let page = await open('/library');
    await page.waitForSelector('.tile');
    expect(await page.textContent('#count')).to.equal('1-1 of 1 items');
    await within('closing a page', page.close());

    page = await open('/visualizer');
    await page.waitForSelector('.instance .instance-name');
    expect(await page.textContent('.instance-name')).to.equal('main');
    expect(await page.$$eval('.swatch .dot', dots => dots.map(dot => dot.style.background))).to.have.length(2);
    await within('closing a page', page.close());

    page = await open('/config');
    await page.waitForSelector('[data-key="display.order"]');
    expect(await page.getAttribute('[data-key="sources.pexels.api_key"]', 'placeholder')).to.equal('set (type to replace)');
    await within('closing a page', page.close());

    page = await open('/status');
    await page.waitForSelector('#library tbody tr');
    await page.click('#run-checks');
    await page.waitForSelector('#checks tbody tr');
    expect(await page.textContent('#checks-summary')).to.equal('All passed');
    expect(errors).to.deep.equal([]);
    await within('closing a page', page.close());
  });
});
