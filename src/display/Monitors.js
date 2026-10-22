import { execFile } from 'child_process';
import { promisify } from 'util';

export const run = async (file, args) => (await promisify(execFile)(file, args)).stdout;

// Parses `xrandr --listactivemonitors`, e.g. " 0: +*DP-3 2304/698x1296/393+0+0  DP-3".
// Only active monitors are listed, so connected-but-disabled outputs are skipped.
export function parseMonitors(text) {
  const monitors = [];
  const pattern = /^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/;

  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (match) {
      const [, primary, name, width, height, x, y] = match;
      monitors.push({
        name,
        width: Number(width),
        height: Number(height),
        x: Number(x),
        y: Number(y),
        primary: primary === '*'
      });
    }
  }
  return monitors;
}

// display.monitors is 'auto' (all active) or a list of output names
export function selectMonitors(monitors, setting) {
  if (setting === 'auto' || setting === undefined || setting === null) {
    return monitors;
  }
  const wanted = [].concat(setting);
  const missing = wanted.filter(name => !monitors.some(monitor => monitor.name === name));
  if (missing.length) {
    throw new Error(`Configured monitors not active: ${missing.join(', ')}`);
  }
  return monitors.filter(monitor => wanted.includes(monitor.name));
}

export async function listMonitors(exec = run) {
  return parseMonitors(await exec('xrandr', ['--listactivemonitors']));
}

export function geometry(monitor) {
  return `${monitor.width}x${monitor.height}+${monitor.x}+${monitor.y}`;
}

export function monitorAt(monitors, x, y) {
  return monitors.find(monitor =>
    x >= monitor.x && x < monitor.x + monitor.width &&
    y >= monitor.y && y < monitor.y + monitor.height
  ) ?? null;
}

// Parses `xdotool getmouselocation --shell`
export function parsePointer(text) {
  const x = /^X=(-?\d+)$/m.exec(text);
  const y = /^Y=(-?\d+)$/m.exec(text);
  if (!x || !y) {
    throw new Error('Cannot read pointer location from xdotool');
  }
  return { x: Number(x[1]), y: Number(y[1]) };
}

export async function pointerMonitor(monitors, exec = run) {
  const { x, y } = parsePointer(await exec('xdotool', ['getmouselocation', '--shell']));
  return monitorAt(monitors, x, y);
}
