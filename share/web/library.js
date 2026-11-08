// The Library page (docs/specs/web.md): a page of library items with the list commands' filters, and a dialog to
// rate, adjust or play one. Filters, sort and page live in the address (?kind=video&tag=ocean&page=2), so a view
// can be bookmarked and the back button works.
import { $, act, formatTime, get, patch, post, stars, toast, watchState } from './common.js';

const FIELDS = ['kind', 'status', 'min_rating', 'tag', 'query', 'keywords', 'sort'];
const DEFAULTS = { kind: 'all', status: 'shown', sort: 'newest' };
let page = 1;
let pages = 1;
let monitors = [];
let videoLoop = 'loop';
// The item in the dialog
let open = null;

function filtersFromForm() {
  const form = $('#filters');
  const filters = {};
  for (const name of FIELDS) {
    const value = form.elements[name].value.trim();
    if (value && value !== DEFAULTS[name]) filters[name] = value;
  }
  return filters;
}

function formFromAddress() {
  const params = new URLSearchParams(location.search);
  const form = $('#filters');
  for (const name of FIELDS) form.elements[name].value = params.get(name) ?? DEFAULTS[name] ?? '';
  page = Number(params.get('page')) || 1;
}

// Several tags, separated by commas or spaces, must all match
function apiQuery(filters) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (name === 'tag') for (const tag of value.split(/[,\s]+/).filter(Boolean)) params.append('tag', tag);
    else params.set(name, value);
  }
  params.set('page', String(page));
  return params.toString();
}

function remember(filters) {
  const params = new URLSearchParams(filters);
  if (page > 1) params.set('page', String(page));
  const search = params.toString() ? `?${params}` : '';
  if (search !== location.search) history.pushState(null, '', `${location.pathname}${search}`);
}

async function load({ push = true } = {}) {
  const filters = filtersFromForm();
  if (push) remember(filters);
  const result = await act(() => get(`/api/media?${apiQuery(filters)}`), $('#grid'));
  if (!result) return;
  page = result.page;
  pages = result.pages;
  const first = result.total ? (result.page - 1) * result.per_page + 1 : 0;
  $('#count').textContent = result.total
    ? `${first}-${first + result.items.length - 1} of ${result.total} items`
    : 'No items match';
  $('#page').textContent = `page ${result.page} of ${result.pages}`;
  $('#prev-page').disabled = page <= 1;
  $('#next-page').disabled = page >= pages;
  renderGrid(result.items);
}

function describe(item) {
  return [item.kind, `${item.width}x${item.height}`, formatTime(item.duration), item.fps ? `${item.fps} fps` : ''].filter(Boolean).join(' · ');
}

function adjustments(item) {
  return [item.speed !== 1 && item.speed ? `speed ${item.speed}` : '', item.dim ? `dim ${item.dim}` : '',
    item.bounce === true ? 'bounce' : item.bounce === false ? 'no bounce' : ''].filter(Boolean).join(', ');
}

function renderGrid(items) {
  const grid = $('#grid');
  grid.replaceChildren(...items.map(item => {
    const tile = $('#tile').content.firstElementChild.cloneNode(true);
    tile.querySelector('.tile-thumb').src = `/thumbs/${item.id}.jpg`;
    tile.querySelector('.tile-title').textContent = `#${item.id}  ${item.file ?? ''}`;
    tile.querySelector('.tile-meta').textContent = [describe(item), stars(item.rating), adjustments(item)].filter(Boolean).join(' · ');
    tile.addEventListener('click', () => showDetails(item));
    return tile;
  }));
}

function renderDetails(item) {
  open = item;
  const dialog = $('#details');
  dialog.classList.toggle('image', item.kind === 'image');
  const thumb = dialog.querySelector('.details-thumb');
  if (thumb.dataset.id !== String(item.id)) {
    thumb.dataset.id = String(item.id);
    thumb.src = `/thumbs/${item.id}.jpg`;
  }
  $('#details-title').textContent = `#${item.id}  ${item.file ?? ''}`;
  dialog.querySelector('.details-meta').textContent = [describe(item), item.source, item.playback?.cpu_percent != null
    ? `cpu ${item.playback.cpu_percent}%${item.playback.decoder ? ` ${item.playback.decoder}` : ''}` : ''].filter(Boolean).join(' · ');
  dialog.querySelector('.details-rating').textContent = `${stars(item.rating)} · ${item.status}`;
  dialog.querySelector('.details-tags').textContent = [item.tags.join(', '), item.queries.length ? `searches: ${item.queries.join(', ')}` : '']
    .filter(Boolean).join(' · ');
  const credit = dialog.querySelector('.details-credit');
  credit.replaceChildren();
  if (item.author || item.page_url) {
    credit.append(item.author ? `By ${item.author} ` : '');
    if (item.page_url) {
      const link = document.createElement('a');
      link.href = item.page_url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = 'source page';
      credit.append(link);
    }
  }
  for (const button of dialog.querySelectorAll('[data-rating]')) {
    button.setAttribute('aria-pressed', String(Boolean(item.rating) && item.rating.value === Number(button.dataset.rating)));
  }
  const speed = dialog.querySelector('[data-adjust="speed"]');
  if (![...speed.options].some(option => Number(option.value) === item.speed)) speed.append(new Option(String(item.speed)));
  speed.value = [...speed.options].find(option => Number(option.value) === item.speed).value;
  const dim = dialog.querySelector('[data-adjust="dim"]');
  dim.value = String(item.dim);
  dialog.querySelector('.dim-value').textContent = dim.value;
  const bounce = dialog.querySelector('[data-adjust="bounce"]');
  bounce.value = item.bounce === null ? 'reset' : item.bounce ? 'on' : 'off';
  bounce.options[0].textContent = `Default (${videoLoop === 'bounce' ? 'on' : 'off'})`;
  renderPlayButtons();
}

function renderPlayButtons() {
  const group = $('#details .play-on');
  group.replaceChildren(...monitors.map(name => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.textContent = `Play on ${name}`;
    button.addEventListener('click', () => act(async () => {
      await post(`/api/media/${open.id}/play`, { monitor: name });
      toast(`Playing #${open.id} on ${name}`);
    }, $('#details')));
    return button;
  }));
  group.hidden = !monitors.length;
}

async function showDetails(item) {
  renderDetails(item);
  $('#details').showModal();
  // The list's copy may be older than the item; the dialog shows the latest
  const latest = await act(() => get(`/api/media/${item.id}`));
  if (latest && open?.id === item.id) renderDetails(latest);
}

// After a change in the dialog: it shows the item as it is now, and the page is loaded again behind it
async function changed(item) {
  renderDetails(item);
  await load({ push: false });
}

function bindDetails() {
  const dialog = $('#details');
  dialog.querySelector('.actions').addEventListener('click', event => {
    const button = event.target.closest('[data-rating]');
    if (!button) return;
    act(async () => {
      const { item } = await post(`/api/media/${open.id}/rating`, { rating: Number(button.dataset.rating) });
      toast(item.status === 'skipped' ? `#${item.id} skipped` : `#${item.id} kept ${item.rating.value}/3`);
      await changed(item);
    }, dialog);
  });
  const dim = dialog.querySelector('[data-adjust="dim"]');
  dim.addEventListener('input', () => { dialog.querySelector('.dim-value').textContent = dim.value; });
  for (const control of dialog.querySelectorAll('[data-adjust]')) {
    control.addEventListener('change', () => act(async () => {
      const { item } = await patch(`/api/media/${open.id}`, { [control.dataset.adjust]: control.value });
      await changed(item);
    }, dialog));
  }
  dialog.addEventListener('close', () => { open = null; });
}

function bindFilters() {
  const form = $('#filters');
  let typing;
  form.addEventListener('input', event => {
    if (event.target.id === 'next-monitor') return;
    clearTimeout(typing);
    page = 1;
    // Text waits for a pause in typing; selects apply at once
    typing = setTimeout(() => load(), event.target.tagName === 'INPUT' ? 350 : 0);
  });
  form.addEventListener('submit', event => event.preventDefault());
  $('#prev-page').addEventListener('click', () => { page -= 1; load(); });
  $('#next-page').addEventListener('click', () => { page += 1; load(); });
  window.addEventListener('popstate', () => { formFromAddress(); load({ push: false }); });
  $('#next-matching').addEventListener('click', () => {
    const filters = filtersFromForm();
    const body = {};
    if (filters.tag) body.tag = filters.tag.split(/[,\s]+/).filter(Boolean);
    if (filters.query) body.query = [filters.query];
    if (filters.keywords) body.keywords = filters.keywords.split(/\s+/).filter(Boolean);
    if (!Object.keys(body).length) {
      toast('Set a tag, search or words first', true);
      return;
    }
    const monitor = $('#next-monitor').value;
    act(async () => {
      const { item } = await post(`/api/monitors/${encodeURIComponent(monitor)}/next`, body);
      toast(item ? `Playing #${item.id} on ${monitor}; later nexts keep these filters` : `${monitor}: nothing playing`);
    });
  });
}

async function loadFacets() {
  const facets = await act(() => get('/api/media/facets'));
  if (!facets) return;
  $('#tag-list').replaceChildren(...facets.tags.map(({ tag, count }) => new Option(`${tag} (${count})`, tag)));
  const select = $('#filters').elements.query;
  const chosen = new URLSearchParams(location.search).get('query') ?? '';
  select.append(...facets.queries.map(query => new Option(query, query)));
  select.value = chosen;
}

function onState({ status, settings }) {
  videoLoop = settings.video_loop;
  monitors = status.monitors.map(monitor => monitor.name);
  const select = $('#next-monitor');
  const chosen = select.value;
  select.replaceChildren(...monitors.map(name => new Option(name, name)));
  if (monitors.includes(chosen)) select.value = chosen;
  $('#next-matching').disabled = select.disabled = !monitors.length;
  if (open) renderPlayButtons();
}

formFromAddress();
bindFilters();
bindDetails();
watchState(onState);
await loadFacets();
await load({ push: false });
