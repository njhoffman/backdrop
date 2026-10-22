#!/usr/bin/env node

import { program, CommanderError } from 'commander';
import { createRequire } from 'module';
import fs from 'fs-extra';
import { ConfigManager } from './config/ConfigManager.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { Logger } from './utils/Logger.js';
import { DisplayCommand } from './commands/DisplayCommand.js';
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
      .command('mode')
      .description('Switch between video and image wallpapers')
      .argument('[mode]', 'video, image or toggle', 'toggle')
      .action(this.action(mode => display.mode(mode)));
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
