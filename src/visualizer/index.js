import path from 'path';
import { GlavaVisualizer } from './GlavaVisualizer.js';
import { SleeveVisualizer } from './SleeveVisualizer.js';
import { ProjectmVisualizer } from './ProjectmVisualizer.js';

// The visualizer adapters by each instance's engine. Each takes the normalized settings, one of their instances
// and a root directory it owns, and offers prepare() (files it needs before any instance starts) and command(monitor, geometry)
// ({ file, args, env }). An instance must stack itself low when its window maps (see VisualizerManager).
const ENGINES = { glava: GlavaVisualizer, sleeve: SleeveVisualizer, projectm: ProjectmVisualizer };

export function createVisualizer(settings, instance, { runtimeDir, ...options }) {
  return new ENGINES[instance.engine ?? settings.engine](settings, instance, { root: path.join(runtimeDir, 'visualizer', instance.name), ...options });
}
