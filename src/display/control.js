import fs from 'fs-extra';
import { controlPath, readState } from './Daemon.js';

const TIMEOUT_MS = 15_000;
const POLL_MS = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Asks the running daemon (state from readState) to apply a change through control.json and SIGUSR1, and
// waits until its state shows the request handled. Resolves to the new state, or null when the daemon
// stopped because of it. change: { wallpaper, visualizer } switch parts; { durations: true } re-reads the
// durations next and the menu stored.
export async function sendControl(runtimeDir, state, change, { kill = process.kill, timeout = TIMEOUT_MS, logfile } = {}) {
  // Daemons before 2.21.0 have no SIGUSR1 handler, and Node exits on an unhandled SIGUSR1
  if (state.control === undefined) {
    throw new Error(`The running daemon (pid ${state.pid}) cannot take this request; restart it with \`backdrop stop && backdrop start\``);
  }
  await fs.writeJson(controlPath(runtimeDir), { pid: state.pid, ...change });
  kill(state.pid, 'SIGUSR1');

  const deadline = Date.now() + timeout;
  let current = state;
  while (current && current.control <= state.control) {
    if (Date.now() > deadline) throw new Error(`The daemon did not answer${logfile ? `; see ${logfile}` : ''}`);
    await sleep(POLL_MS);
    current = await readState(runtimeDir);
  }
  return current;
}
