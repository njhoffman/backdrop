// The Visualizer page (docs/specs/web.md): the visualizer on or off, its preset, and per instance the settings the rofi
// menu changes, sent to the daemon as live changes (kept until it restarts) and saved as a preset on request. The view
// is read again from /api/visualizer whenever the daemon's state changes.
import { $, act, get, post, request, toast, watchState } from './common.js';

let view = null;
const cards = new Map();

// The changes one setting makes, as the menu sends them (src/commands/MenuCommand.js)
function changesFor(setting, value, look) {
  switch (setting) {
    case 'module': return { module: value };
    case 'amplify': return { [look.module]: { amplify: Number(value) } };
    case 'opacity': return { opacity: Number(value) };
    case 'anchor': return { placement: { anchor: value } };
    case 'now': return { sleeve: { now: value } };
    case 'now_position': return { sleeve: { now_position: value } };
    case 'lyrics_align': return { sleeve: { lyrics_align: value } };
    case 'source': return { palette: value === 'wallpaper' ? { source: 'wallpaper', pick: look.palette.pick } : { source: 'config' } };
    case 'pick': return { palette: { source: 'wallpaper', pick: value } };
    default: throw new Error(`Unknown setting ${setting}`);
  }
}

function colorChanges(colors, look) {
  return { palette: { source: 'config' }, [look.module]: { [look.colorOption]: look.colors.length === 2 ? colors : colors[0] } };
}

// #rrggbb for an <input type="color">, from #rrggbb or #rrggbbaa
function inputColor(value) {
  return /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : '#000000';
}

function options(select, values, current) {
  if (select.options.length !== values.length) select.replaceChildren(...values.map(value => new Option(value, value)));
  select.value = current;
}

async function change(instance, changes, busy) {
  const result = await act(() => post('/api/visualizer/live', { instance, changes }), busy);
  if (result) render(result.visualizer);
}

function render(next) {
  view = next;
  $('#stopped').hidden = next.running;
  const error = $('#error');
  error.hidden = !next.error;
  error.querySelector('p').textContent = next.error ? `The visualizer is off: ${next.error}` : '';
  const enabled = $('#enabled');
  enabled.checked = next.enabled;
  enabled.disabled = !next.running;

  const preset = $('#preset');
  preset.replaceChildren(new Option('None', ''), ...next.presets.map(({ name, source }) => new Option(`${name} (${source})`, name)));
  preset.value = next.preset ?? '';
  preset.disabled = !next.running;
  $('#reset').disabled = !next.running || !next.changed;
  $('#save').querySelector('button').disabled = !next.running;
  $('#changed').textContent = next.changed ? 'Changed here or in the menu until the daemon restarts' : '';

  // A control being changed is left alone, so a drag is not reset under the pointer
  const editing = document.activeElement?.closest?.('.instance');
  const seen = new Set();
  for (const instance of next.instances) {
    seen.add(instance.name);
    const card = cards.get(instance.name) ?? addCard(instance.name);
    if (card !== editing) renderCard(card, instance, next);
  }
  for (const [name, card] of cards) {
    if (seen.has(name)) continue;
    card.remove();
    cards.delete(name);
  }
}

function addCard(name) {
  const card = $('#instance-card').content.firstElementChild.cloneNode(true);
  card.dataset.instance = name;
  for (const radio of card.querySelectorAll('input[type="radio"]')) radio.name = `source-${name}`;
  bindCard(card);
  $('#instances').append(card);
  cards.set(name, card);
  return card;
}

function renderCard(card, { name, look, changed, sent }, { choices, running }) {
  const sleeve = look.engine === 'sleeve';
  card.classList.toggle('sleeve', sleeve);
  card.classList.toggle('glava', !sleeve);
  card.querySelector('.instance-name').textContent = name;
  card.querySelector('.instance-engine').textContent = sleeve ? 'sleeve' : look.module;
  card.querySelector('.instance-changed').hidden = !changed;
  const field = setting => card.querySelector(`[data-setting="${setting}"]`);
  options(field('module'), choices.modules, look.module);
  field('amplify').value = String(look.amplify ?? '');
  if (sleeve) {
    options(field('now'), choices.sleeve.now, look.sleeve.now);
    options(field('now_position'), choices.sleeve.positions, look.sleeve.now_position);
    options(field('lyrics_align'), choices.sleeve.aligns, look.sleeve.lyrics_align);
  }
  field('opacity').value = String(look.opacity);
  card.querySelector('.opacity-value').textContent = String(look.opacity);
  options(field('anchor'), choices.anchors, look.anchor);

  const wallpaper = look.palette.source === 'wallpaper';
  for (const radio of card.querySelectorAll('[data-setting="source"]')) radio.checked = radio.value === (wallpaper ? 'wallpaper' : 'config');
  options(field('pick'), choices.picks, look.palette.pick);
  field('pick').hidden = !wallpaper;
  const fixed = card.querySelector('.fixed-colors');
  fixed.hidden = wallpaper;
  const inputs = card.querySelector('.color-inputs');
  inputs.replaceChildren(...look.colors.map((color, index) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = inputColor(color);
    input.dataset.index = String(index);
    input.setAttribute('aria-label', look.colors.length === 2 ? (index ? 'Top color' : 'Base color') : 'Color');
    return input;
  }));
  const swatches = card.querySelector('.swatches');
  swatches.replaceChildren(...Object.entries(choices.swatches).map(([swatch, pair]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.title = swatch;
    button.dataset.swatch = swatch;
    for (const color of look.colors.length === 2 ? pair : [pair[1]]) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = color;
      button.append(dot);
    }
    button.append(swatch);
    return button;
  }));
  card.querySelector('.sent').textContent = sent ? `Last sent: ${Object.values(sent).map(color => color.slice(0, 7)).join(' to ')}` : '';
  for (const control of card.querySelectorAll('select, input, button')) control.disabled = !running;
}

function lookOf(card) {
  return view.instances.find(instance => instance.name === card.dataset.instance).look;
}

function bindCard(card) {
  const instance = () => card.dataset.instance;
  card.addEventListener('change', event => {
    const target = event.target;
    if (target.type === 'color') {
      const colors = [...card.querySelectorAll('.color-inputs input')].map(input => input.value);
      change(instance(), colorChanges(colors, lookOf(card)), card);
      return;
    }
    const { setting } = target.dataset;
    if (!setting) return;
    change(instance(), changesFor(setting, target.value, lookOf(card)), card);
  });
  card.querySelector('[data-setting="opacity"]').addEventListener('input', event => {
    card.querySelector('.opacity-value').textContent = event.target.value;
  });
  card.querySelector('.swatches').addEventListener('click', event => {
    const button = event.target.closest('[data-swatch]');
    if (!button) return;
    const look = lookOf(card);
    const pair = view.choices.swatches[button.dataset.swatch];
    change(instance(), colorChanges(look.colors.length === 2 ? pair : [pair[1]], look), card);
  });
}

function bindPage() {
  $('#enabled').addEventListener('change', event => act(async () => {
    render((await post('/api/visualizer/enabled', { on: event.target.checked })).visualizer);
  }));
  $('#preset').addEventListener('change', event => act(async () => {
    render((await post('/api/visualizer/preset', { name: event.target.value || null })).visualizer);
  }));
  $('#reset').addEventListener('click', () => act(async () => {
    render((await request('DELETE', '/api/visualizer/live')).visualizer);
    toast('Changes dropped');
  }));
  $('#save').addEventListener('submit', event => {
    event.preventDefault();
    const name = event.target.elements.name.value.trim();
    act(async () => {
      let result;
      try {
        result = await post(`/api/visualizer/presets/${encodeURIComponent(name)}`, {});
      } catch (error) {
        if (!/exists/.test(error.message) || !window.confirm(`Replace the preset ${name}?`)) throw error;
        result = await post(`/api/visualizer/presets/${encodeURIComponent(name)}`, { replace: true });
      }
      render(result.visualizer);
      event.target.reset();
      toast(`Saved as visualizer.presets.${name}, and now in use`);
    });
  });
}

// Every snapshot can mean a change made elsewhere (the menu, `backdrop visualizer preset`); read the view again,
// one request at a time
let pending = null;
function refresh() {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    const next = await act(() => get('/api/visualizer'));
    if (next) render(next);
  }, 150);
}

bindPage();
// Read at once rather than after the first snapshot, so the page does not start empty
act(() => get('/api/visualizer')).then(next => next && render(next));
watchState(refresh);
