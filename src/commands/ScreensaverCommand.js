import { run as defaultRun } from '../display/Monitors.js';
import { readState } from '../display/Daemon.js';
import { sendControl } from '../display/control.js';
import { restoreDesktop } from '../display/daemon/Screensaver.js';
import { out } from '../utils/output.js';
import { notifyError } from '../utils/notify.js';

export const SCREENSAVER_ACTIONS = ['toggle', 'on', 'off', 'status'];

// `backdrop screensaver`, usually from an i3 binding: asks the daemon, which owns the mode (daemon/Screensaver.js)
export class ScreensaverCommand {
  constructor(config, database, logger, { run = defaultRun, kill = process.kill, timeout } = {}) {
    this.config = config;
    this.logger = logger;
    this.exec = run;
    this.kill = kill;
    this.timeout = timeout;
  }

  get runtimeDir() {
    return this.config.get().paths.runtime;
  }

  async run(action = 'toggle') {
    const state = await readState(this.runtimeDir);
    if (action === 'status') {
      const active = state?.screensaver?.active;
      out.info(active ? `Screensaver on (${state.screensaver.trigger})` : 'Screensaver off');
      return;
    }
    if (!state) {
      // A daemon that crashed in this mode left the desktop as it was: Escape or the toggle must still get out
      if (action !== 'on' && await restoreDesktop(this.runtimeDir, { run: this.exec, logger: this.logger })) {
        out.info('Screensaver off (the daemon had stopped)');
        return;
      }
      if (action === 'off') {
        out.info('Screensaver off');
        return;
      }
      const message = 'The daemon is not running; start it with `backdrop start`';
      await notifyError(message, { logger: this.logger });
      throw new Error(message);
    }
    const current = await sendControl(this.runtimeDir, state, { screensaver: action }, {
      kill: this.kill, ...(this.timeout ? { timeout: this.timeout } : {}), logfile: this.config.get().paths.logfile
    });
    out.success(current?.screensaver?.active ? 'Screensaver on' : 'Screensaver off');
  }
}
