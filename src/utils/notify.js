import { run } from '../display/Monitors.js';
import { out, formatClock, formatResolution } from './output.js';

// commands: navigation commands notify; all: the daemon notifies on every load, commands included; off
export const NOTIFY_MODES = ['commands', 'all', 'off'];

// Tests replace exec so notify-send never runs
const settings = { exec: run };

export function configureNotify({ exec } = {}) {
  if (exec) settings.exec = exec;
}

export function notifyMode(display) {
  const mode = display.notify ?? 'commands';
  if (!NOTIFY_MODES.includes(mode)) {
    throw new Error(`display.notify must be ${NOTIFY_MODES.join(', ')}, not ${mode}`);
  }
  return mode;
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
export function describeNotification({ monitor, media, rating, tags = [] }) {
  const details = [];
  if (media.kind !== 'image' && Number.isFinite(media.duration)) details.push(formatClock(media.duration));
  if (media.kind !== 'image' && media.fps) details.push(`${Math.round(media.fps * 100) / 100} fps`);
  details.push(ratingText(rating), monitor.name);
  const body = [details.join(' · ')];
  if (tags.length) body.push(tags.join(', '));
  return {
    summary: `#${media.id}  ${media.kind}  ${formatResolution(media.width, media.height)}`,
    body: escapeMarkup(body.join('\n'))
  };
}

// Sends a desktop notification for what a monitor now plays. Each monitor replaces its previous
// notification where the server supports it (replace id, dunst stack tag). Failures are only logged:
// a missing notify-send or notification server must not fail the command or the daemon.
export async function notifyPlaying(database, { monitor, media, rating }, { logger } = {}) {
  if (!media) return;
  const key = `notify_id:${monitor.name}`;
  const { summary, body } = describeNotification({
    monitor, media, rating, tags: database.getTags(media.id)
  });
  const previous = database.getSetting(key);
  const args = [
    '--print-id', '--app-name=backdrop', '--urgency=low',
    `--hint=string:x-dunst-stack-tag:backdrop-${monitor.name}`,
    `--icon=${media.kind === 'image' ? media.path : 'video-x-generic'}`,
    ...(previous ? [`--replace-id=${previous}`] : []),
    summary, body
  ];
  try {
    const id = Number.parseInt(await settings.exec('notify-send', args), 10);
    if (Number.isInteger(id)) database.setSetting(key, id);
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
  if (mode === 'commands') await notifyPlaying(database, playing, { logger });
}
