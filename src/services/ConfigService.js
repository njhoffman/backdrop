import { configFields, validateConfig } from '../config/schema.js';
import { LIVE_SETTINGS } from '../display/daemon/ConfigChanges.js';

// The config file as the web interface's Config page edits it (docs/specs/web.md): every setting the checks know
// (configFields) with its value, its default, whether the file sets it and when a change takes effect; changes are
// checked with the whole config before ConfigManager.setInFile writes them, keeping the file's comments and layout,
// and a reset removes the key so its default applies (removeInFile). The visualizer section has its own page.
//
// applies: live (the daemon takes it at once from its config watch), command (the CLI reads it on each run), daemon
// (needs `backdrop stop` and `start`), web (needs `backdrop web` started again).

function getIn(object, keys) {
  return keys.reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

function setIn(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (target[key] === null || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

export function appliesWhen(key) {
  const [section] = key.split('.');
  if (['sources', 'menu', 'output'].includes(section)) return 'command';
  if (section === 'web') return 'web';
  if (section === 'load' || LIVE_SETTINGS[key] !== undefined) return 'live';
  return 'daemon';
}

export class ConfigService {
  // config: the running process's ConfigManager, refreshed after each write so the process sees what it wrote
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.fields = configFields();
  }

  // The file loaded again, tolerating mistakes so they can be shown
  async load() {
    const fresh = new this.config.constructor(this.config.configPath);
    await fresh.loadConfig({ tolerant: true });
    return fresh;
  }

  field(key) {
    const field = this.fields.find(item => item.key === key);
    if (!field) throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 404 });
    return field;
  }

  // { path, errors, warnings, fields: [{ key, kind, choices, min, max, help, value, default, inFile, applies }] }; a
  // secret's value is never given, only whether it is set and whether it comes from the environment
  async describe() {
    const fresh = await this.load();
    const defaults = fresh.getUserDefaults();
    const current = fresh.get();
    return {
      path: fresh.configPath,
      errors: fresh.errors ?? [],
      warnings: fresh.warnings ?? [],
      fields: this.fields.map(({ keys, ...field }) => {
        const inFile = getIn(fresh.userConfig, keys) !== undefined;
        const value = getIn(current, keys);
        const base = { ...field, inFile, applies: appliesWhen(field.key) };
        if (field.kind === 'secret') return { ...base, set: Boolean(value), fromEnvironment: Boolean(value) && !inFile };
        // The file's own form (5m rather than 300) where it sets one
        return { ...base, value: inFile ? getIn(fresh.userConfig, keys) : value, default: getIn(defaults, keys) };
      })
    };
  }

  // Writes { key: value } changes, each as the file should hold it, after checking them with the rest of the config:
  // a value the checks refuse, or one that breaks a rule between settings (load.off_above above image_above), writes
  // nothing. Returns describe().
  async update(changes) {
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
      throw new Error('Give the changes as { "section.key": value }');
    }
    const fields = Object.keys(changes).map(key => this.field(key));
    const fresh = await this.load();
    const candidate = structuredClone(fresh.get());
    for (const field of fields) setIn(candidate, field.keys, structuredClone(changes[field.key]));
    // Only the problems these changes make: mistakes already in the file are shown apart (describe's errors)
    const problems = validateConfig(candidate).filter(problem => fields.some(field => problem.startsWith(`${field.key} `)
      || (field.keys[0] === 'load' && problem.startsWith('load.off_above must be above'))));
    if (problems.length) throw new Error(problems.join('; '));
    for (const field of fields) await this.config.setInFile(field.keys, changes[field.key]);
    await this.refresh(fields);
    this.logger.info('Config changed from the web interface', { settings: fields.map(field => field.key) });
    return this.describe();
  }

  // Removes a key from the file, so its default applies again. Returns describe().
  async reset(key) {
    const field = this.field(key);
    await this.config.removeInFile(field.keys);
    await this.refresh([field]);
    this.logger.info('Config setting reset from the web interface', { setting: key });
    return this.describe();
  }

  // The running process's own copy, for the sections written
  async refresh(fields) {
    for (const section of new Set(fields.map(field => field.keys[0]))) await this.config.reloadSection(section);
  }
}
