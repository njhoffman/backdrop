// The Config page (docs/specs/web.md): every setting of the config file but the visualizer section, one control per
// kind (from the checks' info in src/config/schema.js), with its default, whether the file sets it and when a change
// takes effect. Changes are saved together, checked with the rest of the config first; a reset removes the key.
import { $, act, get, request, toast, watchState } from './common.js';

const SECTIONS = {
  display: 'Display', library: 'Library', load: 'System load', screensaver: 'Screensaver',
  menu: 'Menu', web: 'Web interface', output: 'Output', sources: 'Sources'
};
const APPLIES = {
  live: 'applies at once', command: 'from the next command', daemon: 'after a daemon restart', web: 'after `backdrop web` restarts'
};
let view = null;

// What a control shows for a value of its kind
function shown(field, value) {
  if (value === null || value === undefined) return '';
  switch (field.kind) {
    case 'strings': return value.join('\n');
    case 'monitors': return Array.isArray(value) ? value.join(', ') : String(value);
    case 'colors': return value.join(', ');
    case 'list': return JSON.stringify(value);
    default: return String(value);
  }
}

// The value a control holds, in the form the file should keep
function parse(field, control) {
  const text = control.type === 'checkbox' ? null : control.value.trim();
  switch (field.kind) {
    case 'boolean': return control.checked;
    case 'choice': return field.choices.find(choice => String(choice) === control.value);
    case 'integer':
    case 'number': return text === '' && field.nullable ? null : text === '' ? undefined : Number(text);
    case 'duration': return /^\d+(\.\d+)?$/.test(text) ? Number(text) : text;
    case 'strings': return control.value.split('\n').map(line => line.trim()).filter(Boolean);
    case 'monitors': return text === 'auto' ? 'auto' : text.split(/[,\s]+/).filter(Boolean);
    case 'workspace': return text === 'true' ? true : text === 'false' ? false : text;
    case 'colors': return text.split(/[,\s]+/).filter(Boolean);
    case 'text': return text === '' && field.nullable ? null : text;
    case 'secret': return text === '' ? undefined : text;
    default: return undefined;
  }
}

function controlFor(field) {
  const id = `field-${field.key.replace(/\./g, '-')}`;
  let control;
  if (field.kind === 'boolean') {
    control = document.createElement('input');
    control.type = 'checkbox';
  } else if (field.kind === 'choice') {
    control = document.createElement('select');
    control.append(...field.choices.map(choice => new Option(String(choice), String(choice))));
  } else if (field.kind === 'strings') {
    control = document.createElement('textarea');
    control.rows = 3;
  } else {
    control = document.createElement('input');
    if (field.kind === 'integer' || field.kind === 'number') {
      control.type = 'number';
      if (field.min !== undefined) control.min = String(field.min);
      if (field.max !== undefined) control.max = String(field.max);
      control.step = String(field.step ?? (field.kind === 'integer' ? 1 : 'any'));
    } else if (field.kind === 'secret') {
      control.type = 'password';
      control.autocomplete = 'off';
    } else {
      control.type = 'text';
    }
    if (field.kind === 'list') control.readOnly = true;
  }
  control.id = id;
  control.name = field.key;
  control.dataset.key = field.key;
  return control;
}

function setControl(field, control) {
  if (field.kind === 'boolean') control.checked = Boolean(field.value);
  else if (field.kind === 'secret') {
    control.value = '';
    control.placeholder = field.set ? (field.fromEnvironment ? 'set from PEXELS_API' : 'set (type to replace)') : 'not set';
  } else control.value = shown(field, field.value);
}

function render(next) {
  view = next;
  $('#path').textContent = next.path;
  const problems = $('#problems');
  const lines = [...next.errors.map(error => `Mistake: ${error}`), ...next.warnings];
  problems.hidden = !lines.length;
  problems.querySelector('div').replaceChildren(...lines.map(line => Object.assign(document.createElement('p'), { textContent: line })));

  const form = $('#settings');
  form.replaceChildren();
  for (const [section, title] of Object.entries(SECTIONS)) {
    const fields = next.fields.filter(field => field.key.split('.')[0] === section);
    if (!fields.length) continue;
    const panel = document.createElement('fieldset');
    panel.className = 'panel config-section';
    const legend = document.createElement('legend');
    legend.textContent = title;
    panel.append(legend);
    for (const field of fields) panel.append(row(field));
    form.append(panel);
  }
  updateSavebar();
}

function row(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'config-row';
  const label = document.createElement('label');
  const control = controlFor(field);
  label.htmlFor = control.id;
  label.className = 'config-key';
  label.textContent = field.key.split('.').slice(1).join('.');
  setControl(field, control);
  const help = document.createElement('p');
  help.className = 'config-help muted';
  const defaults = field.kind === 'secret' || field.default === undefined ? '' : ` Default: ${shown(field, field.default) || 'none'}.`;
  help.textContent = `${field.help}.${defaults}`;
  const badges = document.createElement('span');
  badges.className = 'config-badges';
  const applies = Object.assign(document.createElement('span'), { className: `badge applies-${field.applies}`, textContent: APPLIES[field.applies] });
  badges.append(applies);
  if (field.inFile) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'set in the file' }));
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset';
  reset.title = 'Remove it from the file, so the default applies';
  reset.hidden = !field.inFile;
  reset.addEventListener('click', () => act(async () => {
    const result = await request('DELETE', `/api/config/${encodeURIComponent(field.key)}`);
    render(result.config);
    toast(`${field.key} is back to its default; it applies ${APPLIES[field.applies].replace('applies ', '')}`);
  }));
  control.addEventListener('input', updateSavebar);
  control.addEventListener('change', updateSavebar);
  wrapper.append(label, control, badges, reset, help);
  return wrapper;
}

// { key: value } for every control whose value differs from what the file gives
function changes() {
  const result = {};
  for (const field of view?.fields ?? []) {
    const control = document.querySelector(`[data-key="${field.key}"]`);
    if (!control || field.kind === 'list') continue;
    const value = parse(field, control);
    if (value === undefined) continue;
    if (field.kind !== 'secret' && JSON.stringify(value) === JSON.stringify(field.value)) continue;
    result[field.key] = value;
  }
  return result;
}

function updateSavebar() {
  const pending = Object.keys(changes());
  $('#savebar').hidden = !pending.length;
  $('#pending').textContent = pending.length === 1 ? `1 change: ${pending[0]}` : `${pending.length} changes`;
  for (const control of document.querySelectorAll('[data-key]')) {
    control.closest('.config-row').classList.toggle('changed', pending.includes(control.dataset.key));
  }
}

function bindPage() {
  $('#settings').addEventListener('submit', event => {
    event.preventDefault();
    const pending = changes();
    if (!Object.keys(pending).length) return;
    act(async () => {
      const result = await request('PATCH', '/api/config', { changes: pending });
      render(result.config);
      const restart = Object.keys(pending).map(key => result.config.fields.find(field => field.key === key))
        .filter(field => field.applies === 'daemon' || field.applies === 'web');
      toast(restart.length ? `Saved; ${restart.map(field => field.key).join(', ')} ${APPLIES[restart[0].applies]}` : 'Saved');
    }, $('#savebar'));
  });
  $('#discard').addEventListener('click', () => render(view));
}

bindPage();
act(() => get('/api/config')).then(next => next && render(next));
// The header's daemon status; the settings are read again only on request, so typing is never overwritten
watchState(() => {});
