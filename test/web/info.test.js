import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { webPath } from '../../src/display/runtimeFiles.js';
import { processAlive, readWebInfo, webAddress } from '../../src/web/info.js';

describe('web info', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-webinfo-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('reads the running server, ignoring a file whose process is gone or that is this process\'s own', async () => {
    expect(await readWebInfo(dir)).to.equal(null);
    await fs.writeJson(webPath(dir), { pid: 42, port: 7737, token: 't' });
    expect(await readWebInfo(dir, { alive: () => true, self: 1 })).to.deep.equal({ pid: 42, port: 7737, token: 't' });
    expect(await readWebInfo(dir, { alive: () => false, self: 1 })).to.equal(null);
    expect(await readWebInfo(dir, { alive: () => true, self: 42 })).to.equal(null);
    await fs.writeFile(webPath(dir), 'not json');
    expect(await readWebInfo(dir, { alive: () => true })).to.equal(null);
  });

  it('gives the address with or without the token, and knows a live process', () => {
    expect(webAddress(7737, 'abc')).to.equal('http://127.0.0.1:7737/?token=abc');
    expect(webAddress(7737)).to.equal('http://127.0.0.1:7737/');
    expect(processAlive(process.pid)).to.equal(true);
  });
});
