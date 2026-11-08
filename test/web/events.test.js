import { expect } from 'chai';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { statePath } from '../../src/display/Daemon.js';
import { EventHub } from '../../src/web/events.js';
import { FakeMpvClient, silentLogger } from '../helpers/fakes.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A response that records what is written to it
class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.ended = false;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(text) {
    this.written.push(text);
  }

  end() {
    this.ended = true;
  }

  get events() {
    return this.written.filter(text => text.startsWith('event: state')).map(text => JSON.parse(text.split('data: ')[1]));
  }
}

describe('EventHub', () => {
  let dir, hub, watched, clients, count;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-events-'));
    clients = new Map();
    count = 0;
    hub = new EventHub({
      runtimeDir: dir, logger: silentLogger, settle: 5, heartbeat: 0,
      snapshot: async () => ({ count: ++count }),
      watch: (folder, listener) => {
        watched = listener;
        const watcher = new EventEmitter();
        watcher.close = () => { watcher.closed = true; };
        return watcher;
      },
      connect: async socketPath => {
        if (socketPath.endsWith('down.sock')) throw new Error('refused');
        const client = new FakeMpvClient();
        clients.set(socketPath, client);
        return client;
      }
    });
  });

  afterEach(async () => {
    await hub.stop();
    await fs.remove(dir);
  });

  const writeState = sockets => fs.writeJson(statePath(dir), { pid: process.pid, monitors: sockets.map((socket, index) => ({ name: `M${index}`, socket })) });

  it('sends the snapshot when a page connects, then once per burst of changes', async () => {
    await hub.start();
    const page = new FakeResponse();
    await hub.add(page);
    expect(page.headers['content-type']).to.equal('text/event-stream');
    expect(page.events).to.deep.equal([{ count: 1 }]);

    hub.changed();
    hub.changed();
    await wait(20);
    expect(page.events).to.deep.equal([{ count: 1 }, { count: 2 }]);
  });

  it('follows the mpv sockets state.json lists, sending on their property changes', async () => {
    await writeState(['/run/a.sock', '/run/down.sock']);
    await hub.start();
    expect([...hub.sockets.keys()]).to.deep.equal(['/run/a.sock']);
    expect(clients.get('/run/a.sock').commands.map(command => command[2])).to.deep.equal(['path', 'speed', 'contrast']);

    const page = new FakeResponse();
    await hub.add(page);
    clients.get('/run/a.sock').emit('property-change', { name: 'path', data: '/m/2.mp4' });
    await wait(20);
    expect(page.events).to.have.length(2);

    // The daemon replaced the wallpaper: the old socket is let go, the new one observed
    await writeState(['/run/b.sock']);
    watched('rename', 'state.json');
    await wait(20);
    expect([...hub.sockets.keys()]).to.deep.equal(['/run/b.sock']);
    expect(clients.get('/run/a.sock').closed).to.equal(true);
    watched('change', 'control-1.json');
    await wait(20);
    expect(page.events).to.have.length(3);
  });

  it('drops a page that closed and ends the rest on stop', async () => {
    await hub.start();
    const gone = new FakeResponse();
    const open = new FakeResponse();
    await hub.add(gone);
    await hub.add(open);
    gone.emit('close');
    hub.changed();
    await wait(20);
    expect(gone.events).to.have.length(1);
    expect(open.events).to.have.length(2);
    await hub.stop();
    expect(open.ended).to.equal(true);
  });
});
