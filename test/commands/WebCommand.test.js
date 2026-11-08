import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { WebCommand, address } from '../../src/commands/WebCommand.js';
import { webPath } from '../../src/display/runtimeFiles.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('WebCommand', () => {
  let dir, db, config, lines, servers, stop;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-webcmd-'));
    config = makeConfig({ 'paths.runtime': path.join(dir, 'run') });
    db = new DatabaseManager();
    db.initialize(':memory:');
    lines = [];
    sinon.stub(console, 'log').callsFake(line => lines.push(line));
    sinon.stub(console, 'error').callsFake(line => lines.push(line));
    servers = [];
  });

  afterEach(async () => {
    sinon.restore();
    db.close();
    await fs.remove(dir);
  });

  // The server stands in with the port it was asked for, or busy's port when that one is taken
  function command({ busy = null, alive = () => false } = {}) {
    let release;
    stop = () => release();
    return new WebCommand(config, db, silentLogger, {
      alive,
      until: () => new Promise(resolve => { release = resolve; }),
      createServer: options => {
        const server = { options, closed: false, listen: async port => (port === busy ? 40000 : port), close: async () => { server.closed = true; } };
        servers.push(server);
        return server;
      }
    });
  }

  it('serves on web.port, records itself while it runs and removes the record on stop', async () => {
    const running = command().run();
    await new Promise(resolve => setTimeout(resolve, 20));
    const info = await fs.readJson(webPath(config.get().paths.runtime));
    expect(info).to.include({ pid: process.pid, port: 7737 });
    expect(info.token).to.equal(servers[0].options.token);
    expect((await fs.stat(webPath(config.get().paths.runtime))).mode & 0o777).to.equal(0o600);
    expect(lines.at(-1)).to.equal(address(7737, info.token));
    expect(servers[0].options.rating.control).to.equal(servers[0].options.display.control);

    stop();
    expect(await running).to.equal(7737);
    expect(servers[0].closed).to.equal(true);
    expect(await fs.pathExists(webPath(config.get().paths.runtime))).to.equal(false);
  });

  it('says when the port was taken and which one it uses', async () => {
    const running = command({ busy: 8000 }).run({ port: '8000' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lines.join('\n')).to.include('Port 8000 is taken; serving on 40000 instead');
    stop();
    expect(await running).to.equal(40000);
  });

  it('prints the running server\'s address instead of starting another', async () => {
    await fs.outputJson(webPath(config.get().paths.runtime), { pid: 1, port: 7737, token: 'abc' });
    expect(await command({ alive: pid => pid === 1 }).run()).to.equal(null);
    expect(lines.at(-1)).to.include('Already serving (pid 1) at http://127.0.0.1:7737/?token=abc');
    expect(servers).to.deep.equal([]);
  });

  it('refuses a port out of range', async () => {
    let caught;
    try { await command().run({ port: '70000' }); } catch (error) { caught = error; }
    expect(caught.message).to.include('Invalid port: 70000');
  });
});
