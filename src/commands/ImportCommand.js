import path from 'path';
import chalk from 'chalk';
import { Importer } from '../library/Importer.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { listMonitors } from '../display/Monitors.js';

const OUTCOME_LABELS = {
  imported: chalk.green('imported'),
  duplicate: chalk.gray('duplicate'),
  too_small: chalk.yellow('too small'),
  unsupported: chalk.yellow('unsupported'),
  failed: chalk.red('failed')
};

export class ImportCommand {
  constructor(config, database, logger, { importer, control, monitors = listMonitors } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.importer = importer ?? new Importer({ config, database, logger });
    this.control = control ?? new DisplayControl({ config, database });
    this.monitors = monitors;
  }

  // Resolution the default rating is recorded against: the primary monitor, if X is available
  async ratingResolution() {
    try {
      const monitors = await this.monitors();
      const monitor = monitors.find(m => m.primary) ?? monitors[0];
      return monitor ? `${monitor.width}x${monitor.height}` : null;
    } catch {
      return null;
    }
  }

  async import(dirs = []) {
    const targets = dirs.length
      ? dirs.map(dir => path.resolve(this.config.expandPath(dir)))
      : this.config.get().library.import_dirs;
    if (!targets.length) {
      throw new Error('No directories given and library.import_dirs is empty');
    }

    const { min_width: minWidth, min_height: minHeight } = this.config.get().library;
    const summary = await this.importer.importDirs(targets, {
      resolution: await this.ratingResolution(),
      onFile: (file, outcome) => {
        if (outcome.status !== 'unchanged') {
          const detail = outcome.detail ? chalk.gray(` (${outcome.detail})`) : '';
          console.log(`${OUTCOME_LABELS[outcome.status]} ${file}${detail}`);
        }
      }
    });

    console.log([
      `Scanned ${summary.scanned}`,
      `imported ${summary.imported.length}`,
      `unchanged ${summary.unchanged}`,
      `duplicates ${summary.duplicates}`,
      `below ${minWidth}x${minHeight} ${summary.tooSmall}`,
      `unsupported ${summary.unsupported}`,
      `failed ${summary.failed}`
    ].join(', '));

    const counts = await this.control.appendMedia(summary.imported);
    for (const [name, count] of Object.entries(counts)) {
      console.log(`  ${name}: added ${count} to the playlist`);
    }
    if (summary.failed) {
      process.exitCode = 1;
    }
    return summary;
  }
}
