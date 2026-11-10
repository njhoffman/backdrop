import YAML from 'yaml';
import { sendControl } from '../display/control.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { reservedMessage, reservedPreset } from '../display/daemon/Screensaver.js';
import { BUILTIN_PRESETS } from '../visualizer/presets.js';
import {
  ANCHORS, MODULES, PALETTE_PICKS, SLEEVE_ALIGNS, SLEEVE_NOW, SLEEVE_POSITIONS, instanceLook, instanceRaw, lookAsPreset, presetsOf, visualizerSettings
} from '../visualizer/settings.js';

// The running visualizer's look, its presets and live changes, for the rofi menu and the web interface's Visualizer page
// (docs/specs/web.md): what each instance looks like now, changes sent to the daemon as control requests
// (visualizer_set, checked against the section first, kept until the daemon restarts), presets, reset, and saving the
// look as a preset in the config file (ConfigManager.setInFile, which keeps the file's comments).

// Fixed gradients for the swatches, base color first (bars run from the first to the second)
export const SWATCHES = {
  ocean: ['#003a5c', '#33aacc'], ember: ['#3d0c02', '#ff7a33'], forest: ['#0b3d20', '#7ad151'],
  violet: ['#2a0a4a', '#b07cff'], gold: ['#4a3200', '#ffd166'], mono: ['#202020', '#e0e0e0']
};
export const PRESET_NAME = /^[A-Za-z0-9_-]+$/;

export class VisualizerService {
  // reload: read the config file's visualizer section again before each call, for a long-running caller (the web
  // server) that must see presets saved since it started and edits made by hand
  constructor({ config, database, logger, control, send = sendControl, reload = false }) {
    this.config = config;
    this.reload = reload;
    this.logger = logger;
    this.control = control ?? new DisplayControl({ config, database });
    this.sendControl = send;
  }

  get section() {
    return this.config.get().visualizer ?? {};
  }

  async refresh() {
    if (this.reload && this.config.configPath) await this.config.reloadSection('visualizer');
  }

  // The running daemon's state; changes need one
  async state() {
    const state = await this.control.state({ required: false });
    if (!state) throw new Error('The daemon is not running (start it to change the visualizer)');
    return state;
  }

  // The preset and live changes in force: the daemon's while it runs, else the config's preset
  static options(state, section) {
    return state ? { preset: state.visualizer?.preset ?? null, live: state.visualizer?.live ?? {} } : { preset: section.preset ?? null, live: {} };
  }

  // Everything the Visualizer page shows: whether the daemon runs, the visualizer is on (and why not), the active
  // preset and every preset (built in, from the config, or both), each instance's look and the colors last sent to
  // it, whether it has live changes, and the choices each setting takes.
  async describe() {
    await this.refresh();
    const state = await this.control.state({ required: false });
    const section = this.section;
    const options = VisualizerService.options(state, section);
    const names = state?.visualizer?.instances?.length ? state.visualizer.instances
      : (Array.isArray(section.instances) && section.instances.length ? section.instances.map(item => item.name) : ['main']);
    const sent = name => state?.monitors?.flatMap(monitor => monitor.visualizers ?? []).find(item => item.instance === name)?.colors ?? null;
    const own = section.presets ?? {};
    return {
      running: Boolean(state),
      enabled: state ? Boolean(state.visualizer?.enabled) : Boolean(section.enabled),
      error: state?.visualizer?.error ?? null,
      wallpaper: state ? state.wallpaper !== false : null,
      preset: options.preset,
      // The screensaver's own look only while it is on (or still in force)
      presets: Object.keys(presetsOf(section)).filter(name => name !== this.reserved(state) || name === options.preset).map(name => ({
        name, source: own[name] ? (BUILTIN_PRESETS[name] ? 'config, over the built-in one' : 'config') : 'built in'
      })),
      changed: Object.keys(options.live).length > 0,
      // yaml: the instance's settings as they apply now and its live changes alone, for the page's Advanced box
      instances: names.map(name => ({
        name, look: instanceLook(section, options, name), changed: Boolean(options.live[name]), sent: sent(name),
        yaml: { settings: toYaml(instanceRaw(section, options, name)), live: options.live[name] ? toYaml(options.live[name]) : '' }
      })),
      choices: {
        modules: MODULES, anchors: ANCHORS, picks: PALETTE_PICKS, swatches: SWATCHES,
        sleeve: { now: SLEEVE_NOW, positions: SLEEVE_POSITIONS, aligns: SLEEVE_ALIGNS }
      }
    };
  }

  // Sends a control request and waits for it; a visualizer_set the daemon refused is an error
  async send(state, change) {
    const { paths } = this.config.get();
    const current = await this.sendControl(paths.runtime, state, change, { logfile: paths.logfile });
    if (change.visualizer_set && current) {
      const { instance, changes } = change.visualizer_set;
      const applied = current.visualizer?.live?.[instance];
      if (!applied || !Object.keys(changes).every(key => applied[key] !== undefined)) {
        throw new Error(`The daemon refused the change; see ${paths.logfile}`);
      }
    }
    return current;
  }

  async setEnabled(on) {
    return this.send(await this.state(), { visualizer: Boolean(on) });
  }

  // Changes one instance's look until the daemon restarts, checked against the section, preset and earlier changes
  // first, e.g. { module: 'radial' }, { opacity: 0.6 }, { placement: { anchor: 'top' } }, { palette: { source: 'wallpaper' } }
  async change(instance, changes) {
    await this.refresh();
    const state = await this.state();
    const visualizer = state.visualizer ?? {};
    const live = { ...(visualizer.live ?? {}) };
    live[instance] = { ...(live[instance] ?? {}), ...changes };
    visualizerSettings(this.section, { preset: visualizer.preset ?? null, live });
    return this.send(state, { visualizer_set: { instance, changes } });
  }

  // The Advanced box's changes: YAML of visualizer settings for one instance (`placement: { size: 0.3 }`), parsed and
  // applied as change() applies the page's controls
  async changeYaml(instance, text) {
    let changes;
    try {
      changes = YAML.parse(String(text ?? ''));
    } catch (error) {
      throw new Error(`The changes are not YAML: ${error.message.split('\n')[0]}`);
    }
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
      throw new Error('Give the changes as a mapping of visualizer settings, such as `opacity: 0.6`');
    }
    return this.change(instance, changes);
  }

  // The preset kept for the screensaver while it is off, else null
  reserved(state) {
    return reservedPreset(this.config.get(), Boolean(state?.screensaver?.active));
  }

  // Switches to a preset (null for none), checked before the daemon sees it; live changes stay. The screensaver's
  // own preset only while the screensaver is on.
  async setPreset(name) {
    await this.refresh();
    const state = await this.state();
    if (name && name === this.reserved(state)) throw new Error(reservedMessage(name));
    visualizerSettings(this.section, { preset: name, live: state.visualizer?.live ?? {} });
    return this.send(state, { preset: name });
  }

  // Drops every live change
  async reset() {
    return this.send(await this.state(), { visualizer_reset: true });
  }

  // Whether a preset of that name exists, in the file or built in
  async presetExists(name) {
    return await this.config.fileHas(['visualizer', 'presets', name]) || Boolean(presetsOf(this.section)[name]);
  }

  // Writes the active preset with the live changes into the config as visualizer.presets.<name>, keeping the file's
  // other lines and comments, then switches the daemon to it with the changes dropped, so nothing moves. An existing
  // preset is replaced only with replace; otherwise the error has status 409.
  async savePreset(name, { replace = false } = {}) {
    if (typeof name !== 'string' || !PRESET_NAME.test(name)) throw new Error(`A preset name is letters, digits, - and _, not "${name}"`);
    await this.refresh();
    const state = await this.state();
    if (!replace && await this.presetExists(name)) {
      throw Object.assign(new Error(`A preset named ${name} exists`), { status: 409 });
    }
    const section = this.section;
    const look = lookAsPreset(section, VisualizerService.options(state, section));
    // Checked as the daemon will read it
    visualizerSettings({ ...section, presets: { ...(section.presets ?? {}), [name]: look } }, { preset: name });
    await this.config.setInFile(['visualizer', 'presets', name], look);
    await this.refresh();
    await this.send(state, { reload_config: true, visualizer_reset: true, preset: name });
    this.logger.info('Visualizer preset saved', { preset: name });
    return { name, look };
  }

  // Removes a preset saved in the config file (removeInFile), and has the daemon read its presets again. A built-in
  // preset has nothing in the file to remove; one the config sets over a built-in one goes back to the built-in. The
  // preset in use, the daemon's or the config's own visualizer.preset, is refused.
  async deletePreset(name) {
    if (typeof name !== 'string' || !PRESET_NAME.test(name)) throw new Error(`A preset name is letters, digits, - and _, not "${name}"`);
    await this.refresh();
    if (!await this.config.fileHas(['visualizer', 'presets', name])) {
      throw Object.assign(new Error(BUILTIN_PRESETS[name] ? `${name} is built in; only presets saved in the config can be deleted` : `No preset named ${name} in the config`),
        { status: BUILTIN_PRESETS[name] ? 409 : 404 });
    }
    const state = await this.control.state({ required: false });
    const active = state ? state.visualizer?.preset ?? null : this.section.preset ?? null;
    if (active === name || this.section.preset === name) {
      throw Object.assign(new Error(`${name} is in use; switch to another preset first`), { status: 409 });
    }
    await this.config.removeInFile(['visualizer', 'presets', name]);
    await this.refresh();
    if (state) await this.send(state, { reload_config: true });
    this.logger.info('Visualizer preset deleted', { preset: name });
    return { name, restored: Boolean(BUILTIN_PRESETS[name]) };
  }
}

function toYaml(value) {
  return Object.keys(value ?? {}).length ? YAML.stringify(value, { indent: 2, lineWidth: 0 }) : '';
}
