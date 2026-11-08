import fs from 'fs-extra';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { thumbnailFor } from '../library/thumbnail.js';
import { mediaJson, playingJson } from '../utils/mediaView.js';
import { refusal, sessionCookie } from './auth.js';
import { EventHub } from './events.js';

// The HTTP side of `backdrop web` (docs/specs/web.md): node:http with a small router, JSON in and out, the pages'
// static files, thumbnails and the event stream. Everything a request changes goes through DisplayService and
// RatingService, as the CLI's commands do, and is followed by a snapshot to every page.

export const STATIC_DIR = fileURLToPath(new URL('../../share/web/', import.meta.url));
const MAX_BODY = 64 * 1024;
// Thumbnails made at once: a library page asks for dozens, each an ffmpeg
const THUMBNAIL_CONCURRENCY = 2;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// Only this server's own files, styles and scripts; nothing inline, nothing from elsewhere
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  // The first visit's URL carries the token; it must not leave in a Referer
  'referrer-policy': 'no-referrer'
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class WebServer {
  constructor({
    config, database, logger, display, rating, library, token, version = null,
    thumbnail = media => thumbnailFor(media, config.get().paths.thumbnails, { logger, nice: true }),
    staticDir = STATIC_DIR, hub
  }) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.display = display;
    this.rating = rating;
    this.library = library;
    this.token = token;
    this.version = version;
    this.thumbnail = limited(thumbnail, THUMBNAIL_CONCURRENCY);
    this.staticDir = staticDir;
    this.port = null;
    this.hub = hub ?? new EventHub({ runtimeDir: config.get().paths.runtime, snapshot: () => this.snapshot(), logger });
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(error => {
        this.logger.error('Web request failed', { url: request.url, error: error.message });
        if (!response.headersSent) this.json(response, 500, { error: error.message });
        else response.end();
      });
    });
    this.routes = this.buildRoutes();
  }

  // Listens on 127.0.0.1; a taken port falls back to a free one. Resolves to the port in use.
  async listen(port) {
    const attempt = wanted => new Promise((resolve, reject) => {
      const failed = error => reject(error);
      this.server.once('error', failed);
      this.server.listen(wanted, '127.0.0.1', () => {
        this.server.off('error', failed);
        resolve(this.server.address().port);
      });
    });
    try {
      this.port = await attempt(port);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      this.port = await attempt(0);
    }
    await this.hub.start();
    return this.port;
  }

  async close() {
    await this.hub.stop();
    this.server.closeAllConnections?.();
    await new Promise(resolve => this.server.close(() => resolve()));
  }

  // What a page shows: the status (DisplayService.status, as status --json), the durations in force, the settings an
  // item's own values fall back to, and the version
  async snapshot() {
    const { display } = this.config.get();
    return {
      status: await this.display.status(),
      durations: await this.display.durations(),
      settings: { video_loop: display.video_loop ?? 'loop' },
      version: this.version
    };
  }

  buildRoutes() {
    const monitorAction = (name, run) => ['POST', new RegExp(`^/api/monitors/([^/]+)/${name}$`), async (request, match) => {
      const monitor = decodeURIComponent(match[1]);
      return run(monitor, await this.body(request));
    }];
    const changed = { changed: true };
    return [
      ['GET', /^\/$/, (request, match, response) => this.page(response, 'index.html')],
      ['GET', /^\/library$/, (request, match, response) => this.page(response, 'library.html')],
      ['GET', /^\/static\/([\w.-]+)$/, (request, match, response) => this.staticFile(response, match[1])],
      ['GET', /^\/thumbs\/(\d+)\.jpg$/, (request, match, response) => this.thumbnailFile(response, Number(match[1]))],
      ['GET', /^\/api\/state$/, () => this.snapshot()],
      ['GET', /^\/api\/events$/, async (request, match, response) => {
        await this.hub.add(response);
        return { streamed: true };
      }],
      // With the library's filters: { query, tag, keywords } (lists of strings) and random, kept for later nexts as
      // `next --tag ...` keeps them
      monitorAction('next', async (monitor, body) => {
        const filters = {};
        for (const key of ['query', 'tag', 'keywords']) if (body[key] !== undefined) filters[key] = this.strings(body[key], key);
        if (body.random !== undefined) filters.random = Boolean(body.random);
        return { ...changed, ...this.playing((await this.display.next({ monitor, ...filters })).playing) };
      }),
      monitorAction('prev', async monitor => ({ ...changed, ...this.playing((await this.display.prev({ monitor })).playing) })),
      monitorAction('keep', async (monitor, { rating, next = false }) => {
        const result = await this.rating.keep(rating, { monitor, next: Boolean(next) });
        return { ...changed, item: mediaJson(this.database, result.rated), warnings: result.warnings, ...(result.playing ? { playing: this.playing(result.playing) } : {}) };
      }),
      monitorAction('skip', async monitor => {
        const result = await this.rating.skip({ monitor });
        return { ...changed, item: mediaJson(this.database, result.rated), warnings: result.warnings, playing: this.playing(result.playing) };
      }),
      monitorAction('speed', async (monitor, { value }) => ({ ...changed, speed: (await this.display.speed(this.text(value, 'value'), { monitor })).speed })),
      monitorAction('dim', async (monitor, { value }) => {
        const { dim, shown = dim } = await this.display.dim(this.text(value, 'value'), { monitor });
        return { ...changed, dim, shown };
      }),
      monitorAction('bounce', async (monitor, { value }) => {
        const { bounce, bouncing } = await this.display.bounce(this.text(value, 'value'), { monitor });
        return { ...changed, bounce, bouncing };
      }),
      ['GET', /^\/api\/media$/, (request, match, response, url) => this.library.list(listOptions(url.searchParams))],
      ['GET', /^\/api\/media\/facets$/, () => this.library.facets()],
      ['GET', /^\/api\/media\/(\d+)$/, (request, match) => this.library.item(match[1])],
      ['POST', /^\/api\/media\/(\d+)\/rating$/, async (request, match) => ({ ...changed, ...await this.library.rate(match[1], (await this.body(request)).rating) })],
      ['PATCH', /^\/api\/media\/(\d+)$/, async (request, match) => ({ ...changed, item: await this.library.adjust(match[1], await this.body(request)) })],
      ['POST', /^\/api\/media\/(\d+)\/play$/, async (request, match) => {
        const { monitor } = await this.body(request);
        return { ...changed, ...this.playing(await this.library.play(match[1], this.text(monitor, 'monitor'))) };
      }],
      ['POST', /^\/api\/undo$/, async () => {
        const { action, media, warnings } = await this.rating.undo();
        return { ...changed, action, item: media ? mediaJson(this.database, media) : null, warnings };
      }],
      ['POST', /^\/api\/mode$/, async request => {
        const { mode, monitor } = await this.body(request);
        const result = await this.display.mode(this.text(mode, 'mode'), { monitor });
        return { ...changed, mode: result.mode, held: result.held ?? null };
      }],
      ['POST', /^\/api\/daemon$/, async request => {
        const { running } = await this.body(request);
        if (typeof running !== 'boolean') throw new HttpError(400, 'Give running as true or false');
        const result = running ? await this.display.start({}) : await this.display.stop({});
        return { ...changed, action: result.action };
      }],
      ['POST', /^\/api\/parts$/, async request => ({ ...changed, ...await this.setParts(await this.body(request)) })],
      ['POST', /^\/api\/durations$/, async request => {
        const { image, video, clear = false } = await this.body(request);
        const options = { clear: Boolean(clear) };
        if (image !== undefined) options.imageDuration = this.text(image, 'image');
        if (video !== undefined) options.videoDuration = this.text(video, 'video');
        return { ...changed, durations: await this.display.setDurations(options) };
      }]
    ];
  }

  async handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const refused = refusal(request, url, { token: this.token, port: this.port });
    if (refused) return this.json(response, refused.status, { error: refused.error });
    // The first visit: the token becomes the cookie and leaves the address bar
    if (url.searchParams.has('token')) {
      response.writeHead(303, { ...SECURITY_HEADERS, 'set-cookie': sessionCookie(this.token), location: url.pathname });
      return response.end();
    }
    const route = this.routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
    if (!route) {
      const known = this.routes.some(([, pattern]) => pattern.test(url.pathname));
      return this.json(response, known ? 405 : 404, { error: known ? 'Method not allowed' : 'Not found' });
    }
    const [method, pattern, run] = route;
    let result;
    try {
      result = await run(request, pattern.exec(url.pathname), response, url);
    } catch (error) {
      const status = error.status ?? 400;
      this.logger.warn('Web request refused', { method, path: url.pathname, error: error.message });
      return this.json(response, status, { error: error.message });
    }
    if (result?.streamed || response.headersSent) return;
    if (result?.changed) {
      delete result.changed;
      this.hub.changed({ state: true });
    }
    this.json(response, 200, result ?? {});
  }

  playing(playing) {
    return playingJson(this.database, playing);
  }

  // Parts on and off from the page: { wallpaper, visualizer }, each true, false or left out. Parts turned on start the
  // daemon when it is stopped. Returns the status afterwards.
  async setParts(change) {
    const on = Object.entries(change).filter(([, value]) => value === true).map(([part]) => part);
    const off = Object.entries(change).filter(([, value]) => value === false).map(([part]) => part);
    if (!on.length && !off.length) throw new HttpError(400, 'Give wallpaper or visualizer as true or false');
    if (on.length) await this.display.start(Object.fromEntries(on.map(part => [part, true])));
    if (off.length) await this.display.stop(Object.fromEntries(off.map(part => [part, true])));
    return { status: await this.display.status() };
  }

  strings(value, name) {
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.map(item => item.trim()).filter(Boolean);
    throw new HttpError(400, `${name} must be a list of strings`);
  }

  text(value, name) {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new HttpError(400, `Missing ${name}`);
  }

  async body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new HttpError(400, 'The body must be a JSON object');
    }
  }

  json(response, status, body) {
    response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  // A page, with this run's token for the changing requests' header. Only a request with the cookie gets here.
  async page(response, name) {
    const html = await fs.readFile(path.join(this.staticDir, name), 'utf8');
    response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    response.end(html.replace('{{token}}', this.token));
    return { streamed: true };
  }

  async staticFile(response, name) {
    const type = TYPES[path.extname(name)];
    if (!type || type === TYPES['.html']) throw new HttpError(404, 'Not found');
    const file = path.join(this.staticDir, name);
    const content = await fs.readFile(file).catch(() => null);
    if (!content) throw new HttpError(404, 'Not found');
    response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache' });
    response.end(content);
    return { streamed: true };
  }

  // A library item's thumbnail, made when it has none (once per item at a time, at the lowest CPU priority)
  async thumbnailFile(response, id) {
    const media = this.database.getMedia(id);
    if (!media?.path) throw new HttpError(404, 'No such item');
    const file = await this.thumbnail(media);
    if (!file) throw new HttpError(404, 'No thumbnail for this item');
    response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300' });
    fs.createReadStream(file).pipe(response);
    return { streamed: true };
  }
}

// GET /api/media's query string as LibraryService.list takes it: query and tag repeat; keywords is space-separated
function listOptions(params) {
  const options = {};
  for (const key of ['kind', 'status', 'min_rating', 'sort', 'page', 'per_page']) {
    if (params.get(key)) options[key] = params.get(key);
  }
  const query = params.getAll('query').filter(Boolean);
  const tag = params.getAll('tag').filter(Boolean);
  const keywords = (params.get('keywords') ?? '').split(/\s+/).filter(Boolean);
  if (query.length) options.query = query;
  if (tag.length) options.tag = tag;
  if (keywords.length) options.keywords = keywords;
  return options;
}

// fn limited to concurrency calls at once, the rest waiting their turn
function limited(fn, concurrency) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= concurrency || !waiting.length) return;
    running++;
    const { args, resolve, reject } = waiting.shift();
    Promise.resolve().then(() => fn(...args)).then(resolve, reject).finally(() => {
      running--;
      next();
    });
  };
  return (...args) => new Promise((resolve, reject) => {
    waiting.push({ args, resolve, reject });
    next();
  });
}
