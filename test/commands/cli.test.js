import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const entry = fileURLToPath(new URL('../../src/index.js', import.meta.url));

describe('CLI command registration', function () {
  this.timeout(15000);
  let dir, env;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-cli-'));
    env = { ...process.env, PEXELS_API: '',
      ...Object.fromEntries(['CONFIG', 'DATA', 'CACHE', 'RUNTIME_DIR'].map(key => [key === 'RUNTIME_DIR' ? 'XDG_RUNTIME_DIR' : `XDG_${key}_HOME`, path.join(dir, key)])) };
  });
  afterEach(async () => { await fs.remove(dir); });
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 10000 });

  it('registers every ported command and prints help without an API key', () => {
    const result = run('--help');
    expect(result.status).to.equal(0);
    for (const command of ['keep', 'skip', 'undo', 'go-next', 'search-images', 'search-videos', 'download', 'list-images', 'list-videos', 'stats', 'purge']) {
      expect(result.stdout).to.include(command);
    }
    expect(result.stderr).to.equal('');
  });

  it('runs offline commands and rejects unknown commands with a failing exit code', () => {
    expect(run('stats').status).to.equal(0);
    expect(run('list-images', '--rated', 'portrait', '--no-local').status).to.equal(0);
    expect(run('undo').status).to.equal(0);
    expect(run('purge', '--dry-run').status).to.equal(0);
    const result = run('bogus');
    expect(result.status).to.equal(1);
    expect(result.stderr).to.include('unknown command');
  });

  it('validates commands before display or API access and reports a missing credential only for search', () => {
    let result = run('keep', '2junk');
    expect(result.status).to.equal(1); expect(result.stderr).to.include('integer');
    result = run('search-images', 'ocean', '--resolution', '1920x1080');
    expect(result.status).to.equal(1); expect(result.stderr).to.include('sources.pexels.api_key');
    result = run('download', '--total', 'bad');
    expect(result.status).to.equal(1); expect(result.stderr).to.include('Total');
    result = run('skip', '--monitor', 'DP-1');
    expect(result.status).to.equal(1); expect(result.stderr).to.include('daemon is not running');
  });
});
