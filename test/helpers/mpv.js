import { spawn } from 'child_process';

const running = new Set();

// mpv with --idle stays forever, adopted by init, if nothing ends it, and removing its socket does not.
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

// A headless mpv on a socket for a test or a one-off probe, ended with this process whatever happens to the test
export function startMpv(socketPath, args = []) {
  const child = spawn('mpv', ['--no-config', '--idle=yes', '--vo=null', '--ao=null', '--no-audio', `--input-ipc-server=${socketPath}`, ...args], { stdio: 'ignore' });
  running.add(child);
  child.once('exit', () => running.delete(child));
  return child;
}
