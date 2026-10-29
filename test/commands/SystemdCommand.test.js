import { expect } from 'chai';
import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SystemdCommand } from '../../src/commands/SystemdCommand.js';

const hasVerify = spawnSync('systemd-analyze', ['--version']).status === 0;

describe('SystemdCommand', () => {
  let dir, bin;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-systemd-'));
    bin = path.join(dir, 'bin');
    await fs.outputFile(path.join(bin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  });
  afterEach(async () => { await fs.remove(dir); });

  const unit = env => new SystemdCommand(null, null, null, {
    execPath: '/opt/node 100%/bin/node', entryPoint: '/src/backdrop/src/index.js', env
  }).generate('9.9.9');

  it('starts node through the embedded PATH, so version manager shims survive upgrades', () => {
    const text = unit({ PATH: `${bin}:/usr/bin` });
    expect(text).to.include('ExecStart=/usr/bin/env node "/src/backdrop/src/index.js" daemon');
    expect(text).to.include(`Environment="PATH=${bin}:/usr/bin"`);
    expect(text).to.include('Restart=on-failure').and.include('WantedBy=graphical-session.target');
    expect(text).to.include('import-environment DISPLAY XAUTHORITY');
  });

  it('falls back to the absolute node path, escaping specifiers and quotes', () => {
    const text = unit({ PATH: '/nowhere' });
    expect(text).to.include('ExecStart="/opt/node 100%%/bin/node" "/src/backdrop/src/index.js" daemon');
    expect(unit({})).to.not.include('Environment=');
  });

  (hasVerify ? it : it.skip)('passes systemd-analyze verify', async () => {
    const file = path.join(dir, 'backdrop.service');
    await fs.writeFile(file, new SystemdCommand(null, null, null, { env: { PATH: process.env.PATH } }).generate('9.9.9'));
    const result = spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8' });
    expect(result.stderr).to.equal('');
    expect(result.status).to.equal(0);
  });
});
