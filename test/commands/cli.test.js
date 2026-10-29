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
    run('stats');
    const result = run('--help');
    expect(result.status).to.equal(0);
    for (const command of ['keep', 'skip', 'undo', 'go-next', 'search-images', 'search-videos', 'download', 'list-images', 'list-videos', 'stats', 'purge', 'dim', 'rescan']) {
      expect(result.stdout).to.include(command);
    }
    expect(result.stderr).to.equal('');
  });

  it('prints a zsh completion script for every registered command without the version line', () => {
    run('stats');
    const result = run('completion', 'zsh');
    expect(result.status).to.equal(0);
    expect(result.stderr).to.equal('');
    expect(result.stdout).to.match(/^#compdef backdrop/);
    for (const command of ['keep', 'pending', 'search-videos', 'list-images', 'dim', 'completion']) {
      expect(result.stdout).to.include(`        ${command})`);
    }
    const unsupported = run('completion', 'fish');
    expect(unsupported.status).to.equal(1);
    expect(unsupported.stderr).to.include('Unsupported shell: fish');
  });

  it('keeps piped output free of escape codes, symbols and the version line unless FORCE_COLOR is set', () => {
    run('stats');
    const plain = run('stats');
    expect(plain.stdout).to.not.include('\x1b[');
    expect(plain.stdout).to.match(/^ {2}image +0 +0/m);
    expect(plain.stderr).to.equal('');
    env.FORCE_COLOR = '3';
    const forced = run('stats');
    expect(forced.stdout).to.include('\x1b[');
    expect(forced.stderr).to.equal('');
  });

  it('reports a newly created config on stderr only, once', () => {
    const first = run('stats');
    expect(first.stderr).to.include('Created default config file at:');
    expect(first.stdout).to.not.include('Created default config');
    expect(run('stats').stderr).to.equal('');
  });

  it('shows the status when run without arguments', () => {
    const result = run();
    expect(result.status).to.equal(0);
    expect(result.stdout).to.include('Mode: video').and.include('Daemon: not running');
  });

  it('runs offline commands and rejects unknown commands with a failing exit code', () => {
    expect(run('stats').status).to.equal(0);
    expect(run('list-images', '--rated', 'portrait', '--no-local').status).to.equal(0);
    expect(run('undo').status).to.equal(0);
    expect(run('purge', '--dry-run').status).to.equal(0);
    expect(run('rescan').status).to.equal(0);
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
