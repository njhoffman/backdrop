#!/usr/bin/env node

import { program } from 'commander';
import { ConfigManager } from './config/ConfigManager.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { Logger } from './utils/Logger.js';
import { SearchCommand } from './commands/SearchCommand.js';
import { DownloadCommand } from './commands/DownloadCommand.js';
import { ListCommand } from './commands/ListCommand.js';
import { StatsCommand } from './commands/StatsCommand.js';
import { RatingCommand } from './commands/RatingCommand.js';
import { HookCommand } from './commands/HookCommand.js';
import { ImportCommand } from './commands/ImportCommand.js';
import chalk from 'chalk';

class PexelsApp {
  constructor() {
    this.config = new ConfigManager();
    this.database = new DatabaseManager();
    this.logger = new Logger();
  }

  async initialize() {
    try {
      // Check and create config file
      await this.config.initialize();
      
      // Initialize logger with config path
      const config = this.config.get();
      this.logger = new Logger(config.paths.logfile);
      
      // Initialize database
      await this.database.initialize(config.paths.database);
      
      // Validate required configuration
      await this.validateConfig();
      
      // Ensure directories exist
      await this.ensureDirectories();
      
      this.logger.info('Application initialized successfully');
    } catch (error) {
      console.error('Failed to initialize application:', error);
      process.exit(1);
    }
  }

  async validateConfig() {
    const config = this.config.get();
    
    if (!config.api_key) {
      console.error(chalk.red('Error: API key is required. Set it in config or PEXELS_API environment variable'));
      process.exit(1);
    }

    const requiredHooks = ['get-name', 'play-prev', 'play-next'];
    for (const hook of requiredHooks) {
      if (!config.hooks[hook]) {
        console.error(chalk.red(`Error: Hook '${hook}' is required in configuration`));
        process.exit(1);
      }
    }
  }

  async ensureDirectories() {
    const paths = this.config.get().paths;
    const fs = await import('fs-extra');
    
    const directories = [
      paths.videos_new,
      paths.images_new,
      paths.videos_kept,
      paths.images_kept,
      paths.playlists
    ];

    for (const dir of directories) {
      await fs.ensureDir(dir);
    }
  }

  setupCommands() {
    const searchCmd = new SearchCommand(this.config, this.database, this.logger);
    const downloadCmd = new DownloadCommand(this.config, this.database, this.logger);
    const listCmd = new ListCommand(this.config, this.database, this.logger);
    const statsCmd = new StatsCommand(this.config, this.database, this.logger);
    const ratingCmd = new RatingCommand(this.config, this.database, this.logger);
    const hookCmd = new HookCommand(this.config, this.database, this.logger);
    const importCmd = new ImportCommand(this.config, this.database, this.logger);

    program
      .name('pexels')
      .description('CLI tool for searching, downloading, and managing Pexels wallpapers')
      .version('1.0.0');

    program
      .command('help')
      .description('Show help information')
      .action(() => {
        console.log(chalk.cyan.bold('\n🎨 Pexels CLI - Wallpaper Management Tool\n'));
        console.log('A command-line tool for searching, downloading, and managing wallpaper videos and images from Pexels.');
        console.log('\nAvailable commands:');
        console.log(chalk.yellow('  search-images') + '  - Search for images with keywords');
        console.log(chalk.yellow('  search-videos') + '  - Search for videos with keywords');
        console.log(chalk.yellow('  download') + '      - Download images/videos from database');
        console.log(chalk.yellow('  list-images') + '   - List downloaded images');
        console.log(chalk.yellow('  list-videos') + '   - List downloaded videos');
        console.log(chalk.yellow('  stats') + '        - Show API stats and download statistics');
        console.log(chalk.yellow('  keep') + '         - Mark item as kept (with optional rating)');
        console.log(chalk.yellow('  skip') + '         - Mark item as skipped');
        console.log(chalk.yellow('  undo') + '         - Undo last rating');
        console.log(chalk.yellow('  go-next') + '      - Process current item and move to next');
        console.log(chalk.yellow('  import') + '       - Import local media files');
        console.log('\nUse --help with any command for detailed options.');
      });

    program
      .command('search-images')
      .description('Search for images with keywords')
      .argument('[query]', 'Search query')
      .option('--per-page <number>', 'Results per page (15-80)', '80')
      .option('--orientation <type>', 'Orientation (landscape, portrait, square)')
      .option('--min-size <size>', 'Minimum size (large, medium, small)', 'large')
      .option('--color <color>', 'Desired color')
      .option('--portrait', 'Only return portrait format images (height > width)')
      .action((query, options) => searchCmd.searchImages(query, options));

    program
      .command('search-videos')
      .description('Search for videos with keywords')
      .argument('[query]', 'Search query')
      .option('--per-page <number>', 'Results per page (15-80)', '80')
      .option('--min-size <size>', 'Minimum size (large, medium, small)')
      .option('--portrait', 'Only return portrait format videos (height > width)')
      .action((query, options) => searchCmd.searchVideos(query, options));

    program
      .command('download')
      .description('Download images/videos from database')
      .option('--total <number>', 'Total items to download')
      .action((options) => downloadCmd.download(options));

    program
      .command('list-images')
      .description('List downloaded images')
      .option('--number <num>', 'Max items to show')
      .option('--rated [orientation]', 'Only show rated items, optionally filter by orientation (landscape/portrait/any)', 'any')
      .option('--keywords <keywords...>', 'Filter by keywords')
      .option('--sizes <sizes...>', 'Filter by sizes')
      .option('--playlist <name>', 'Save as playlist')
      .action((options) => listCmd.listImages(options));

    program
      .command('list-videos')
      .description('List downloaded videos')
      .option('--number <num>', 'Max items to show')
      .option('--rated [orientation]', 'Only show rated items, optionally filter by orientation (landscape/portrait/any)', 'any')
      .option('--keywords <keywords...>', 'Filter by keywords')
      .option('--sizes <sizes...>', 'Filter by sizes')
      .option('--playlist <name>', 'Save as playlist')
      .action((options) => listCmd.listVideos(options));

    program
      .command('stats')
      .description('Show API stats and download statistics')
      .action(() => statsCmd.showStats());

    program
      .command('keep')
      .description('Mark item as kept with optional rating')
      .argument('[rating]', 'Rating (1-3)', '1')
      .action((rating) => ratingCmd.keep(rating));

    program
      .command('skip')
      .description('Mark item as skipped')
      .action(() => ratingCmd.skip());

    program
      .command('undo')
      .description('Undo last rating')
      .action(() => ratingCmd.undo());

    program
      .command('go-next')
      .description('Process current item and move to next')
      .action(() => hookCmd.goNext());

    program
      .command('import')
      .description('Import local media files')
      .argument('[directory]', 'Source directory to import from')
      .action((directory) => importCmd.import(directory));
  }

  async run() {
    await this.initialize();
    this.setupCommands();
    program.parse();
  }
}

// Run the application
const app = new PexelsApp();
app.run().catch(error => {
  console.error(chalk.red('Application error:'), error);
  process.exit(1);
});