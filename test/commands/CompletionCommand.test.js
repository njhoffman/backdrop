import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { CompletionCommand } from '../../src/commands/CompletionCommand.js';
import { makeConfig } from '../helpers/fakes.js';

const capture = fileURLToPath(new URL('../helpers/zsh-capture.zsh', import.meta.url));
const hasZsh = spawnSync('zsh', ['-fc', 'zmodload zsh/zpty'], { encoding: 'utf8' }).status === 0;
const hasBash = spawnSync('bash', ['-c', 'compgen -W x'], { encoding: 'utf8' }).status === 0;

function program() {
  const root = new Command('backdrop');
  root.command('mode').description('Switch modes').argument('[mode]', 'mode');
  root.command('next').description('Play the next item').option('-m, --monitor <name>', 'Target monitor (default: the one under the pointer)');
  root.command('speed').description('Set the playing video\'s speed').argument('<value>', 'speed');
  root.command('list-videos').description('List videos')
    .option('--rated [orientation]', 'Kept items [any]').option('--source <name>', 'Source')
    .option('--keywords <words...>', 'Words').option('--no-local', 'Exclude local').option('--playlist <file>', 'M3U');
  root.command('import').argument('[dirs...]', 'Directories');
  root.command('keep').argument('[rating]', 'Rating').option('-m, --monitor <name>', 'Target monitor').option('-n, --next', 'Then next');
  return root;
}

describe('CompletionCommand', () => {
  let dir, config, command;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-comp-'));
    config = makeConfig({ 'paths.runtime': path.join(dir, 'run') });
    command = new CompletionCommand(config, null, null, { sources: { names: () => ['pexels', 'unsplash'] } });
  });
  afterEach(async () => { await fs.remove(dir); });

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

    it('completes directories for import and m3u files for --playlist', async () => {
      expect(complete('backdrop import ')).to.deep.equal(['walls']);
      expect(complete('backdrop import walls ')).to.deep.equal(['walls']);
      expect(complete('backdrop list-videos --playlist ')).to.deep.equal(['list.m3u', 'walls']);
    });
  });
});
