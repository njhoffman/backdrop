import { readState } from '../display/Daemon.js';
import { visualizerSettings } from '../visualizer/settings.js';
import { out, fmt } from '../utils/output.js';

export const VISUALIZER_ACTIONS = ['reload'];
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

  async run(action) {
    if (!VISUALIZER_ACTIONS.includes(action)) throw new Error(`Unknown action ${action}; use ${VISUALIZER_ACTIONS.join(', ')}`);
    return this.reload();
  }

  // Checks the section here first, so a mistake shows at the prompt rather than only in the daemon log,
  // then signals the daemon and waits for its state to show the reload
  async reload() {
    const settings = visualizerSettings(this.config.get().visualizer);
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
    this.report(current, settings);
  }

  report(state, settings) {
    if (state.visualizer.error) throw new Error(`Visualizer off: ${state.visualizer.error}`);
    if (!state.visualizer.enabled) {
      out.info('Visualizer off (visualizer.enabled is false)');
      return;
    }
    out.success(`Reloaded the visualizer (${settings.engine} ${settings.module})`);
    for (const monitor of state.monitors) {
      const { visualizer } = monitor;
      out.print(`  ${fmt.bold(monitor.name)} ${visualizer ? `${visualizer.module} at ${visualizer.geometry}` : fmt.dim('no visualizer')}`);
    }
  }
}
