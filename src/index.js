#!/usr/bin/env node

import { program, Argument, CommanderError, Option } from 'commander';
import { createRequire } from 'module';
import fs from 'fs-extra';
import { ConfigManager } from './config/ConfigManager.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { Logger } from './utils/Logger.js';
import { DisplayCommand } from './commands/DisplayCommand.js';
import { ImportCommand } from './commands/ImportCommand.js';
import { RemoveCommand } from './commands/RemoveCommand.js';
import { PurgeCommand } from './commands/PurgeCommand.js';
import { RescanCommand } from './commands/RescanCommand.js';
import { MenuCommand } from './commands/MenuCommand.js';
import { RatingCommand } from './commands/RatingCommand.js';
import { SearchCommand } from './commands/SearchCommand.js';
import { DownloadCommand } from './commands/DownloadCommand.js';
import { ListCommand } from './commands/ListCommand.js';
import { StatsCommand } from './commands/StatsCommand.js';
import { CompletionCommand, SHELLS } from './commands/CompletionCommand.js';
import { SystemdCommand } from './commands/SystemdCommand.js';
import { VisualizerCommand, VISUALIZER_ACTIONS } from './commands/VisualizerCommand.js';
import { configureOutput, out, printVersion, setJsonOutput } from './utils/output.js';

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
      configureOutput({ config: this.config });
      if (this.config.created) out.notice(`Created default config file at: ${this.config.configPath}`);
      for (const warning of this.config.warnings) out.warn(warning);

      const config = this.config.get();
      await this.ensureDirectories();
      this.logger = new Logger(config.paths.logfile);
      this.database.initialize(config.paths.database);

      this.logger.info('Application initialized successfully');
    } catch (error) {
      out.error(`Failed to initialize application: ${error.message}`);
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
        out.error(error.message);
        process.exitCode = 1;
      }
    };
  }

  // Commands are registered here as they are ported to the new config and database layer
  setupCommands() {
    const display = new DisplayCommand(this.config, this.database, this.logger);
    const importer = new ImportCommand(this.config, this.database, this.logger);
    const remover = new RemoveCommand(this.config, this.database, this.logger);
    const purger = new PurgeCommand(this.config, this.database, this.logger);
    const rescanner = new RescanCommand(this.config, this.database, this.logger);
    const rating = new RatingCommand(this.config, this.database, this.logger);
    const menu = new MenuCommand(this.config, this.database, this.logger, { display, rating });
    const search = new SearchCommand(this.config, this.database, this.logger);
    const download = new DownloadCommand(this.config, this.database, this.logger);
    const list = new ListCommand(this.config, this.database, this.logger);
    const stats = new StatsCommand(this.config, this.database, this.logger);
    const completion = new CompletionCommand(this.config, this.database, this.logger);
    const systemd = new SystemdCommand(this.config, this.database, this.logger);
    const visualizer = new VisualizerCommand(this.config, this.database, this.logger);
    const monitorOption = ['-m, --monitor <name>', 'Target monitor (default: the one under the pointer)'];
    const randomOption = ['-r, --random', 'Pick a random item instead of the next in the shuffled order (default: display.order)'];
    const noRandomOption = ['--no-random', 'Play the next item in the shuffled order'];
    const lineOption = ['-l, --line', 'Print the item as one aligned line (tab-separated when piped, for fzf)'];
    const headerOption = ['--header', 'Print column names above --line output (implies --line; fzf --header-lines=1)'];
    const jsonOption = ['--json', 'Print JSON on stdout (docs/specs/json.md); other messages go to stderr'];
    const queryOption = ['--query <queries...>', 'Only items a search with any of these exact queries found (quote each query)'];
    const tagOption = ['--tag <tags...>', 'Only items with all of these tags (shown under each item)'];
    const keywordsOption = ['--keywords <words...>', 'Match all words against searches, tags or filenames'];
    const imageDurationOption = ['--image-duration <time>', 'Show each image this long (90, 90s, 5m) until next --clear or a daemon restart'];
    const videoDurationOption = ['--video-duration <time>', 'Play each video about this long (0 loops forever) until next --clear or a daemon restart'];

    program
      .name('backdrop')
      .description(description)
      .version(version)
      .exitOverride()
      // With --json, stdout carries only the JSON document
      .hook('preAction', (root, command) => setJsonOutput(command.opts().json));

    program
      .command('daemon')
      .description('Run the display daemon in the foreground')
      .option('--no-wallpaper', 'Start without wallpapers (backdrop start --wallpaper turns them on)')
      .option('--visualizer', 'Run the visualizer even if visualizer.enabled is false')
      .option('--no-visualizer', 'Do not run the visualizer even if visualizer.enabled is true')
      .action(this.action(options => display.daemon(options)));

    const partOptions = command => command
      .option('--wallpaper', 'Only the wallpaper')
      .option('--visualizer', 'Only the visualizer');
    partOptions(program
      .command('start')
      .description('Start the display daemon in the background, or with --wallpaper/--visualizer only that part, or turn it on'))
      .action(this.action(options => display.start(options)));

    partOptions(program
      .command('stop')
      .description('Stop the display daemon, or with --wallpaper/--visualizer turn only that part off'))
      .action(this.action(options => display.stop(options)));

    program
      .command('status')
      .description('Show the mode and what each monitor is playing')
      .option(...jsonOption)
      .action(this.action(options => display.status(options)));

    program
      .command('current')
      .description('Show the item playing on a monitor')
      .option(...monitorOption)
      .option(...lineOption).option(...jsonOption)
      .option(...headerOption)
      .action(this.action(options => display.current(options)));

    program
      .command('next')
      .description('Play the next item and show it; filters and order given stay in effect until --clear or a daemon restart')
      .option(...monitorOption)
      .option(...randomOption)
      .option(...noRandomOption)
      .option(...queryOption).option(...tagOption).option(...keywordsOption)
      .option(...imageDurationOption).option(...videoDurationOption)
      .option('--clear', 'Drop the filters, order and durations earlier next or menu commands left in effect')
      .option(...lineOption).option(...jsonOption)
      .action(this.action(options => display.next(options)));

    program
      .command('prev')
      .description('Play the previous item and show it')
      .option(...monitorOption)
      .option(...lineOption).option(...jsonOption)
      .action(this.action(options => display.prev(options)));

    program
      .command('speed')
      .description('Set the playing video\'s speed and remember it (e.g. 0.8, +0.1, -0.1, reset)')
      .argument('<value>', 'Absolute speed, relative step, or reset')
      .option(...monitorOption)
      .allowUnknownOption()
      .action(this.action((value, options) => display.speed(value, options)));

    program
      .command('dim')
      .description('Darken the playing item and remember it (0-100, e.g. 30, +10, -10, reset)')
      .argument('<value>', 'Absolute amount, relative step, or reset')
      .option(...monitorOption)
      .allowUnknownOption()
      .action(this.action((value, options) => display.dim(value, options)));

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
      .command('purge')
      .description('Delete trash files skipped more than library.trash_days ago (the daemon also runs this daily)')
      .option('--dry-run', 'List what would be purged without deleting anything')
      .action(this.action(options => purger.purge(options)));

    program
      .command('menu')
      .description('Open a rofi menu to rate, navigate, adjust and switch the item under the pointer; menu visualizer for the visualizer')
      .addArgument(new Argument('[page]', 'visualizer: only the visualizer menu').choices(['main', 'visualizer']))
      .option(...monitorOption)
      .option('--style <style>', 'panel (buttons and a preview) or minimal (a list); default: menu.style')
      .option(...randomOption).option(...noRandomOption)
      .option(...queryOption).option(...tagOption).option(...keywordsOption)
      .option(...imageDurationOption).option(...videoDurationOption)
      // The menu stays open until q or Escape since 2.18.0; the old flag is still accepted
      .addOption(new Option('--stay').hideHelp())
      .action(this.action((page, options) => menu.open({ ...options, page })));

    program
      .command('rescan')
      .description('Probe library files again: fill in missing video frame rates, or with --all re-check every file')
      .option('--all', 'Re-check kind, size, duration and frame rate of every downloaded file')
      .action(this.action(options => rescanner.rescan(options)));

    program
      .command('mode')
      .description('Switch between video and image wallpapers')
      .argument('[mode]', 'video, image or toggle', 'toggle')
      .option(...monitorOption)
      .option(...lineOption).option(...jsonOption)
      .action(this.action((mode, options) => display.mode(mode, options)));

    program.command('keep')
      .description('Keep the current item with a rating from 1 to 3')
      .argument('[rating]', 'Rating', '1').option(...monitorOption)
      .option('-n, --next', 'Then play the next item and show it').option(...randomOption).option(...noRandomOption).option(...lineOption).option(...jsonOption)
      .action(this.action((value, options) => rating.keep(value, options)));
    program.command('skip')
      .description('Move the current item to trash, advance every monitor playing it and show the new item')
      .option(...monitorOption).option(...randomOption).option(...noRandomOption).option(...lineOption).option(...jsonOption).action(this.action(options => rating.skip(options)));
    program.command('undo')
      .description('Undo the latest rating and restore its file location')
      .option('--discard', 'Drop the latest rating from undo history without changing the item, when it cannot be restored')
      .action(this.action(options => rating.undo(options)));
    program.command('go-next')
      .description('Advance the target monitor after checking the current item has a rating, and show the new item')
      .option(...monitorOption).option(...randomOption).option(...noRandomOption).option(...lineOption).option(...jsonOption).action(this.action(options => rating.goNext(options)));

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
      .option(...queryOption).option(...tagOption).option(...keywordsOption)
      .option('--upgrade', 'Replace downloaded media smaller than the monitors with a larger variant')
      .action(this.action(options => download.download(options)));
    program.command('pending').description('List media saved by searches and not yet downloaded, with their queries')
      .option('--number <number>', 'Limit results')
      .option('--type <type>', 'images, videos or both', 'both')
      .option('--source <name>', 'Restrict to one source')
      .option('--resolution <WIDTHxHEIGHT>', 'Override detected monitor dimensions')
      .option(...queryOption).option(...tagOption).option(...keywordsOption)
      .action(this.action(options => download.pending(options)));
    for (const [name, method] of [['list-images', 'listImages'], ['list-videos', 'listVideos']]) {
      program.command(name).description('List downloaded media and their current ratings')
        .option('--number <number>', 'Limit results')
        .option('--rated [orientation]', 'Kept items, optionally landscape, portrait or any')
        .option('--min-rating <rating>', 'Minimum current rating (1-3)')
        .option('--no-local', 'Exclude local imports')
        .option('--source <name>', 'Restrict to one source')
        .option('--status <status>', 'new, kept or skipped')
        .option(...queryOption).option(...tagOption).option(...keywordsOption)
        .option('--playlist <file>', 'Export matching existing files as M3U')
        .option('--interactive', 'Browse and rate the listed media')
        .option(...lineOption).option(...jsonOption)
        .option(...headerOption)
        .action(this.action(options => list[method](options)));
    }
    program.command('stats').description('Show library totals and last observed API quota')
      .action(this.action(() => stats.showStats()));
    program.command('completion').description('Print a shell completion script, e.g. backdrop completion zsh > "${fpath[1]}/_backdrop"')
      .argument('<shell>', SHELLS.join(' or '))
      .action(this.action(shell => completion.print(shell, program, version)));
    program.command('visualizer').description('Apply the visualizer section to the running daemon (reload), or list and switch presets (preset)')
      .argument('<action>', VISUALIZER_ACTIONS.join(' or '))
      .argument('[name]', 'Preset to switch to, until the daemon restarts')
      .option('--next', 'Switch to the preset after the active one')
      .option('--clear', 'Go back to visualizer.preset')
      .action(this.action((action, name, options) => visualizer.run(action, name, options)));
    program.command('systemd').description('Print a systemd user unit for the daemon, e.g. backdrop systemd > ~/.config/systemd/user/backdrop.service')
      .action(this.action(() => systemd.print(version)));
  }

  async run() {
    await this.initialize();
    this.setupCommands();
    // The daemon logs its version at startup instead; --version prints it already; completion output is a script
    const args = process.argv.slice(2);
    if (!args.some(arg => ['-V', '--version', 'daemon', 'completion', 'systemd'].includes(arg))) printVersion(version);
    try {
      // Bare `backdrop` shows the status
      await program.parseAsync(args.length ? process.argv : [...process.argv, 'status']);
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
    out.error(`Application error: ${error.stack ?? error}`);
    process.exitCode = 1;
  })
  .finally(() => app.database.close());
