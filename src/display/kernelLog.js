import { spawn as spawnProcess } from 'child_process';
import path from 'path';
import readline from 'readline';
import { run } from '../library/reverse.js';

// The kernel log, followed through journalctl (it needs the adm or systemd-journal group; /dev/kmsg is closed to
// users while kernel.dmesg_restrict is set), for the warnings i915 logs before and when a GPU job hangs:
//   Fence expiration time out i915-0000:00:02.0:rife-ncnn-vulka[429491]:8!
//   i915 0000:00:02.0: [drm] GPU HANG: ecode 12:1:8fddfff9, in rife-ncnn-vulka [381556]
// A hang on the GPU the desktop draws on can freeze the machine, so smoothing on a GPU (display.smooth_gpu) watches
// for them and moves to the CPU on the first.

// The name the kernel gives a process started from binary: its file name, cut to 15 characters (TASK_COMM_LEN - 1)
export function processName(binary) {
  return path.basename(String(binary)).slice(0, 15);
}

// 'hang' or 'fence' when line reports GPU trouble in the process named name (from processName), else null
export function gpuTrouble(line, name) {
  const text = String(line);
  if (!name || !text.includes(name)) return null;
  if (/GPU HANG/.test(text)) return 'hang';
  if (/Fence expiration time out/.test(text)) return 'fence';
  return null;
}

// Whether this user can read the kernel's messages: the boot's last one comes back. Without permission journalctl
// shows only the user's own journal, which holds no kernel lines, so the answer is empty rather than an error.
export async function canReadKernelLog({ exec = run } = {}) {
  try {
    return Boolean(String(await exec('journalctl', ['-k', '-b', '-n', '1', '-q', '-o', 'cat', '--no-pager'])).trim());
  } catch {
    return false;
  }
}

// Follows new kernel messages, calling onLine with each; returns { stop }. onError gets a failure to start.
export function followKernelLog(onLine, { spawn = spawnProcess, onError = () => {} } = {}) {
  let child;
  try {
    child = spawn('journalctl', ['-k', '-f', '-n', '0', '-q', '-o', 'cat', '--no-pager'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    onError(error);
    return { stop() {} };
  }
  child.on('error', onError);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', onLine);
  return {
    stop() {
      lines.close();
      if (child.exitCode === null && !child.killed) child.kill();
    }
  };
}
