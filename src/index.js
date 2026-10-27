#!/usr/bin/env node

import { program, CommanderError } from 'commander';
import { createRequire } from 'module';
import fs from 'fs-extra';
import { ConfigManager } from './config/ConfigManager.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { Logger } from './utils/Logger.js';
import { DisplayCommand } from './commands/DisplayCommand.js';
import { ImportCommand } from './commands/ImportCommand.js';
import { RemoveCommand } from './commands/RemoveCommand.js';
import { RatingCommand } from './commands/RatingCommand.js';
import { SearchCommand } from './commands/SearchCommand.js';
import { DownloadCommand } from './commands/DownloadCommand.js';
import { ListCommand } from './commands/ListCommand.js';
import { StatsCommand } from './commands/StatsCommand.js';
import chalk from 'chalk';

const { version, description } = createRequire(import.meta.url)('../package.json');

class BackdropApp {
  constructor() {
    this.config = new ConfigManager();
    this.database = new DatabaseManager();
    this.logger = null;
  }

  async initialize() {
    try {
      await this.config.initialize();

      const config = this.config.get();
      await this.ensureDirectories();
      this.logger = new Logger(config.paths.logfile);
      this.database.initialize(config.paths.database);

      this.logger.info('Application initialized successfully');
    } catch (error) {
      console.error(chalk.red('Failed to initialize application:'), error.message);
      process.exit(1);
    }
  }

  async ensureDirectories() {
    const { paths } = this.config.get();

    for (const dir of [paths.media, paths.trash, paths.inbox]) {
      await fs.ensureDir(dir);
    }
    await fs.ensureDir(paths.runtime, 0o700);
  }

  // Wraps a command handler so failures print their message instead of a stack trace
  action(handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        this.logger.error(error.message, { stack: error.stack });
        console.error(chalk.red(error.message));
        process.exitCode = 1;
      }
    };
  }

  // Commands are registered here as they are ported to the new config and database layer
  setupCommands() {
    const display = new DisplayCommand(this.config, this.database, this.logger);
    const importer = new ImportCommand(this.config, this.database, this.logger);
    const remover = new RemoveCommand(this.config, this.database, this.logger);
    const rating = new RatingCommand(this.config, this.database, this.logger);
    const search = new SearchCommand(this.config, this.database, this.logger);
    const download = new DownloadCommand(this.config, this.database, this.logger);
    const list = new ListCommand(this.config, this.database, this.logger);
    const stats = new StatsCommand(this.config, this.database, this.logger);
    const monitorOption = ['-m, --monitor <name>', 'Target monitor (default: the one under the pointer)'];

    program
      .name('backdrop')
      .description(description)
      .version(version)
      .exitOverride();

    program
      .command('daemon')
      .description('Run the display daemon in the foreground')
      .action(this.action(() => display.daemon()));

    program
      .command('start')
      .description('Start the display daemon in the background')
      .action(this.action(() => display.start()));

    program
      .command('stop')
      .description('Stop the display daemon')
      .action(this.action(() => display.stop()));

    program
      .command('status')
      .description('Show the mode and what each monitor is playing')
      .action(this.action(() => display.status()));

    program
      .command('current')
      .description('Show the item playing on a monitor')
      .option(...monitorOption)
      .action(this.action(options => display.current(options)));

    program
      .command('next')
      .description('Play the next item')
      .option(...monitorOption)
      .action(this.action(options => display.next(options)));

    program
      .command('prev')
      .description('Play the previous item')
      .option(...monitorOption)
      .action(this.action(options => display.prev(options)));

    program
      .command('speed')
      .description('Set the playing video\'s speed and remember it (e.g. 0.8, +0.1, -0.1, reset)')
      .argument('<value>', 'Absolute speed, relative step, or reset')
      .option(...monitorOption)
      .allowUnknownOption()
      .action(this.action((value, options) => display.speed(value, options)));

    program
      .command('import')
      .description('Copy approved local media into the library (default: library.import_dirs)')
      .argument('[dirs...]', 'Directories to import from')
      .action(this.action(dirs => importer.import(dirs)));

    program
      .command('remove')
      .description('Permanently delete a library item and its file; imported originals are preserved')
      .argument('[id]', 'Media id (shown by backdrop current)')
      .option('--current', 'Remove the item playing on the target monitor')
      .option(...monitorOption)
      .action(this.action((id, options) => remover.remove(id, options)));

    program
      .command('mode')
      .description('Switch between video and image wallpapers')
      .argument('[mode]', 'video, image or toggle', 'toggle')
      .action(this.action(mode => display.mode(mode)));

    program.command('keep')
      .description('Keep the current item with a rating from 1 to 3')
      .argument('[rating]', 'Rating', '1').option(...monitorOption)
      .action(this.action((value, options) => rating.keep(value, options)));
    program.command('skip')
      .description('Move the current item to trash and advance every monitor playing it')
      .option(...monitorOption).action(this.action(options => rating.skip(options)));
    program.command('undo')
      .description('Undo the latest rating and restore its file location')
      .action(this.action(() => rating.undo()));
    program.command('go-next')
      .description('Advance the target monitor after checking the current item has a rating')
      .option(...monitorOption).action(this.action(options => rating.goNext(options)));

    for (const [name, method] of [['search-images', 'searchImages'], ['search-videos', 'searchVideos']]) {
      program.command(name).description('Search a source and save matching media for download')
        .argument('[query]', 'Search keywords (quote multiple words)')
        .option('--source <name>', 'Source adapter', 'pexels')
        .option('--per-page <number>', 'Results per page (1-80)')
        .option('--orientation <type>', 'landscape, portrait or square')
        .option('--portrait', 'Only portrait media')
        .option('--min-size <size>', 'Minimum image size: large, medium or small')
        .option('--color <color>', 'Image color')
        .option('--resolution <WIDTHxHEIGHT>', 'Override detected monitor dimensions')
        .action(this.action((query, options) => search[method](query, options)));
    }
    program.command('download').description('Download pending media into the review inbox')
      .option('--total <number>', 'Maximum successful downloads', '50')
      .option('--type <type>', 'images, videos or both', 'both')
      .option('--source <name>', 'Restrict to one source')
      .option('--resolution <WIDTHxHEIGHT>', 'Override detected monitor dimensions')
      .action(this.action(options => download.download(options)));
    for (const [name, method] of [['list-images', 'listImages'], ['list-videos', 'listVideos']]) {
      program.command(name).description('List downloaded media and their current ratings')
        .option('--number <number>', 'Limit results')
        .option('--rated [orientation]', 'Kept items, optionally landscape, portrait or any')
        .option('--min-rating <rating>', 'Minimum current rating (1-3)')
        .option('--no-local', 'Exclude local imports')
        .option('--source <name>', 'Restrict to one source')
        .option('--status <status>', 'new, kept or skipped')
        .option('--keywords <words...>', 'Match all words against searches, tags or filenames')
        .option('--playlist <file>', 'Export matching existing files as M3U')
        .option('--interactive', 'Browse and rate the listed media')
        .action(this.action(options => list[method](options)));
    }
    program.command('stats').description('Show library totals and last observed API quota')
      .action(this.action(() => stats.showStats()));
  }

  async run() {
    await this.initialize();
    this.setupCommands();
    try {
      await program.parseAsync();
    } catch (error) {
      // exitOverride turns commander's own exits (--help, --version, usage errors) into errors
      // so the database closes and logs flush; commander has already printed the message
      if (error instanceof CommanderError) {
        process.exitCode = error.exitCode;
        return;
      }
      throw error;
    }
  }
}

const app = new BackdropApp();
app.run()
  .catch(error => {
    console.error(chalk.red('Application error:'), error);
    process.exitCode = 1;
  })
  .finally(() => app.database.close());
