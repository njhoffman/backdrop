import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { roff, commandPage, configPage, releaseDate } from '../../src/utils/manpage.js';
import { configFields } from '../../src/config/schema.js';
import { ConfigManager } from '../../src/config/ConfigManager.js';

const root = path.resolve(import.meta.dirname, '../..');
const { version } = fs.readJsonSync(path.join(root, 'package.json'));

describe('man pages', () => {
  it('escapes backslashes and hyphens, and guards lines that start like a request', () => {
    expect(roff('a\\b --clear')).to.equal('a\\eb \\-\\-clear');
    expect(roff('.hidden\n\'quote\nplain')).to.equal('\\&.hidden\n\\&\'quote\nplain');
  });

  it('lists each visible command with its arguments and options, and never a home path', () => {
    const program = new Command('backdrop').description('Wallpapers');
    program.command('keep').description('Keep the item').argument('[rating]', 'From 1 to 3')
      .option('-m, --monitor <name>', 'Target monitor').option('--dir <path>', 'Where', path.join(os.homedir(), 'walls'));
    program.command('secret', { hidden: true }).description('Not listed');
    const page = commandPage(program, { version: '9.9.9', date: '2026-01-02' });

    expect(page).to.include('.TH BACKDROP 1 "2026-01-02" "backdrop 9.9.9" "User Commands"');
    expect(page).to.include('\\fBkeep\\fR [\\fIoptions\\fR] \\fI[rating]\\fR');
    expect(page).to.include('\\fB\\-m\\fR, \\fB\\-\\-monitor\\fR \\fI<name>\\fR');
    expect(page).to.include('(default "~/walls")');
    expect(page).to.not.include(os.homedir());
    expect(page).to.not.include('secret');
  });

  it('gives every config key with its kind and default', () => {
    const defaults = new ConfigManager('/nonexistent/config.yaml').getUserDefaults();
    const page = configPage(configFields(), defaults, { version: '9.9.9' });
    for (const field of configFields()) expect(page, field.key).to.include(`\\fB${roff(field.key)}\\fR (`);
    expect(page).to.include(`\\fB${roff('screensaver.hint')}\\fR (boolean, default \\fBtrue\\fR)`);
    expect(page).to.include('.SH VISUALIZER');
  });

  it('dates the page by its version\'s entry in the changelog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-man-'));
    const changelog = path.join(dir, 'CHANGELOG.md');
    await fs.writeFile(changelog, '## [Unreleased]\n\n## [1.2.10] - 2026-03-04\n\n## [1.2.1] - 2026-01-01\n');
    expect(releaseDate('1.2.1', changelog)).to.equal('2026-01-01');
    expect(releaseDate('1.2.10', changelog)).to.equal('2026-03-04');
    expect(releaseDate('3.0.0', changelog)).to.equal('');
    expect(releaseDate('1.0.0', path.join(dir, 'missing.md'))).to.equal('');
    await fs.remove(dir);
  });

  // The checked-in pages are what `npm run man` makes now: a new command, option or config key regenerates them
  for (const [section, file] of [['1', 'share/man/man1/backdrop.1'], ['5', 'share/man/man5/backdrop-config.5']]) {
    it(`share/man has the current page ${section} (npm run man writes it)`, () => {
      const made = execFileSync(process.execPath, [path.join(root, 'src/index.js'), 'man', section], { encoding: 'utf8' });
      expect(made, 'run npm run man').to.equal(fs.readFileSync(path.join(root, file), 'utf8'));
      expect(made).to.include(`"backdrop ${version}"`);
    });
  }
});
