import { expect } from 'chai';
import path from 'path';
import os from 'os';
import { ImportCommand } from '../../src/commands/ImportCommand.js';
import { makeConfig, silentLogger } from '../helpers/fakes.js';

describe('ImportCommand', () => {
  let config;
  let calls;
  let appended;
  let output;
  let originalLog;
  let originalExitCode;

  function makeCommand({ summary = {}, monitors = async () => [] } = {}) {
    const importer = {
      importDirs: async (dirs, options) => {
        calls.push({ dirs, resolution: options.resolution });
        options.onFile('/src/a.png', { status: 'imported' });
        options.onFile('/src/b.png', { status: 'unchanged' });
        options.onFile('/src/c.png', { status: 'too_small', detail: '320x240' });
        return { scanned: 3, unchanged: 1, imported: [7], duplicates: 0, tooSmall: 1, unsupported: 0, failed: 0, ...summary };
      }
    };
    const control = { appendMedia: async ids => { appended.push(ids); return { 'DP-3': ids.length }; } };
    return new ImportCommand(config, null, silentLogger, { importer, control, monitors });
  }

  beforeEach(() => {
    config = makeConfig({ 'library.import_dirs': ['/walls/a', '/walls/b'] });
    calls = [];
    appended = [];
    output = [];
    originalLog = console.log;
    originalExitCode = process.exitCode;
    console.log = (...args) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  });

  const plain = () => output.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  it('imports the configured directories by default', async () => {
    await makeCommand().import();
    expect(calls[0].dirs).to.deep.equal(['/walls/a', '/walls/b']);
  });

  it('imports directories given on the command line, resolved and expanded', async () => {
    await makeCommand().import(['~/x', 'rel']);
    expect(calls[0].dirs).to.deep.equal([path.join(os.homedir(), 'x'), path.resolve('rel')]);
  });

  it('fails without any directory', async () => {
    config.set('library.import_dirs', []);
    try {
      await makeCommand().import();
      expect.fail('should have thrown');
    } catch (error) {
      expect(error.message).to.include('library.import_dirs is empty');
    }
  });

  it('records ratings against the primary monitor, or none without X', async () => {
    const monitors = async () => [
      { name: 'DP-1', width: 2560, height: 1440, primary: false },
      { name: 'DP-2', width: 1080, height: 1920, primary: true }
    ];
    await makeCommand({ monitors }).import();
    await makeCommand({ monitors: async () => { throw new Error('no display'); } }).import();

    expect(calls.map(c => c.resolution)).to.deep.equal(['1080x1920', null]);
  });

  it('prints changed files and a summary, and appends new media to the running daemon', async () => {
    await makeCommand().import();

    expect(plain()).to.include('imported /src/a.png');
    expect(plain()).to.not.include('/src/b.png');
    expect(plain()).to.include('too small /src/c.png (320x240)');
    expect(plain()).to.include('Scanned 3, imported 1, unchanged 1, duplicates 0, below 1024x768 1');
    expect(plain()).to.include('DP-3: added 1 to the playlist');
    expect(appended).to.deep.equal([[7]]);
  });

  it('sets a failing exit code when any file failed', async () => {
    await makeCommand({ summary: { failed: 2 } }).import();
    expect(process.exitCode).to.equal(1);
  });
});
