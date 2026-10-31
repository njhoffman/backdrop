import path from 'path';

// The daemon's files in the runtime dir, which the CLI reads and writes too

export function statePath(runtimeDir) {
  return path.join(runtimeDir, 'state.json');
}

// What `backdrop start/stop --wallpaper/--visualizer` asks a running daemon to change (see applyControl)
export function controlPath(runtimeDir) {
  return path.join(runtimeDir, 'control.json');
}

// Filters for next that last as long as this daemon (see nextFilters.js); removed when it starts and stops
export function nextFiltersPath(runtimeDir) {
  return path.join(runtimeDir, 'next-filters.json');
}
