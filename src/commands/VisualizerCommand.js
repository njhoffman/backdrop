import { readState } from '../display/Daemon.js';
import { sendControl } from '../display/control.js';
import { presetsOf, visualizerSettings } from '../visualizer/settings.js';
import { out, fmt } from '../utils/output.js';

export const VISUALIZER_ACTIONS = ['reload', 'preset'];
const RELOAD_TIMEOUT_MS = 5000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class VisualizerCommand {
  constructor(config, database, logger, { kill = process.kill, timeout = RELOAD_TIMEOUT_MS, pollInterval = 100 } = {}) {
    this.config = config;
    this.logger = logger;
    this.kill = kill;
    this.timeout = timeout;
    this.pollInterval = pollInterval;
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  async run(action, name, options = {}) {
    if (!VISUALIZER_ACTIONS.includes(action)) throw new Error(`Unknown action ${action}; use ${VISUALIZER_ACTIONS.join(', ')}`);
    return action === 'preset' ? this.preset(name, options) : this.reload();
  }

  // Checks the section here first, so a mistake shows at the prompt rather than only in the daemon log,
  // then signals the daemon and waits for its state to show the reload
  async reload() {
    visualizerSettings(this.config.get().visualizer);
    const state = await readState(this.runtimeDir);
    if (!state) {
      out.info('Daemon not running; the visualizer settings apply when it starts');
      return;
    }
    // Daemons before 2.20.0 have no SIGHUP handler, and Node exits on an unhandled SIGHUP
    if (!state.version) {
      throw new Error(`The running daemon (pid ${state.pid}) cannot reload the visualizer; restart it with \`backdrop stop && backdrop start\``);
    }
    const before = state.visualizer?.generation ?? 0;
    this.kill(state.pid, 'SIGHUP');

    const deadline = Date.now() + this.timeout;
    let current = state;
    while ((current?.visualizer?.generation ?? 0) <= before) {
      if (Date.now() > deadline) throw new Error(`The daemon did not reload the visualizer; see ${this.config.get().paths.logfile}`);
      await sleep(this.pollInterval);
      current = await readState(this.runtimeDir);
    }
    this.report(current, 'Reloaded the visualizer');
  }

  // Without a name, lists the presets and marks the active one. A name, --next (the one after the active, in
  // the order listed) or --clear (back to visualizer.preset) switches the running daemon until it restarts.
  async preset(name, { next = false, clear = false } = {}) {
    const section = this.config.get().visualizer;
    const names = Object.keys(presetsOf(section));
    const state = await readState(this.runtimeDir);
    const active = state?.visualizer?.preset ?? section?.preset ?? null;
    if (!name && !next && !clear) {
      for (const preset of names) out.print(`${preset === active ? fmt.bold(`* ${preset}`) : `  ${preset}`}`);
      out.detail('Switch with `backdrop visualizer preset <name>`, `--next`, or `--clear` for visualizer.preset');
      return;
    }
    const target = clear ? null : name ?? names[(names.indexOf(active) + 1) % names.length];
    // Checks the name and the preset before the daemon sees them
    visualizerSettings(section, { preset: target });
    if (!state) {
      out.info('Daemon not running; set visualizer.preset to start with a preset');
      return;
    }
    const current = await sendControl(this.runtimeDir, state, { preset: target }, {
      kill: this.kill, timeout: this.timeout, logfile: this.config.get().paths.logfile
    });
    this.report(current, target ? `Preset ${target}` : 'Preset cleared');
  }

  report(state, title) {
    if (state.visualizer.error) throw new Error(`Visualizer off: ${state.visualizer.error}`);
    if (!state.visualizer.enabled) {
      out.info('Visualizer off (visualizer.enabled is false)');
      return;
    }
    const { preset, silenced } = state.visualizer;
    const shown = preset && !title.startsWith('Preset') ? fmt.dim(`  preset ${preset}`) : '';
    out.success(`${title}${shown}${silenced ? fmt.dim('  (waiting for sound)') : ''}`);
    for (const monitor of state.monitors) {
      const instances = monitor.visualizers ?? (monitor.visualizer ? [monitor.visualizer] : []);
      if (!instances.length) out.print(`  ${fmt.bold(monitor.name)} ${fmt.dim('no visualizer')}`);
      for (const item of instances) out.print(`  ${fmt.bold(monitor.name)} ${item.instance ?? 'main'}: ${item.module} at ${item.geometry}`);
    }
  }
}
