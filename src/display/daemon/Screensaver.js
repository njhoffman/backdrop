import fs from 'fs-extra';
import { screensaverPath } from '../runtimeFiles.js';
import { enterWorkspaces, DEFAULT_WORKSPACE } from '../../utils/workspace.js';
import { run as defaultRun } from '../Monitors.js';

// The i3 binding mode the config defines for this, holding Escape and the keys that still work: only a binding
// can catch Escape with no window focused
export const I3_MODE = 'screensaver';
export const IDLE_CHECK_MS = 15_000;

const runHooks = async (commands, run, logger) => {
  for (const command of commands ?? []) {
    try {
      await run('sh', ['-c', command]);
    } catch (error) {
      logger?.warn('Screensaver command failed', { command, error: error.message });
    }
  }
};

// Puts the desktop back from what a daemon recorded on entering, for a daemon that is gone: the workspaces, the
// i3 mode and on_leave. Resolves to whether there was anything to put back.
export async function restoreDesktop(runtimeDir, { run = defaultRun, logger } = {}) {
  const file = screensaverPath(runtimeDir);
  const saved = await fs.readJson(file).catch(() => null);
  if (!saved) return false;
  await run('i3-msg', ['mode', 'default']).catch(error => logger?.debug('No i3 mode to leave', { error: error.message }));
  await runHooks(saved.onLeave, run, logger);
  if (saved.restore) await run('i3-msg', [saved.restore]).catch(error => logger?.warn('Failed to restore i3 workspaces', { error: error.message }));
  await fs.remove(file);
  return true;
}

// Screensaver mode, for a Daemon (passed in): an empty workspace on every output with nothing but the daemon's
// layers, its own visualizer preset, and the i3 mode that keeps only a few keys. It ends only by asking (Escape
// or the toggle in that mode), so rating from a menu cannot end it. What it changed is recorded in a file, so a
// crashed daemon's next start, or `backdrop screensaver off` without one, can put the desktop back.
export class Screensaver {
  constructor(daemon) {
    this.daemon = daemon;
    this.active = null;
    this.saved = null;
  }

  get settings() {
    return this.daemon.config.get().screensaver ?? {};
  }

  summary() {
    return this.active ? { active: true, ...this.active } : { active: false };
  }

  async begin() {
    await restoreDesktop(this.daemon.runtimeDir, { run: this.daemon.exec, logger: this.daemon.logger });
  }

  async apply(action) {
    if (action === 'on' || (action === 'toggle' && !this.active)) return this.enter('key');
    return this.leave();
  }

  async enter(trigger) {
    if (this.active) return;
    const { exec: run, logger, visualizers, runtimeDir } = this.daemon;
    const { workspace, preset, on_enter: onEnter, on_leave: onLeave } = this.settings;
    const restore = await enterWorkspaces(workspace ?? DEFAULT_WORKSPACE, { run, logger });
    this.saved = { preset: visualizers.presetOverride, wasOn: visualizers.active };
    await fs.writeJson(screensaverPath(runtimeDir), { restore, onLeave: onLeave ?? [] });
    this.active = { trigger, since: this.daemon.now() };
    logger.info('Screensaver on', { trigger, preset });
    await run('i3-msg', ['mode', I3_MODE]).catch(error => logger.warn('No i3 mode for the screensaver, so Escape will not end it', { error: error.message }));
    await runHooks(onEnter, run, logger);
    try {
      if (!visualizers.active) await visualizers.setEnabled(true);
      if (preset) await visualizers.setPreset(preset);
    } catch (error) {
      logger.error('Screensaver visualizer failed', { preset, error: error.message });
    }
  }

  async leave() {
    if (!this.active) return;
    const { exec: run, logger, visualizers, runtimeDir, stopping } = this.daemon;
    const { preset, wasOn } = this.saved;
    this.active = null;
    this.saved = null;
    logger.info('Screensaver off');
    await restoreDesktop(runtimeDir, { run, logger });
    // A daemon on its way out stops them anyway
    if (stopping) return;
    try {
      if (this.settings.preset) await visualizers.setPreset(preset);
      if (!wasOn) await visualizers.setEnabled(false);
    } catch (error) {
      logger.error('Screensaver visualizer failed', { error: error.message });
    }
  }

  // Starts it once the desktop has been idle for idle_minutes, with screensaver.idle on and the load under max_load
  async checkIdle() {
    const { idle, idle_minutes: minutes, max_load: maxLoad } = this.settings;
    const { logger, load } = this.daemon;
    if (!idle || this.active || this.daemon.stopping) return;
    let idleMs;
    try {
      idleMs = Number(await this.daemon.exec('xprintidle', []));
    } catch (error) {
      logger.debug('Cannot read how long the desktop has been idle', { error: error.message });
      return;
    }
    if (!(idleMs >= minutes * 60_000) || load.off) return;
    if (typeof maxLoad === 'number' && load.governor.read() > maxLoad) return;
    await this.enter('idle');
  }
}
