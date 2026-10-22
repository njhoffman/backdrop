#!/usr/bin/env node

import { program, CommanderError } from 'commander';
import { createRequire } from 'module';
import fs from 'fs-extra';
import { ConfigManager } from './config/ConfigManager.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { Logger } from './utils/Logger.js';
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

  // Commands are registered here as they are ported to the new config and database layer
  setupCommands() {
    program
      .name('backdrop')
      .description(description)
      .version(version)
      .exitOverride();
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
