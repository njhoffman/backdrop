import { spawn as spawnProcess } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { withX11 } from '../display/x11.js';
import { createVisualizer } from './index.js';
import { presetsOf, visualizerSettings } from './settings.js';

// How long an instance must keep running to count as working: GLava fails on a bad shader within a second
const RUN_MS = 2000;
const STOP_GRACE_MS = 1000;
// Lines of output kept from an instance that exits, to show why
const OUTPUT_LINES = 8;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Starts every instance of the visualizer section and of each preset (none first, then each by name) as a
// 1x1 window for RUN_MS, all at once, and reports which exit early. GLava reports a bad raw define or shader
// only by exiting with code 1, which in the daemon looks like five quick restarts and then nothing. Returns
// [{ preset, instance, ok, code, signal, output, error }]; error is a section or preset that does not check
// out (no instance ran). With audio: fifo and nothing writing to the fifo, GLava waits to open it, which
// counts as running.
export async function checkVisualizer(section, {
  spawn = spawnProcess, create = createVisualizer, kill = process.kill, runMs = RUN_MS, stopGrace = STOP_GRACE_MS,
  tmpRoot = os.tmpdir()
} = {}) {
  const targets = [null, ...Object.keys(presetsOf(section))];
  const root = await fs.mkdtemp(path.join(tmpRoot, 'bd-vcheck-'));
  const runs = [];
  const results = [];
  try {
    for (const [index, preset] of targets.entries()) {
      let settings;
      try {
        // Only this target's preset in the section, so one bad preset fails only itself (the built-in ones
        // are always there and check out)
        const own = preset !== null && section.presets?.[preset] !== undefined ? { [preset]: section.presets[preset] } : {};
        settings = visualizerSettings({ ...section, presets: own }, { preset });
      } catch (error) {
        results.push({ preset, instance: null, ok: false, error: error.message });
        continue;
      }
      for (const instance of settings.instances) {
        const result = { preset, instance: instance.name, ok: true, code: null, signal: null, output: [] };
        results.push(result);
        try {
          const adapter = create(settings, instance, { runtimeDir: path.join(root, String(index)) });
          await adapter.prepare();
          const { file, args, env } = adapter.command({ name: 'check' }, { x: 0, y: 0, width: 1, height: 1 });
          const child = spawn(file, args, { detached: true, stdio: [instance.pipe ? 'pipe' : 'ignore', 'pipe', 'pipe'], env });
          const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
          child.on('error', error => { result.ok = false; result.error = error.code === 'ENOENT' ? `${file} is not installed` : error.message; });
          for (const stream of [child.stdout, child.stderr]) {
            stream?.on('data', chunk => {
              result.output.push(...String(chunk).split('\n').filter(line => line.trim() && !/deprecated/.test(line)));
              result.output.splice(0, Math.max(0, result.output.length - OUTPUT_LINES));
            });
          }
          // GLava draws nothing until piped colors arrive; sent one per line, as the manager does
          if (instance.pipe) {
            child.stdin?.on('error', () => {});
            (async () => {
              for (const [name, value] of Object.entries(instance.pipe)) {
                child.stdin?.write(`${name} = ${value}\n`);
                await sleep(100);
              }
            })();
          }
          runs.push({ child, exited, result });
        } catch (error) {
          result.ok = false;
          result.error = error.message;
        }
      }
    }

    await sleep(runMs);
    await Promise.all(runs.map(async ({ child, exited, result }) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const { code, signal } = await exited;
        Object.assign(result, { ok: false, code, signal });
        return;
      }
      const killGroup = signal => {
        try {
          kill(-child.pid, signal);
        } catch {
          // already gone
        }
      };
      killGroup('SIGTERM');
      if (await Promise.race([exited.then(() => false), sleep(stopGrace).then(() => true)])) killGroup('SIGKILL');
    }));
  } finally {
    await fs.remove(root);
  }
  return results;
}

// Whether a compositor runs on $DISPLAY, or null when X cannot be reached
export async function compositorRuns(x11 = withX11) {
  try {
    return await x11(x => x.hasCompositor());
  } catch {
    return null;
  }
}
