import { pathToFileURL } from 'url';
import { checkSetting } from '../config/schema.js';
import { run } from '../display/Monitors.js';
import { stillFor } from '../library/thumbnail.js';
import { out, formatClock, formatResolution } from './output.js';

// commands: navigation commands notify; all: the daemon notifies on every load, commands included; off
export { NOTIFY_MODES } from '../config/schema.js';

// Tests replace exec so notify-send never runs, and still so no ffmpeg runs for the picture
const settings = { exec: run, still: (media, dir, logger) => stillFor(media, dir, { logger, nice: true }) };

export function configureNotify({ exec, still } = {}) {
  if (exec) settings.exec = exec;
  if (still) settings.still = still;
}

export function notifyMode(display) {
  return checkSetting('display.notify', display.notify ?? 'commands');
}

// Notification bodies and rofi messages are Pango markup
export function escapeMarkup(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ratingText(rating) {
  if (!rating) return 'unrated';
  if (rating.rating === 0) return 'skipped';
  return `${'★'.repeat(rating.rating)}${'☆'.repeat(3 - rating.rating)}`;
}

// Summary and body for an item that started playing, e.g.
//   #412  video  3840×2160
//   0:18 · 25 fps · ★★☆ · DP-1
//   ocean, waves, aerial
// With bold (the menu), the summary is markup too and the resolution and duration are in bold. With rich (desktop
// notifications), the running time stands out, large and bold, the rest of its line is dimmed, and the tags are
// spaced apart, each in a color of TAG_COLORS in turn
export function describeNotification({ monitor, media, rating, tags = [] }, { bold = false, rich = false } = {}) {
  if (rich) return richNotification({ monitor, media, rating, tags });
  const strong = text => (bold ? `<b>${escapeMarkup(text)}</b>` : escapeMarkup(text));
  const details = [];
  if (media.kind !== 'image' && Number.isFinite(media.duration)) details.push(strong(formatClock(media.duration)));
  if (media.kind !== 'image' && media.fps) details.push(escapeMarkup(`${Math.round(media.fps * 100) / 100} fps`));
  details.push(escapeMarkup(ratingText(rating)), escapeMarkup(monitor.name));
  const body = [details.join(' · ')];
  if (tags.length) body.push(escapeMarkup(tags.join(', ')));
  const resolution = formatResolution(media.width, media.height);
  return {
    summary: bold ? `${escapeMarkup(`#${media.id}  ${media.kind}`)}  ${strong(resolution)}` : `#${media.id}  ${media.kind}  ${resolution}`,
    body: body.join('\n')
  };
}

// Soft colors that read on dark and light notifications alike
const TAG_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff'];
// More tags wrap a narrow notification over several lines
const RICH_TAGS = 8;

function richNotification({ monitor, media, rating, tags }) {
  const details = [];
  if (media.kind !== 'image' && media.fps) details.push(`${Math.round(media.fps * 100) / 100} fps`);
  details.push(ratingText(rating), monitor.name);
  const time = media.kind !== 'image' && Number.isFinite(media.duration)
    ? `<span size="large" weight="bold">${escapeMarkup(formatClock(media.duration))}</span>  `
    : '';
  const body = [`${time}<span alpha="70%">${escapeMarkup(details.join(' · '))}</span>`];
  if (tags.length) {
    body.push(tags.slice(0, RICH_TAGS).map((tag, index) => `<span foreground="${TAG_COLORS[index % TAG_COLORS.length]}">${escapeMarkup(tag)}</span>`).join('  '));
  }
  return { summary: `#${media.id}  ${media.kind}  ${formatResolution(media.width, media.height)}`, body: body.join('\n') };
}

// Failing only leaves the old one until it times out, and it may well have gone already
async function closeNotification(id) {
  await settings.exec('gdbus', [
    'call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.CloseNotification', String(id)
  ]).catch(() => {});
}

// Sends a desktop notification for what a monitor now plays. Each monitor replaces its previous
// notification where the server supports it (replace id, dunst stack tag). Failures are only logged:
// a missing notify-send or notification server must not fail the command or the daemon.
// With thumbnails (the thumbnail folder), the notification shows the item: a 16:9 still (stillFor) as the
// image-path hint, as a file:// URI, which deadd needs (a plain path showed a placeholder); without one it shows an
// icon as before: the image itself, or a generic video icon.
export async function notifyPlaying(database, { monitor, media, rating }, { logger, thumbnails } = {}) {
  if (!media) return;
  const key = `notify_id:${monitor.name}`;
  const { summary, body } = describeNotification({
    monitor, media, rating, tags: database.getTags(media.id)
  }, { rich: true });
  const previous = database.getSetting(key);
  const still = thumbnails ? await Promise.resolve(settings.still(media, thumbnails, logger)).catch(() => null) : null;
  const picture = still
    ? `--hint=string:image-path:${pathToFileURL(still).href}`
    : `--icon=${media.kind === 'image' ? media.path : 'video-x-generic'}`;
  const args = [
    '--print-id', '--app-name=backdrop', '--urgency=low',
    `--hint=string:x-dunst-stack-tag:backdrop-${monitor.name}`,
    picture,
    ...(previous ? [`--replace-id=${previous}`] : []),
    summary, body
  ];
  try {
    const id = Number.parseInt(await settings.exec('notify-send', args), 10);
    if (Number.isInteger(id)) database.setSetting(key, id);
    // A server that answers a replace with a new id (deadd) has kept the old one on screen
    if (previous && Number.isInteger(id) && id !== previous) await closeNotification(previous);
  } catch (error) {
    logger?.warn('Notification failed', { error: error.message });
  }
}

// Errors from commands run without a terminal (the rofi menu), shown whatever display.notify says
export async function notifyError(message, { logger } = {}) {
  try {
    await settings.exec('notify-send', ['--app-name=backdrop', '--urgency=critical', 'backdrop', escapeMarkup(message)]);
  } catch (error) {
    logger?.warn('Error notification failed', { error: error.message });
  }
}

// The daemon changing what it shows for the system load
export async function notifyLoad(message, { logger } = {}) {
  try {
    await settings.exec('notify-send', ['--app-name=backdrop', 'backdrop', escapeMarkup(message)]);
  } catch (error) {
    logger?.warn('Notification failed', { error: error.message });
  }
}

// Called by navigation commands after they switched a monitor; with display.notify: all the daemon
// sends it instead. A bad setting only warns, since the switch has already happened.
export async function notifyCommand(config, database, playing, { logger } = {}) {
  let mode;
  try {
    mode = notifyMode(config.get().display);
  } catch (error) {
    out.warn(error.message);
    return;
  }
  if (mode === 'commands') await notifyPlaying(database, playing, { logger, thumbnails: config.get().paths.thumbnails });
}
