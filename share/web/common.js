// What every page shares: this run's token, JSON requests, the toast, the header's daemon pill and the live state
// stream (/api/events), which every page listens to so the header and any monitor list stay current.

const token = document.querySelector('meta[name="backdrop-token"]').content;

export const $ = selector => document.querySelector(selector);

export async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-backdrop-token': token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `${response.status} ${response.statusText}`);
  for (const warning of result.warnings ?? []) toast(warning, true);
  return result;
}

export const post = (url, body = {}) => request('POST', url, body);
export const patch = (url, body) => request('PATCH', url, body);

export async function get(url) {
  const response = await fetch(url);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `${response.status} ${response.statusText}`);
  return result;
}

// Runs a change, showing its error rather than failing silently; busy marks what waits for it
export async function act(change, busy) {
  busy?.classList.add('busy');
  try {
    return await change();
  } catch (error) {
    toast(error.message, true);
    return null;
  } finally {
    busy?.classList.remove('busy');
  }
}

let toastTimer;
export function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 7000 : 3000);
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function stars(rating) {
  if (!rating) return 'Unrated';
  return rating.value ? `Kept ${'★'.repeat(rating.value)}` : 'Skipped';
}

function renderHeader({ status, version }) {
  const { daemon } = status;
  $('#version').textContent = version ? `v${version}` : '';
  const pill = $('#daemon');
  pill.textContent = daemon.running ? `running, pid ${daemon.pid}` : 'stopped';
  pill.className = `pill ${daemon.running ? 'ok' : 'off'}`;
}

// Calls render with every snapshot, after the header has taken it
export function watchState(render) {
  const events = new EventSource('/api/events');
  events.addEventListener('state', event => {
    const snapshot = JSON.parse(event.data);
    renderHeader(snapshot);
    render(snapshot);
  });
  events.addEventListener('error', () => {
    $('#daemon').textContent = 'reconnecting';
    $('#daemon').className = 'pill';
  });
}
