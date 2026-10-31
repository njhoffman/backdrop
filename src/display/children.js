import fs from 'fs';
import path from 'path';

const REAP_GRACE_MS = 2000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function childrenPath(runtimeDir) {
  return path.join(runtimeDir, 'children.json');
}

// The process's start time in clock ticks since boot (/proc/<pid>/stat field 22), or null when it is gone or
// /proc cannot be read. A pid and start time together name one process, even after the pid is reused.
export function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may hold spaces and parentheses, so fields are counted after the last ')'
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return start ?? null;
  } catch {
    return null;
  }
}

function defaultIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Every process the daemon spawns, kept in children.json while it runs: xwinwrap and GLava as process
// groups (detached), pactl as a plain child. A daemon that dies without stopping (kill -9, out of memory)
// leaves the file behind, and the next start or `backdrop stop` ends those processes (reapOrphans).
export class ChildRegistry {
  constructor({ runtimeDir, pid = process.pid, readStart = processStart }) {
    this.runtimeDir = runtimeDir;
    this.pid = pid;
    this.readStart = readStart;
    this.children = new Map();
  }

  // spawn with each child recorded until it exits
  track(spawn) {
    return (file, args, options = {}) => {
      const child = spawn(file, args, options);
      if (!child?.pid) return child;
      this.children.set(child, { pid: child.pid, group: Boolean(options.detached), command: path.basename(file), start: this.readStart(child.pid) });
      this.write();
      child.on?.('exit', () => {
        this.children.delete(child);
        this.write();
      });
      return child;
    };
  }

  // Written to a temporary file and renamed, like state.json; removed when nothing is left
  write() {
    const file = childrenPath(this.runtimeDir());
    try {
      if (!this.children.size) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${this.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ daemon: this.pid, children: [...this.children.values()] }));
      fs.renameSync(temporary, file);
    } catch {
      // Losing the record only loses the cleanup after a crash
    }
  }

  remove() {
    fs.rmSync(childrenPath(this.runtimeDir()), { force: true });
  }
}

// Ends the processes a dead daemon left running, as recorded in children.json, and removes its state,
// sockets and playlists. A process is only signalled when its start time still matches the record, so a
// reused pid is never touched; without /proc nothing is. A group is then waited on as a whole, since mpv
// outlives xwinwrap: Linux does not reuse a pid while a process group still holds it as its id.
// Returns the processes signalled.
export async function reapOrphans(runtimeDir, {
  kill = process.kill, isRunning = defaultIsRunning, readStart = processStart, grace = REAP_GRACE_MS, logger
} = {}) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(childrenPath(runtimeDir), 'utf8'));
  } catch {
    return [];
  }
  if (isRunning(record.daemon)) return [];

  const running = child => child.start !== null && readStart(child.pid) === child.start;
  const groupRunning = child => {
    try {
      kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const orphans = (record.children ?? []).filter(running);
  const alive = () => orphans.filter(child => (child.group ? groupRunning(child) : running(child)));
  const signal = (children, name) => {
    for (const child of children) {
      try {
        kill(child.group ? -child.pid : child.pid, name);
      } catch {
        // exited in between
      }
    }
  };
  if (orphans.length) {
    logger?.warn('Stopping processes left by a daemon that exited without stopping', {
      daemon: record.daemon, processes: orphans.map(({ pid, command }) => ({ pid, command }))
    });
    signal(orphans, 'SIGTERM');
    const deadline = Date.now() + grace;
    while (alive().length && Date.now() < deadline) await sleep(50);
    signal(alive(), 'SIGKILL');
  }

  for (const name of fs.readdirSync(runtimeDir)) {
    if (/\.(sock|m3u)$/.test(name) || ['state.json', 'children.json', 'control.json', 'next-filters.json'].includes(name)) {
      fs.rmSync(path.join(runtimeDir, name), { force: true });
    }
  }
  return orphans;
}
