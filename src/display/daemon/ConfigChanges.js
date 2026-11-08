import path from 'path';
import { notifyError } from '../../utils/notify.js';
import { visualizerSettings } from '../../visualizer/settings.js';

// Settings a saved config change applies to the running daemon, by how: taken in (read where used),
// durations (also changed on what plays now), bounce (playlist entries swapped), eligibility (playlists brought in line, keeping what plays), monitors (layout
// reconciled) or imports (the folders imported). Any other display, library or paths setting needs a
// restart: mpv's and xwinwrap's arguments are given when they start.
const LIVE_SETTINGS = {
  'display.order': 'taken', 'display.notify': 'taken',
  'library.trash_days': 'taken', 'library.default_import_rating': 'taken',
  'display.image_duration': 'durations', 'display.video_duration': 'durations', 'display.video_loop': 'bounce',
  'display.allow_upscale': 'eligibility', 'library.min_width': 'eligibility', 'library.min_height': 'eligibility',
  'display.monitors': 'monitors',
  // Read when used
  'screensaver.idle': 'taken', 'screensaver.idle_minutes': 'taken', 'screensaver.max_load': 'taken', 'screensaver.preset': 'taken',
  'screensaver.workspace': 'taken', 'screensaver.on_enter': 'taken', 'screensaver.on_leave': 'taken',
  'library.import_dirs': 'imports', 'library.watch_imports': 'imports'
};

// The config file watcher and how a saved change reaches the running daemon (LIVE_SETTINGS), for a Daemon
// (passed in), whose state they read and change.
export class ConfigChanges {
  constructor(daemon) {
    this.daemon = daemon;
  }

  // Applies saved changes to the config file without a restart (see applyConfigChange). The directory is
  // watched rather than the file, since editors often save by renaming a new file over it; changes are read
  // once the file has been quiet for configSettle.
  watch() {
    const file = this.daemon.config.configPath;
    if (!this.daemon.watch || !file) return;
    try {
      this.daemon.configWatcher = this.daemon.watch(path.dirname(file), (event, name) => {
        if (name && name !== path.basename(file)) return;
        clearTimeout(this.daemon.configTimer);
        this.daemon.configTimer = setTimeout(() => this.daemon.enqueue(() => this.apply()), this.daemon.configSettle);
      });
      this.daemon.configWatcher.on('error', error => this.daemon.logger.warn('Config watch failed', { error: error.message }));
    } catch (error) {
      this.daemon.logger.warn('Not watching the config file; use `backdrop visualizer reload`', { file, error: error.message });
    }
  }

  // Applies a saved config file. The whole file is loaded and checked again first: a file that no longer
  // parses, a value that does not check out, or a visualizer section that does not, keeps every running
  // setting and is announced with a desktop notification, since nobody is at a prompt to see it. Then the
  // visualizer restarts when its section changed, unless only what it takes live did (opacity, the color pick),
  // and every other changed setting is applied by its kind (LIVE_SETTINGS); ones a running mpv cannot take are
  // announced as needing a restart.
  async apply() {
    if (this.daemon.stopping) return;
    const previousWarnings = this.daemon.config.warnings ?? [];
    let fresh;
    try {
      fresh = await this.daemon.readConfig();
      visualizerSettings(fresh.get().visualizer);
    } catch (error) {
      this.daemon.logger.error('Config change not applied, keeping the running settings', { error: error.message });
      await notifyError(`Config not applied: ${error.message}`, { logger: this.daemon.logger });
      return;
    }
    this.daemon.config.warnings = fresh.warnings ?? [];
    await this.reportWarnings(previousWarnings);
    const next = fresh.get();
    const settings = this.daemon.config.get();
    if (this.daemon.config.userConfig && fresh.userConfig) this.daemon.config.userConfig = fresh.userConfig;

    if (JSON.stringify(next.visualizer) !== JSON.stringify(settings.visualizer)) {
      settings.visualizer = next.visualizer;
      // Opacity and the wallpaper color pick apply to the running instances; other changes restart them
      await this.daemon.visualizers.refresh();
      await this.daemon.writeState();
      this.daemon.logger.info('Visualizer reloaded after a config change', this.daemon.visualizers.summary());
      // Problems only found when starting it, such as missing GLava shaders
      if (this.daemon.visualizers.error) {
        await notifyError(`Visualizer off: ${this.daemon.visualizers.error}`, { logger: this.daemon.logger });
      }
    }
    await this.applySettings(next);
  }

  // Takes the changed settings outside the visualizer section from a checked config and applies each by its
  // kind; returns the keys applied and the ones that need a restart
  async applySettings(next) {
    const settings = this.daemon.config.get();
    const changed = [];
    for (const section of ['display', 'library', 'paths']) {
      const keys = new Set([...Object.keys(settings[section] ?? {}), ...Object.keys(next[section] ?? {})]);
      for (const key of keys) {
        if (JSON.stringify(settings[section]?.[key]) !== JSON.stringify(next[section]?.[key])) changed.push(`${section}.${key}`);
      }
    }
    if (JSON.stringify(settings.load) !== JSON.stringify(next.load)) {
      const wasEnabled = Boolean(settings.load?.enabled);
      settings.load = next.load;
      this.daemon.logger.info('Load settings changed', next.load);
      await this.daemon.load.reconfigure(wasEnabled);
    }
    // Read by the CLI only, which loads the file on every run; kept current for anything else that asks
    for (const section of ['sources', 'menu', 'output', 'screensaver']) settings[section] = next[section];

    const restart = changed.filter(key => LIVE_SETTINGS[key] === undefined);
    const applied = changed.filter(key => LIVE_SETTINGS[key] !== undefined);
    for (const key of applied) {
      const [section, name] = key.split('.');
      settings[section][name] = next[section][name];
    }
    const kinds = new Set(applied.map(key => LIVE_SETTINGS[key]));
    if (applied.length) this.daemon.logger.info('Config applied', { settings: applied });
    if (kinds.has('durations')) await this.daemon.applyDurations();
    if (kinds.has('eligibility')) {
      for (const screen of [...this.daemon.screens.values()]) {
        try {
          await this.daemon.syncScreenPlaylist(screen);
        } catch (error) {
          this.daemon.logger.warn('Failed to update the playlist', { monitor: screen.monitor.name, error: error.message });
        }
      }
    }
    if (kinds.has('bounce')) await this.daemon.bounce.reconfigure();
    if (kinds.has('monitors')) await this.daemon.checkMonitors();
    if (kinds.has('imports')) {
      this.daemon.importWatcher.start();
      this.daemon.importing = this.daemon.importing.then(() => this.daemon.importDirs(this.daemon.firstMonitor()));
    }
    if (restart.length) {
      this.daemon.logger.warn('Config changes that need a daemon restart', { settings: restart });
      await notifyError(`Restart the daemon to apply: ${restart.join(', ')} (backdrop stop, then backdrop start)`, { logger: this.daemon.logger });
    }
    if (applied.length) await this.daemon.writeState();
    return { applied, restart };
  }

  // Unknown keys a save added, announced once each: nobody is at a prompt to see the CLI's warnings
  async reportWarnings(previous) {
    const added = (this.daemon.config.warnings ?? []).filter(warning => !previous.includes(warning));
    if (!added.length) return;
    this.daemon.logger.warn('Unknown config keys', { warnings: added });
    await notifyError(added.join('\n'), { logger: this.daemon.logger });
  }

  // SIGHUP (`backdrop visualizer reload`): re-reads the visualizer section and restarts only the
  // visualizer. A config file that no longer parses keeps the running visualizer and logs why.
  async reloadVisualizer() {
    if (this.daemon.stopping) return;
    try {
      await this.daemon.reloadConfig();
    } catch (error) {
      this.daemon.logger.error('Visualizer reload failed, keeping the running one', { error: error.message });
      return;
    }
    await this.daemon.visualizers.reload();
    await this.daemon.writeState();
    this.daemon.logger.info('Visualizer reloaded', this.daemon.visualizers.summary());
  }
}
