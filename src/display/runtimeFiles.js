import path from 'path';

// The daemon's files in the runtime dir, which the CLI reads and writes too

export function statePath(runtimeDir) {
  return path.join(runtimeDir, 'state.json');
}

// What `backdrop start/stop --wallpaper/--visualizer` asks a running daemon to change (see applyControl):
// the single slot daemons before 2.38.2 read, which the daemon still takes
export function controlPath(runtimeDir) {
  return path.join(runtimeDir, 'control.json');
}

// One file per control request, named by its id; the daemon applies them in name order, oldest first
export const CONTROL_REQUEST = /^control-(.+)\.json$/;

export function controlRequestPath(runtimeDir, id) {
  return path.join(runtimeDir, `control-${id}.json`);
}

// Filters for next that last as long as this daemon (see nextFilters.js); removed when it starts and stops
export function nextFiltersPath(runtimeDir) {
  return path.join(runtimeDir, 'next-filters.json');
}

// Held while a command reads, merges and writes next-filters.json, so commands at once keep each other's values
export function nextFiltersLockPath(runtimeDir) {
  return path.join(runtimeDir, 'next-filters.lock');
}
