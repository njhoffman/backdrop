import path from 'path';
import { Importer } from '../library/Importer.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { listMonitors } from '../display/Monitors.js';
import { out, fmt, ProgressBar, displayPath } from '../utils/output.js';

// Evaluated per call so colors follow the current output settings
const OUTCOME_LABELS = {
  imported: () => fmt.green('imported'),
  duplicate: () => fmt.gray('duplicate'),
  too_small: () => fmt.yellow('too small'),
  unsupported: () => fmt.yellow('unsupported'),
  failed: () => fmt.red('failed')
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
    let bar = null;
    let summary;
    try {
      summary = await this.importer.importDirs(targets, {
        resolution: await this.ratingResolution(),
        onStart: total => { bar = new ProgressBar({ label: 'Importing', total }); },
        onFile: (file, outcome, done) => {
          bar?.update(done, path.basename(file));
          if (outcome.status !== 'unchanged') {
            const detail = outcome.detail ? fmt.gray(` (${outcome.detail})`) : '';
            out.print(`${OUTCOME_LABELS[outcome.status]()} ${displayPath(file)}${detail}`);
          }
        }
      });
    } finally {
      bar?.stop();
    }

    out.print([
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
      out.detail(`${name}: added ${count} to the playlist`);
    }
    if (summary.failed) {
      process.exitCode = 1;
    }
    return summary;
  }
}
