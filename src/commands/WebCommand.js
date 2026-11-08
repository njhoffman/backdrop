import fs from 'fs-extra';
import { webPath } from '../display/runtimeFiles.js';
import { DisplayService } from '../services/DisplayService.js';
import { LibraryService } from '../services/LibraryService.js';
import { RatingService } from '../services/RatingService.js';
import { VisualizerService } from '../services/VisualizerService.js';
import { out } from '../utils/output.js';
import { createToken } from '../web/auth.js';
import { WebServer } from '../web/server.js';

// `backdrop web`: the local web interface (docs/specs/web.md) until Ctrl-C or SIGTERM. It prints the address with
// this run's token, which the page swaps for a cookie, and records { pid, port, token } in web.json in the runtime dir
// for the rest of the CLI; a second `backdrop web` prints the running one's address instead.
export class WebCommand {
  constructor(config, database, logger, {
    version = null,
    createServer = options => new WebServer(options),
    // Resolves when the server should stop; SIGINT or SIGTERM by default
    until = () => new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    }),
    alive = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM';
      }
    }
  } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.version = version;
    this.createServer = createServer;
    this.until = until;
    this.alive = alive;
  }

  get infoPath() {
    return webPath(this.config.get().paths.runtime);
  }

  // The running server's { pid, port, token }, or null
  async running() {
    const info = await fs.readJson(this.infoPath).catch(() => null);
    return info && info.pid !== process.pid && this.alive(info.pid) ? info : null;
  }

  async run(options = {}) {
    const existing = await this.running();
    if (existing) {
      out.info(`Already serving (pid ${existing.pid}) at ${address(existing.port, existing.token)}`);
      return null;
    }
    const wanted = options.port === undefined ? this.config.get().web.port : parsePort(options.port);
    const token = createToken();
    const display = new DisplayService({ config: this.config, database: this.database, logger: this.logger });
    const rating = new RatingService({ config: this.config, database: this.database, logger: this.logger, control: display.control });
    const library = new LibraryService({ config: this.config, database: this.database, logger: this.logger, control: display.control, rating });
    // Reads the visualizer section again on each request, so presets saved since the start and hand edits show
    const visualizer = new VisualizerService({ config: this.config, logger: this.logger, control: display.control, reload: true });
    const server = this.createServer({ config: this.config, database: this.database, logger: this.logger, display, rating, library, visualizer, token, version: this.version });
    const port = await server.listen(wanted);
    await fs.ensureDir(this.config.get().paths.runtime, 0o700);
    await fs.writeJson(this.infoPath, { pid: process.pid, port, token }, { mode: 0o600 });
    if (port !== wanted) out.warn(`Port ${wanted} is taken; serving on ${port} instead`);
    out.success('Serving the web interface; open this address (it carries this run\'s token), Ctrl-C stops it:');
    // On its own line and unstyled, so it copies whole
    out.print(address(port, token));
    this.logger.info('Web interface started', { port, pid: process.pid });
    try {
      await this.until();
    } finally {
      await server.close();
      // Only this run's file: another `backdrop web` may have started meanwhile after this one's was lost
      const info = await fs.readJson(this.infoPath).catch(() => null);
      if (info?.pid === process.pid) await fs.remove(this.infoPath);
      this.logger.info('Web interface stopped', { port });
    }
    return port;
  }
}

export function address(port, token) {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value} (use 1 to 65535)`);
  return port;
}
