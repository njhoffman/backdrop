// The Status page (docs/specs/web.md): what `backdrop status`, `stats` and `doctor` show. The daemon's part follows
// every snapshot; the library numbers are read on load and after each snapshot at most once a minute; the checks run
// on request, since doctor looks for every library file.
import { $, act, formatTime, get, watchState } from './common.js';

const STATS_EVERY_MS = 60000;
let statsReadAt = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

// A table from a header row and rows of cells (strings, numbers or nodes); numeric columns right-aligned
function table(header, rows, numeric = []) {
  const node = element('table', null, 'data-table');
  const head = node.createTHead().insertRow();
  header.forEach((title, index) => {
    const cell = element('th', title);
    if (numeric.includes(index)) cell.className = 'num';
    head.append(cell);
  });
  const body = node.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value, index) => {
      const cell = tr.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '';
      if (numeric.includes(index)) cell.className = 'num';
    });
  }
  return node;
}

function facts(target, pairs) {
  target.replaceChildren(...pairs.filter(([, value]) => value !== null && value !== undefined && value !== '')
    .flatMap(([name, value]) => [element('dt', name), element('dd', value)]));
}

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

// A horizontal bar for a share of 1
function bar(fraction, className = '') {
  const outer = element('span', null, `meter ${className}`);
  const inner = element('span', null, 'meter-fill');
  inner.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  outer.append(inner);
  return outer;
}

function hours(seconds) {
  if (!seconds) return '-';
  return seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} h` : formatTime(seconds);
}

function renderDaemon({ status }) {
  const { daemon, screensaver, web } = status;
  const load = daemon.load;
  facts($('#daemon-facts'), [
    ['State', daemon.running ? `running (pid ${daemon.pid})` : 'stopped'],
    ['Mode', status.mode === status.chosen_mode ? status.mode : `${status.mode} (${status.chosen_mode} held back by the load)`],
    ['Wallpaper', daemon.running ? (daemon.wallpaper_hidden ? 'hidden by the preset' : daemon.wallpaper ? 'on' : 'off') : null],
    ['Visualizer', daemon.running ? (daemon.visualizer ? 'on' : 'off') : null],
    ['Compositor', daemon.compositor === false ? 'none running: the area around the bars shows black' : null],
    ['Load', load ? `${load.level} (${load.value?.toFixed?.(2) ?? load.value} over ${load.window} min${load.limit ? `, limit ${load.limit}` : ''})` : null],
    ['Screensaver', screensaver ? (screensaver.active ? `on since ${new Date(screensaver.since ?? Date.now()).toLocaleTimeString()}` : 'off') : null],
    ['Web', web ? `port ${web.port} (pid ${web.pid})` : null],
    ['Config', status.config_warnings.length ? status.config_warnings.join('; ') : null]
  ]);
  $('#monitors').replaceChildren(status.monitors.length ? table(
    ['Monitor', 'Size', 'Eligible', 'CPU', 'Decoder', 'GPU memory', 'Playing'],
    status.monitors.map(monitor => [
      monitor.name, `${monitor.width}x${monitor.height}`, monitor.eligible,
      monitor.cpu_percent === null ? '-' : `${monitor.cpu_percent}%`, monitor.decoder ?? '-',
      monitor.gpu_memory_bytes === null ? '-' : bytes(monitor.gpu_memory_bytes),
      monitor.playing ? `#${monitor.playing.id} ${monitor.playing.file ?? ''}` : 'nothing'
    ]), [2, 3, 5]) : element('p', daemon.running ? 'Waiting for the monitors in display.monitors' : 'No monitors while the daemon is stopped', 'muted'));
}

function renderStats(stats) {
  const { library, ratings, resolutions, storage, recent, quota, sources, queries, playback, monitors } = stats;
  const kindRow = row => [row.kind, row.total, row.new, row.kept, row.skipped, row.pending, row.kind === 'image' ? '-' : hours(row.duration)];
  const libraryTable = table(['Kind', 'Total', 'New', 'Kept', 'Skipped', 'Pending', 'Playing time'],
    [...library.kinds.map(kindRow), kindRow(library.total)], [1, 2, 3, 4, 5, 6]);
  libraryTable.tBodies[0].lastElementChild.classList.add('total-row');
  $('#library').replaceChildren(libraryTable);
  $('#library-note').textContent = `Pending items are saved by searches, not downloaded.${monitors
    ? ` Eligible now: ${monitors.map(monitor => `${monitor.name} ${monitor.eligible.video} videos, ${monitor.eligible.image} images`).join('; ')}.` : ''}`;

  const rated = ratings.rated || 1;
  $('#ratings').replaceChildren(...[3, 2, 1].map(stars => {
    const line = element('div', null, 'bar-row');
    line.append(element('span', '★'.repeat(stars), 'bar-label'), bar(ratings.byRating[stars] / rated), element('span', ratings.byRating[stars], 'num'));
    return line;
  }), (() => {
    const line = element('div', null, 'bar-row');
    line.append(element('span', 'skipped', 'bar-label'), element('span'), element('span', ratings.byRating[0], 'num'));
    return line;
  })());
  $('#ratings-note').textContent = [`${ratings.orientations.landscape} landscape, ${ratings.orientations.portrait} portrait`,
    `${ratings.changes} rating changes`, ratings.last ? `last ${ratings.last.slice(0, 16)} UTC` : ''].filter(Boolean).join(', ');

  const total = resolutions.reduce((sum, item) => sum + item.count, 0) || 1;
  $('#resolutions').replaceChildren(...resolutions.map(({ bucket, count }) => {
    const line = element('div', null, 'bar-row');
    line.append(element('span', bucket, 'bar-label'), bar(count / total), element('span', count, 'num'));
    return line;
  }));

  $('#storage').replaceChildren(table(['Folder', 'Files', 'Size', ''],
    [...storage.dirs.map(dir => [dir.name, dir.files, bytes(dir.bytes), bar(storage.bytes ? dir.bytes / storage.bytes : 0)]),
      ['total', '', bytes(storage.bytes), '']], [1, 2]));
  $('#storage-note').textContent = storage.trashDays
    ? `Trash files are purged ${storage.trashDays} days after they were skipped.`
    : 'Trash purging is off (library.trash_days: 0).';

  $('#recent-title').textContent = `Last ${recent.days} days`;
  facts($('#recent'), [
    ['Added', recent.added], ['Ratings', recent.ratings], ['Searches', recent.searches],
    ['All time', `${recent.searches_all_time} searches${recent.duplicates ? `, ${recent.duplicates} duplicate downloads` : ''}`]
  ]);
  $('#quota').replaceChildren(...(quota ? [element('p', `Pexels quota: ${quota.remaining ?? '?'} of ${quota.limit ?? '?'} left${
    quota.reset ? `, resets ${new Date(quota.reset * 1000).toLocaleString()}` : ''}`, 'small')] : []));

  $('#sources').replaceChildren(sources.length ? table(['Source', 'Items', 'Downloaded', 'Kept', 'Skipped', 'Pending', 'Avg rating'],
    sources.map(row => [row.source, row.total, row.downloaded, row.kept, row.skipped, row.pending, row.average ? row.average.toFixed(1) : '-']),
    [1, 2, 3, 4, 5, 6]) : element('p', 'No sources yet', 'muted'));
  $('#queries').replaceChildren(...(queries.length ? [table(['Search', 'Results', 'Downloaded', 'Kept'],
    queries.map(row => [`"${row.query}"`, row.results, row.downloaded, row.kept]), [1, 2, 3])] : []));

  $('#playback').replaceChildren(playback.groups.length ? table(['Kind', 'Size', 'Decoder', 'Items', 'Sampled', 'Avg CPU'],
    playback.groups.map(row => [row.kind, row.bucket, row.decoder, row.items, hours(row.seconds), `${((row.cpu_seconds / row.seconds) * 100).toFixed(1)}%`]),
    [3, 4, 5]) : element('p', 'No samples yet: the daemon records them while items play', 'muted'));
  $('#expensive').replaceChildren(...playback.expensive.map(item => element('li',
    `#${item.id} ${item.width}x${item.height}: ${((item.cpu_seconds / item.sampled_seconds) * 100).toFixed(1)}% CPU${item.hwdec === 'no' || !item.hwdec ? ', software decoding' : ` (${item.hwdec})`}`)),
  ...(playback.software ? [element('li', `${playback.software} item(s) last played with software decoding`, 'warn-text')] : []));
}

async function loadStats() {
  statsReadAt = Date.now();
  const stats = await act(() => get('/api/stats'));
  if (stats) renderStats(stats);
}

function renderChecks({ ok, failed, warned, checks }) {
  $('#checks-summary').textContent = ok
    ? `All passed${warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : ''}`
    : `${failed} failed${warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : ''}`;
  $('#checks').replaceChildren(table(['', 'Group', 'Check', 'Result'], checks.map(check => {
    const mark = element('span', check.status, `check-${check.status}`);
    const detail = element('span', check.detail);
    if (check.hint) {
      const hint = element('div', check.hint, 'muted small');
      detail.append(hint);
    }
    return [mark, check.group, check.name, detail];
  })));
}

$('#run-checks').addEventListener('click', event => act(async () => {
  event.target.disabled = true;
  $('#checks-summary').textContent = 'Running...';
  try {
    renderChecks(await get('/api/doctor'));
  } finally {
    event.target.disabled = false;
  }
}));

watchState(snapshot => {
  renderDaemon(snapshot);
  if (Date.now() - statsReadAt > STATS_EVERY_MS) loadStats();
});
loadStats();
