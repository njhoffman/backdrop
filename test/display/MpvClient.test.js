import { expect } from 'chai';
import net from 'net';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { MpvClient } from '../../src/display/MpvClient.js';

// Minimal mpv IPC stand-in: `respond(message, socket)` decides what to write back
function startServer(socketPath, respond) {
  const sockets = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        respond(JSON.parse(line), socket);
      }
    });
  });
  return new Promise(resolve => server.listen(socketPath, () => resolve({ server, sockets })));
}

const reply = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);

describe('MpvClient', () => {
  let tempDir;
  let socketPath;
  let server;
  let sockets;
  let client;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-mpv-'));
    socketPath = path.join(tempDir, 'mpv.sock');
  });

  afterEach(async () => {
    client?.close();
    client = null;
    sockets?.forEach(socket => socket.destroy());
    await new Promise(resolve => (server ? server.close(resolve) : resolve()));
    server = null;
    await fs.remove(tempDir);
  });

  async function serve(respond) {
    ({ server, sockets } = await startServer(socketPath, respond));
    client = await MpvClient.connect(socketPath, { timeout: 200 });
  }

  it('resolves a command with the data of the matching reply', async () => {
    await serve((message, socket) => {
      if (message.command[1] === 'speed') {
        reply(socket, { data: 0.8, request_id: message.request_id, error: 'success' });
      }
    });

    expect(await client.getProperty('speed')).to.equal(0.8);
  });

  it('matches replies that arrive out of order', async () => {
    await serve((message, socket) => {
      const data = message.command[1];
      setTimeout(() => reply(socket, { data, request_id: message.request_id, error: 'success' }),
        data === 'first' ? 30 : 0);
    });

    const [first, second] = await Promise.all([client.getProperty('first'), client.getProperty('second')]);
    expect([first, second]).to.deep.equal(['first', 'second']);
  });

  it('sends commands as JSON with a request id', async () => {
    const received = [];
    await serve((message, socket) => {
      received.push(message);
      reply(socket, { request_id: message.request_id, error: 'success' });
    });

    await client.setProperty('speed', 1.5);
    await client.command('loadlist', '/p.m3u', 'replace');

    expect(received.map(m => m.command)).to.deep.equal([
      ['set_property', 'speed', 1.5],
      ['loadlist', '/p.m3u', 'replace']
    ]);
    expect(received[0].request_id).to.not.equal(received[1].request_id);
  });

  it('rejects when mpv reports an error', async () => {
    await serve((message, socket) => reply(socket, { request_id: message.request_id, error: 'property unavailable' }));

    try {
      await client.getProperty('path');
      expect.fail('should have rejected');
    } catch (error) {
      expect(error.message).to.equal('mpv get_property failed: property unavailable');
    }
  });

  it('times out when mpv does not answer', async () => {
    await serve(() => {});

    try {
      await client.getProperty('path');
      expect.fail('should have rejected');
    } catch (error) {
      expect(error.message).to.include('timed out');
    }
    expect(client.pending.size).to.equal(0);
  });

  it('emits events, including split and batched lines', async () => {
    await serve(() => {});
    const events = [];
    client.on('event', event => events.push(event.event));
    const changes = [];
    client.on('property-change', event => changes.push(event.data));

    const payload =
      `${JSON.stringify({ event: 'property-change', id: 1, name: 'path', data: '/a.mp4' })}\n` +
      `${JSON.stringify({ event: 'file-loaded' })}\n`;
    sockets[0].write(payload.slice(0, 20));
    await new Promise(resolve => setTimeout(resolve, 10));
    sockets[0].write(payload.slice(20));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(events).to.deep.equal(['property-change', 'file-loaded']);
    expect(changes).to.deep.equal(['/a.mp4']);
  });

  it('ignores lines that are not JSON', async () => {
    await serve((message, socket) => {
      socket.write('garbage\n');
      reply(socket, { data: 1, request_id: message.request_id, error: 'success' });
    });

    expect(await client.getProperty('x')).to.equal(1);
  });

  it('rejects pending commands and emits close when the socket closes', async () => {
    await serve((message, socket) => socket.destroy());
    const closed = new Promise(resolve => client.once('close', resolve));

    try {
      await client.getProperty('path');
      expect.fail('should have rejected');
    } catch (error) {
      expect(error.message).to.equal('mpv connection closed');
    }
    await closed;
    try {
      await client.command('stop');
      expect.fail('should have rejected');
    } catch (error) {
      expect(error.message).to.equal('mpv connection is not open');
    }
  });

  it('retries connecting and reports the socket on failure', async () => {
    const started = Date.now();
    try {
      await MpvClient.connect(socketPath, { attempts: 3, delay: 20 });
      expect.fail('should have rejected');
    } catch (error) {
      expect(error.message).to.include(`Cannot connect to mpv at ${socketPath}`);
    }
    expect(Date.now() - started).to.be.at.least(40);
  });

  it('connects once the socket appears', async () => {
    setTimeout(async () => {
      ({ server, sockets } = await startServer(socketPath, () => {}));
    }, 50);

    client = await MpvClient.connect(socketPath, { attempts: 20, delay: 20 });
    expect(client.socket).to.not.be.null;
  });
});
