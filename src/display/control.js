import fs from 'fs-extra';
import { controlPath, controlRequestPath, readState } from './Daemon.js';

const TIMEOUT_MS = 15_000;
const POLL_MS = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let sequence = 0;

// A request id that sorts by time, then by process: the daemon applies requests in name order
export function requestId(now = Date.now(), pid = process.pid) {
  return `${String(now).padStart(15, '0')}-${pid}-${String(sequence++).padStart(4, '0')}`;
}

// Asks the running daemon (state from readState) to apply a change and waits until its state shows the
// request handled. Resolves to the new state, or null when the daemon stopped because of it.
// change: { wallpaper, visualizer } switch parts; { durations: true } re-reads the durations next and the menu stored.
// Each request is its own file (renamed into place, so the daemon never reads half of one), and the CLI waits
// for its id in state.handled, so requests sent at the same moment neither overwrite each other nor answer
// for each other. Daemons before 2.38.2 (no handled list) read the single control.json and count requests.
export async function sendControl(runtimeDir, state, change, { kill = process.kill, timeout = TIMEOUT_MS, logfile, id = requestId() } = {}) {
  // Daemons before 2.21.0 have no SIGUSR1 handler, and Node exits on an unhandled SIGUSR1
  if (state.control === undefined) {
    throw new Error(`The running daemon (pid ${state.pid}) cannot take this request; restart it with \`backdrop stop && backdrop start\``);
  }
  const request = { pid: state.pid, ...change };
  const perRequest = Array.isArray(state.handled);
  const file = perRequest ? controlRequestPath(runtimeDir, id) : controlPath(runtimeDir);
  if (perRequest) {
    const temporary = `${runtimeDir}/.control-${id}.json.tmp`;
    await fs.writeJson(temporary, request);
    await fs.rename(temporary, file);
  } else {
    await fs.writeJson(file, request);
  }
  // A request the daemon never took is withdrawn, so it does not apply later by surprise
  const withdraw = () => (perRequest ? fs.remove(file).catch(() => {}) : undefined);
  try {
    kill(state.pid, 'SIGUSR1');
  } catch (error) {
    await withdraw();
    throw error;
  }

  const handled = current => (perRequest ? current.handled?.includes(id) : current.control > state.control);
  const deadline = Date.now() + timeout;
  let current = state;
  while (current && !handled(current)) {
    if (Date.now() > deadline) {
      await withdraw();
      throw new Error(`The daemon did not answer${logfile ? `; see ${logfile}` : ''}`);
    }
    await sleep(POLL_MS);
    current = await readState(runtimeDir);
  }
  return current;
}
