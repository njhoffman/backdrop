import { readState } from '../display/Daemon.js';
import { sendControl } from '../display/control.js';
import { listMonitors, run } from '../display/Monitors.js';
import { checkCopies } from '../library/copies.js';
import { wantsJson } from '../utils/mediaView.js';
import { out, fmt, displayPath, formatBytes } from '../utils/output.js';

const PROBLEMS = {
  unwanted: 'no longer wanted',
  stale: 'older than its video',
  small: 'smaller than the monitors need',
  unsized: 'size not recorded yet'
};

const resolution = size => `${size.width}x${size.height}`;

// `backdrop copies`: the reversed and smoothed copies the daemon made, checked against their videos and the monitors
// (src/library/copies.js); with --sync the daemon deletes the ones that no longer fit and makes them again
export class CopiesCommand {
  constructor(config, database, logger, { exec = run, send = sendControl, read = readState, monitors = listMonitors } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.exec = exec;
    this.send = send;
    this.read = read;
    this.listMonitors = monitors;
  }

  // The daemon's monitors, else xrandr's; none (sizes unchecked) without X
  async monitors(state) {
    if (state?.monitors?.length) return state.monitors;
    return this.listMonitors(this.exec).catch(() => []);
  }

  async run(options = {}) {
    const json = wantsJson(options);
    const settings = this.config.get();
    const state = await this.read(settings.paths.runtime);
    const monitors = await this.monitors(state);
    const copies = await checkCopies({ config: settings, database: this.database, monitors });
    const problems = copies.filter(copy => copy.problem);
    let synced = false;
    if (options.sync && state) {
      await this.send(settings.paths.runtime, state, { copies: true }, { logfile: settings.paths.logfile });
      synced = true;
    }
    if (json) {
      out.json({ copies, monitors: monitors.map(({ name, width, height }) => ({ name, width, height })), synced });
      return { copies, synced };
    }
    for (const copy of problems) {
      const sizes = copy.problem === 'small' ? ` (${resolution(copy.size)}, needs ${resolution(copy.need)})` : '';
      out.print(`${fmt.bold(`#${copy.id}`)} ${copy.copy}: ${PROBLEMS[copy.problem]}${sizes} ${fmt.dim(displayPath(copy.file))}`);
    }
    const bytes = copies.reduce((sum, copy) => sum + copy.bytes, 0);
    const checkedAgainst = monitors.length ? ` against ${monitors.map(monitor => `${monitor.name} ${resolution(monitor)}`).join(', ')}` : ' (no monitors found, sizes unchecked)';
    const counts = Object.keys(PROBLEMS).map(problem => [problem, problems.filter(copy => copy.problem === problem).length]).filter(([, count]) => count);
    const summary = counts.length ? counts.map(([problem, count]) => `${count} ${PROBLEMS[problem]}`).join(', ') : 'all play';
    out.print(`${copies.length} copies, ${formatBytes(bytes)}${checkedAgainst}: ${summary}`);
    if (synced && problems.length) out.success('The daemon is deleting those and making the wanted ones again, playing the originals meanwhile');
    else if (synced) out.success('Nothing to remake; the daemon checked the copies again');
    else if (options.sync) out.info('No daemon is running; `backdrop start` checks the copies the same way');
    else if (problems.length) out.info('backdrop copies --sync has the daemon delete them and make the wanted ones again');
    return { copies, synced };
  }
}
