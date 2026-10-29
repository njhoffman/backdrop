import fs from 'fs-extra';
import path from 'path';
import { probeMedia } from '../library/probe.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { out, fmt, ProgressBar, displayPath, formatClock, formatFps } from '../utils/output.js';

// Fields a probe can correct; fps alone never changes what a monitor may play
const PLAYBACK_FIELDS = ['kind', 'width', 'height'];

function describeField(field, value) {
  if (value === null || value === undefined) return '?';
  if (field === 'duration') return formatClock(value);
  if (field === 'fps') return formatFps(value);
  return String(value);
}

// Probes library files again with ffprobe. By default only videos and GIFs without a frame rate
// (added before it was recorded); --all re-checks every file's kind, size, duration and frame rate.
export class RescanCommand {
  constructor(config, database, logger, { probe = probeMedia, control } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.probe = probe;
    this.control = control ?? new DisplayControl({ config, database });
  }

  candidates(all) {
    const media = this.database.findMedia({ downloaded: true });
    return all ? media : media.filter(item => item.kind !== 'image' && !item.fps);
  }

  async rescan(options = {}) {
    const all = Boolean(options.all);
    const items = this.candidates(all);
    const summary = { scanned: 0, updated: [], missing: [], failed: [] };
    const bar = new ProgressBar({ label: 'Rescanning', total: items.length });
    const replaced = [];
    try {
      for (const media of items) {
        bar.update(summary.scanned, path.basename(media.path));
        summary.scanned++;
        if (!await fs.pathExists(media.path)) {
          summary.missing.push(media);
          out.warn(`#${media.id}: missing ${displayPath(media.path)}`);
          continue;
        }
        const info = await this.probe(media.path).catch(error => {
          this.logger.warn('Rescan probe failed', { mediaId: media.id, error: error.message });
          return null;
        });
        if (!info) {
          summary.failed.push(media);
          out.error(`#${media.id}: cannot probe ${displayPath(media.path)}`);
          continue;
        }
        const changes = this.changes(media, info, all);
        if (!Object.keys(changes).length) continue;
        this.database.updateMedia(media.id, changes);
        summary.updated.push(media.id);
        if (PLAYBACK_FIELDS.some(field => field in changes)) replaced.push(media);
        out.print(`${fmt.bold(`#${media.id}`)}  ${Object.entries(changes)
          .map(([field, value]) => `${field} ${fmt.dim(describeField(field, media[field]))} → ${fmt.cyan(describeField(field, value))}`)
          .join(', ')}`);
      }
      bar.update(summary.scanned);
    } finally {
      bar.stop();
    }

    // A new kind or size can change which mode or monitor an item belongs to
    try {
      for (const media of replaced) await this.control.refreshMedia(media);
      await this.control.appendMedia(replaced.map(media => media.id));
    } catch (error) {
      out.warn(`Rescan saved; playlist update failed: ${error.message}`);
    }

    const counts = [`Scanned ${summary.scanned}`, `updated ${summary.updated.length}`,
      `missing ${summary.missing.length}`, `failed ${summary.failed.length}`].join(', ');
    if (!items.length) out.info(all ? 'No downloaded media to rescan' : 'Every video already has a frame rate; use --all to re-check everything');
    else out.print(counts);
    if (summary.missing.length) out.detail('Missing files are left in the library; remove them with `backdrop remove <id>`');
    if (summary.failed.length) process.exitCode = 1;
    return summary;
  }

  // Probed values that differ from the stored ones. Without --all only a missing frame rate is filled.
  changes(media, info, all) {
    const changes = {};
    if (info.fps && info.fps !== media.fps) changes.fps = info.fps;
    if (!all) return changes;
    for (const field of [...PLAYBACK_FIELDS, 'duration']) {
      const value = info[field] ?? null;
      const stored = media[field] ?? null;
      const same = field === 'duration' && value !== null && stored !== null ? Math.abs(value - stored) < 0.5 : value === stored;
      if (!same) changes[field] = value;
    }
    if (info.kind === 'image' && media.fps) changes.fps = null;
    return changes;
  }
}
