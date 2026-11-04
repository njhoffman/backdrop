import { expect } from 'chai';
import fs from 'fs-extra';
import net from 'net';
import os from 'os';
import path from 'path';
import { SleevedWatcher, sleevedSocket } from '../../src/visualizer/sleeved.js';

describe('SleevedWatcher', () => {
  let dir, socket, server, watcher, hellos;
  const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); expect(check()).to.equal(true); };
  const listen = greeting => new Promise(resolve => {
    const clients = [];
    const created = net.createServer(client => {
      clients.push(client);
      client.on('error', () => {});
      client.write(greeting);
    });
    created.closeAll = () => new Promise(done => { clients.forEach(client => client.destroy()); created.close(done); });
    created.listen(socket, () => resolve(created));
  });
  const HELLO = '{"type":"hello","protocol":1,"version":"0.37.0"}\n{"type":"playback"}\n';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-sleeved-'));
    socket = path.join(dir, 's.sock');
    hellos = 0;
    watcher = new SleevedWatcher({ onHello: () => hellos++, socket, retry: 10 });
  });

  afterEach(async () => {
    watcher.stop();
    await server?.closeAll();
    server = null;
    await fs.remove(dir);
  });

  it('finds the socket where sleeve looks for it', () => {
    expect(sleevedSocket({ XDG_RUNTIME_DIR: '/run/user/1000' })).to.equal('/run/user/1000/sleeve/sleeved.sock');
  });

  it('reports the hello once per connection, whatever follows it', async () => {
    server = await listen(HELLO);
    watcher.start();
    await until(() => hellos === 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(hellos).to.equal(1);
  });

  it('takes a hello split across chunks', async () => {
    server = net.createServer(client => {
      client.write('{"type":"he');
      setTimeout(() => client.write('llo"}\n'), 5);
    });
    server.closeAll = () => new Promise(done => server.close(done));
    await new Promise(resolve => server.listen(socket, resolve));
    watcher.start();
    await until(() => hellos === 1);
    watcher.stop();
  });

  it('waits for sleeved to appear, and reports it restarting', async () => {
    watcher.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(hellos).to.equal(0);
    server = await listen(HELLO);
    await until(() => hellos === 1);

    await server.closeAll();
    server = await listen(HELLO);
    await until(() => hellos === 2);
  });

  it('ignores a first message that is not a hello', async () => {
    server = await listen('nonsense\n');
    watcher.start();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(hellos).to.equal(0);
  });

  it('stops trying once stopped, and can start again', async () => {
    watcher.start();
    watcher.stop();
    server = await listen(HELLO);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(hellos).to.equal(0);
    watcher.start();
    await until(() => hellos === 1);
  });
});
