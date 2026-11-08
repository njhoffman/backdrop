// The Now playing page (docs/specs/web.md): one card per monitor, drawn again from every snapshot the server sends
// over /api/events. Changes go out through common.js with this run's token in a header.
import { $, act, formatTime, post, stars, toast, watchState } from './common.js';

let snapshot = null;
// Cards keep their elements between snapshots, so a slider being dragged is not replaced under the pointer
const cards = new Map();

function formatDuration(seconds) {
  if (seconds === 0) return '0';
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function bouncesNow(item) {
  return item.bounce ?? snapshot?.settings?.video_loop === 'bounce';
}

function render(next) {
  snapshot = next;
  const { status, durations } = next;
  const { daemon } = status;
  $('#stopped').hidden = daemon.running;

  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === status.chosen_mode));
  }
  $('#held').textContent = status.mode !== status.chosen_mode ? `showing ${status.mode}s while the system load is high` : '';
  $('#wallpaper').checked = Boolean(daemon.wallpaper);
  $('#visualizer').checked = Boolean(daemon.visualizer);
  $('#wallpaper').disabled = $('#visualizer').disabled = !daemon.running;

  const form = $('#durations');
  for (const kind of ['image', 'video']) {
    const input = form.elements[kind];
    if (document.activeElement !== input) input.value = formatDuration(durations[kind].seconds);
    input.title = durations[kind].set ? 'Set by next or the menu' : `display.${kind}_duration`;
  }

  const seen = new Set();
  for (const monitor of status.monitors) {
    seen.add(monitor.name);
    renderCard(monitor);
  }
  for (const [name, card] of cards) {
    if (seen.has(name)) continue;
    card.remove();
    cards.delete(name);
  }
}

function renderCard(monitor) {
  let card = cards.get(monitor.name);
  if (!card) {
    card = $('#monitor-card').content.firstElementChild.cloneNode(true);
    card.dataset.monitor = monitor.name;
    bindCard(card);
    $('#monitors').append(card);
    cards.set(monitor.name, card);
  }
  const item = monitor.playing;
  card.classList.toggle('empty', !item);
  card.classList.toggle('image', item?.kind === 'image');
  card.querySelector('.monitor-name').textContent = monitor.name;
  card.querySelector('.monitor-size').textContent = `${monitor.width}x${monitor.height}`
    + (monitor.cpu_percent !== null ? ` · cpu ${monitor.cpu_percent}%` : '') + (monitor.decoder ? ` ${monitor.decoder}` : '');

  const thumb = card.querySelector('.thumb');
  if (item && thumb.dataset.id !== String(item.id)) {
    thumb.dataset.id = String(item.id);
    thumb.src = `/thumbs/${item.id}.jpg`;
  }
  card.querySelector('.item-title').textContent = item ? `#${item.id}  ${item.file ?? ''}` : '';
  card.querySelector('.item-meta').textContent = item
    ? [item.kind, `${item.width}x${item.height}`, formatTime(item.duration), item.fps ? `${item.fps} fps` : '', item.tags?.slice(0, 6).join(', ')]
      .filter(Boolean).join(' · ')
    : '';
  card.querySelector('.item-rating').textContent = item ? stars(item.rating) : '';

  for (const button of card.querySelectorAll('button[data-action]')) {
    button.disabled = !item && button.dataset.action !== 'next' && button.dataset.action !== 'prev';
    if (button.dataset.rating) button.setAttribute('aria-pressed', String(item?.rating?.value === Number(button.dataset.rating)));
  }
  const speed = card.querySelector('[data-adjust="speed"]');
  const dim = card.querySelector('[data-adjust="dim"]');
  const bounce = card.querySelector('[data-adjust="bounce"]');
  for (const control of [speed, dim, bounce]) control.disabled = !item;
  if (item) {
    if (![...speed.options].some(option => Number(option.value) === item.speed)) speed.append(new Option(String(item.speed)));
    speed.value = [...speed.options].find(option => Number(option.value) === item.speed).value;
    if (document.activeElement !== dim) dim.value = String(item.dim);
    card.querySelector('.dim-value').textContent = dim.value;
    bounce.value = item.bounce === null ? 'reset' : item.bounce ? 'on' : 'off';
    bounce.options[0].textContent = `Default (${snapshot.settings.video_loop === 'bounce' ? 'on' : 'off'})`;
    bounce.title = bouncesNow(item) ? 'Bounces once its reversed copy is made' : '';
    const state = card.querySelector('.bounce-state');
    state.hidden = item.bounce_state !== 'reversing';
    state.title = 'Its reversed copy is being made in the background; it bounces once that is done';
  }
}

function bindCard(card) {
  const monitor = () => encodeURIComponent(card.dataset.monitor);
  card.querySelector('.actions').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, rating } = button.dataset;
    const body = action === 'keep' ? { rating: Number(rating) } : {};
    act(() => post(`/api/monitors/${monitor()}/${action}`, body), card);
  });
  const dim = card.querySelector('[data-adjust="dim"]');
  dim.addEventListener('input', () => { card.querySelector('.dim-value').textContent = dim.value; });
  for (const control of card.querySelectorAll('[data-adjust]')) {
    control.addEventListener('change', () => {
      act(() => post(`/api/monitors/${monitor()}/${control.dataset.adjust}`, { value: control.value }), card);
    });
  }
}

function bindPage() {
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => act(() => post('/api/mode', { mode: button.dataset.mode })));
  }
  for (const part of ['wallpaper', 'visualizer']) {
    const box = $(`#${part}`);
    box.addEventListener('change', () => act(() => post('/api/parts', { [part]: box.checked })));
  }
  $('#durations').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    const body = {};
    for (const kind of ['image', 'video']) {
      const value = form.elements[kind].value.trim();
      if (value && value !== formatDuration(snapshot.durations[kind].seconds)) body[kind] = value;
    }
    if (!Object.keys(body).length) return;
    act(async () => {
      await post('/api/durations', body);
      toast('Durations set until next --clear or a daemon restart');
    });
  });
  $('#clear-durations').addEventListener('click', () => act(async () => {
    await post('/api/durations', { reset: true });
    toast('Durations back to display.image_duration and display.video_duration');
  }));
  $('#undo').addEventListener('click', () => act(async () => {
    const { action, item } = await post('/api/undo');
    toast(action === 'none' ? 'No rating to undo' : `Undid the rating of #${item.id}`);
  }));
  $('#start').addEventListener('click', () => act(() => post('/api/daemon', { running: true }), $('#stopped')));
}

bindPage();
watchState(render);
