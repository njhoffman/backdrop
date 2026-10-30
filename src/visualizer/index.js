import path from 'path';
import { GlavaVisualizer } from './GlavaVisualizer.js';

// The visualizer adapters by visualizer.engine. Each takes the normalized settings and a root directory it
// owns, and offers prepare() (files it needs before any instance starts) and command(monitor, geometry)
// ({ file, args, env }). An instance must stack itself low when its window maps (see VisualizerManager).
const ENGINES = { glava: GlavaVisualizer };

export function createVisualizer(settings, { runtimeDir, ...options }) {
  return new ENGINES[settings.engine](settings, { root: path.join(runtimeDir, 'visualizer'), ...options });
}
