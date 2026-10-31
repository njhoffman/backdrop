import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import sinon from 'sinon';
import { CompletionCommand } from '../../src/commands/CompletionCommand.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { makeConfig } from '../helpers/fakes.js';

const capture = fileURLToPath(new URL('../helpers/zsh-capture.zsh', import.meta.url));
const hasZsh = spawnSync('zsh', ['-fc', 'zmodload zsh/zpty'], { encoding: 'utf8' }).status === 0;
const hasBash = spawnSync('bash', ['-c', 'compgen -W x'], { encoding: 'utf8' }).status === 0;
const hasSqlite = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;

function program() {
  const root = new Command('backdrop');
  root.command('mode').description('Switch modes').argument('[mode]', 'mode');
  root.command('next').description('Play the next item').option('-m, --monitor <name>', 'Target monitor (default: the one under the pointer)')
    .option('--query <queries...>', 'Saved search queries').option('--tag <tags...>', 'Tags');
  root.command('speed').description('Set the playing video\'s speed').argument('<value>', 'speed');
  root.command('list-videos').description('List videos')
    .option('--rated [orientation]', 'Kept items [any]').option('--source <name>', 'Source')
    .option('--keywords <words...>', 'Words').option('--no-local', 'Exclude local').option('--playlist <file>', 'M3U');
  root.command('import').argument('[dirs...]', 'Directories');
  root.command('keep').argument('[rating]', 'Rating').option('-m, --monitor <name>', 'Target monitor').option('-n, --next', 'Then next');
  return root;
}

// A library with three searches (one query in two spellings, one with a space) and tagged media
function fillLibrary(file) {
  const db = new DatabaseManager();
  db.initialize(file);
  const search = db.db.prepare('INSERT INTO searches (source, query) VALUES (?, ?)');
  for (const query of ['ocean', 'Ocean', 'night sky', 'forest']) search.run('pexels', query);
  const tag = db.db.prepare("INSERT OR IGNORE INTO media_tags (media_id, tag, origin) VALUES (?, ?, 'test')");
  for (const tags of [['sea', 'blue'], ['sea'], ['sea', 'dark sky']]) {
    const id = db.addMedia({ kind: 'image', source: 'local', source_id: tags.join(), path: `/m/${tags.join()}.png`, width: 1920, height: 1080 });
    db.db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(id);
    for (const name of tags) tag.run(id, name);
  }
  return db;
}

describe('CompletionCommand', () => {
  let dir, config, command;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-comp-'));
    config = makeConfig({ 'paths.runtime': path.join(dir, 'run'), 'paths.database': path.join(dir, 'data', 'backdrop.db') });
    command = new CompletionCommand(config, null, null, { sources: { names: () => ['pexels', 'unsplash'] } });
  });
  afterEach(async () => { sinon.restore(); await fs.remove(dir); });

  describe('library values', () => {
    let db;
    beforeEach(async () => {
      await fs.ensureDir(path.join(dir, 'data'));
      db = fillLibrary(config.get().paths.database);
      command.database = db;
    });
    afterEach(() => db.close());

    it('lists saved queries newest first, once per spelling, and tags most used first', () => {
      expect(command.values('queries')).to.deep.equal(['forest', 'night sky', 'Ocean']);
      expect(command.values('tags')).to.deep.equal(['sea', 'blue', 'dark sky']);
      expect(() => command.values('moods')).to.throw('Unknown completion values: moods (available: queries, tags)');
    });

    it('prints one per line for complete-values, and nothing for none', () => {
      const write = sinon.stub(process.stdout, 'write');
      command.printValues('tags');
      db.db.exec('DELETE FROM searches');
      command.printValues('queries');
      write.restore();
      expect(write.args.map(args => args[0])).to.deep.equal(['sea\nblue\ndark sky\n']);
    });
  });

  it('describes every command and builds option and argument specs from the program', () => {
    const script = command.generate('zsh', program(), '9.9.9');
    expect(script).to.match(/^#compdef backdrop\n# zsh completion for backdrop 9\.9\.9/);
    expect(script).to.include("'speed:Set the playing video'\\''s speed'");
    expect(script).to.include("'(-m --monitor)'{-m,--monitor}'[Target monitor (default\\: the one under the pointer)]:name:_backdrop_monitors'");
    expect(script).to.include("'--rated[Kept items \\[any\\]]::orientation:(landscape portrait any)'");
    expect(script).to.include("'--source[Source]:name:(pexels unsplash local)'");
    expect(script).to.include("'*--keywords[Words]:words: '");
    expect(script).to.include("'--no-local[Exclude local]'");
    expect(script).to.include("'::mode:(video image toggle)'");
    expect(script).to.include("':value:(reset 0.5 0.8 1 +0.1 -0.1)'");
    expect(script).to.include("'*:dirs:_directories'");
    expect(script).to.include(`local state='${path.join(dir, 'run', 'state.json')}'`);
  });

  it('rejects unsupported shells', () => {
    expect(() => command.generate('fish', program(), '1.0.0')).to.throw('Unsupported shell: fish (available: zsh, bash)');
  });

  (hasZsh ? describe : describe.skip)('in zsh', function () {
    this.timeout(20000);
    let fpath;
    beforeEach(async () => {
      fpath = path.join(dir, 'fpath');
      await fs.outputFile(path.join(fpath, '_backdrop'), command.generate('zsh', program(), '1.0.0'));
      await fs.outputJson(path.join(dir, 'run', 'state.json'), { pid: 1, monitors: [{ name: 'DP-1' }, { name: 'HDMI-0' }] });
    });
    const complete = line => {
      const out = path.join(dir, `out-${Math.random()}`);
      spawnSync('zsh', ['-f', capture, fpath, line, out], { timeout: 10000 });
      return fs.existsSync(out) ? [...new Set(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean))].sort() : [];
    };

    it('passes zsh syntax checking', () => {
      expect(spawnSync('zsh', ['-n', path.join(fpath, '_backdrop')]).status).to.equal(0);
    });

    it('completes commands, argument values and monitors from the daemon state', () => {
      expect(complete('backdrop ')).to.deep.equal(['import', 'keep', 'list-videos', 'mode', 'next', 'speed']);
      expect(complete('backdrop mode ')).to.deep.equal(['image', 'toggle', 'video']);
      expect(complete('backdrop next --monitor ')).to.deep.equal(['DP-1', 'HDMI-0']);
    });

    (hasSqlite ? it : it.skip)('completes saved queries and tags from the database', async () => {
      await fs.ensureDir(path.join(dir, 'data'));
      fillLibrary(config.get().paths.database).close();
      expect(complete('backdrop next --query ')).to.deep.equal(['Ocean', 'forest', 'night sky']);
      expect(complete('backdrop next --tag ')).to.deep.equal(['blue', 'dark sky', 'sea']);
    });
  });

  (hasBash ? describe : describe.skip)('in bash', () => {
    let script;
    beforeEach(async () => {
      script = path.join(dir, 'backdrop.bash');
      await fs.outputFile(script, command.generate('bash', program(), '1.0.0'));
      await fs.outputJson(path.join(dir, 'run', 'state.json'), { pid: 1, monitors: [{ name: 'DP-1' }, { name: 'HDMI-0' }] });
      await fs.outputFile(path.join(dir, 'work', 'list.m3u'), '');
      await fs.outputFile(path.join(dir, 'work', 'notes.txt'), '');
      await fs.ensureDir(path.join(dir, 'work', 'walls'));
    });
    // Runs the completion function for a command line the way bash would and returns the candidates
    const complete = line => {
      const words = line.split(' ');
      const result = spawnSync('bash', ['-c', `source "$1"; COMP_WORDS=("\${@:2}"); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _backdrop; printf '%s\\n' "\${COMPREPLY[@]}"`,
        'bash', script, ...words], { cwd: path.join(dir, 'work'), encoding: 'utf8' });
      expect(result.stderr).to.equal('');
      return result.stdout.split('\n').filter(Boolean).sort();
    };

    it('passes bash syntax checking', () => {
      expect(spawnSync('bash', ['-n', script]).status).to.equal(0);
    });

    it('completes commands, options, values by position and monitors from the daemon state', () => {
      expect(complete('backdrop ')).to.include.members(['import', 'keep', 'mode', '--help', '--version']);
      expect(complete('backdrop mo')).to.deep.equal(['mode']);
      expect(complete('backdrop mode ')).to.deep.equal(['image', 'toggle', 'video']);
      expect(complete('backdrop keep ')).to.deep.equal(['1', '2', '3']);
      expect(complete('backdrop keep --monitor ')).to.deep.equal(['DP-1', 'HDMI-0']);
      expect(complete('backdrop keep -m DP-1 ')).to.deep.equal(['1', '2', '3']);
      expect(complete('backdrop keep -n ')).to.deep.equal(['1', '2', '3']);
      expect(complete('backdrop keep 2 ')).to.deep.equal([]);
      expect(complete('backdrop keep --')).to.deep.equal(['--help', '--monitor', '--next']);
      expect(complete('backdrop list-videos --source ')).to.deep.equal(['local', 'pexels', 'unsplash']);
      expect(complete('backdrop list-videos --rated ')).to.deep.equal(['any', 'landscape', 'portrait']);
    });

    (hasSqlite ? it : it.skip)('completes saved queries and tags, quoting spaces', async () => {
      await fs.ensureDir(path.join(dir, 'data'));
      fillLibrary(config.get().paths.database).close();
      expect(complete('backdrop next --query ')).to.deep.equal(['Ocean', 'forest', 'night\\ sky']);
      expect(complete('backdrop next --query ni')).to.deep.equal(['night\\ sky']);
      expect(complete('backdrop next --tag ')).to.deep.equal(['blue', 'dark\\ sky', 'sea']);
      expect(complete('backdrop next --tag zz')).to.deep.equal([]);
    });

    it('asks backdrop for the values when sqlite3 is missing', async () => {
      // PATH holds only a stand-in backdrop; compgen and printf are bash builtins
      const bin = path.join(dir, 'bin');
      await fs.outputFile(path.join(bin, 'backdrop'), '#!/bin/sh\n[ "$1 $2" = "complete-values queries" ] && printf \'%s\\n\' "deep sea" coral\n', { mode: 0o755 });
      const result = spawnSync('/bin/bash', ['-c', `source "$1"; PATH="$2"; COMP_WORDS=(backdrop next --query ''); COMP_CWORD=3; _backdrop; printf '%s\\n' "\${COMPREPLY[@]}"`,
        'bash', script, bin], { encoding: 'utf8' });
      expect(result.stdout.split('\n').filter(Boolean).sort()).to.deep.equal(['coral', 'deep\\ sea']);
    });

    it('completes directories for import and m3u files for --playlist', async () => {
      expect(complete('backdrop import ')).to.deep.equal(['walls']);
      expect(complete('backdrop import walls ')).to.deep.equal(['walls']);
      expect(complete('backdrop list-videos --playlist ')).to.deep.equal(['list.m3u', 'walls']);
    });
  });
});
