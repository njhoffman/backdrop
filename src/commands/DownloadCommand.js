import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { SourceRegistry } from '../sources/SourceRegistry.js';
import { DisplayControl } from '../display/DisplayControl.js';
import { hashFile } from '../library/Importer.js';
import { probeMedia } from '../library/probe.js';
import { targetResolution, positiveInteger, selectVariant, fits } from '../library/quality.js';
import { out, fmt, icon, mark, ProgressBar, formatBytes, formatDuration, formatResolution, formatQueries, displayPath } from '../utils/output.js';
import { printMedia } from '../utils/mediaView.js';
import { matchFilters, hasMatchFilters } from '../library/match.js';

const KINDS = { both: ['image', 'video', 'gif'], images: ['image'], videos: ['video', 'gif'] };
const EXTENSIONS = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

export class DownloadCommand {
  constructor(config, database, logger, { sources, control, monitors, probe = probeMedia, transfer } = {}) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.sources = sources ?? new SourceRegistry(config);
    this.control = control ?? new DisplayControl({ config, database });
    this.monitors = monitors;
    this.probe = probe;
    this.transfer = transfer ?? this.downloadFile.bind(this);
  }

  // onBytes(received, total) reports transfer progress; total is null without a Content-Length
  async downloadFile(url, file, onBytes = () => {}) {
    const response = await axios.get(url, { responseType: 'stream', timeout: 30000 });
    const total = Number(response.headers?.['content-length']) || null;
    let received = 0;
    response.data.on('data', chunk => {
      received += chunk.length;
      onBytes(received, total);
    });
    await pipeline(response.data, fs.createWriteStream(file, { flags: 'wx' }));
  }

  async filters(options, { requireTarget = true } = {}) {
    const total = positiveInteger(options.total ?? 50, 'Total');
    const kind = KINDS[options.type ?? 'both'];
    if (!kind) throw new Error('Type must be images, videos or both');
    if (options.source) this.sources.get(options.source);
    let target = null;
    try {
      target = await targetResolution(this.config, options.resolution, this.monitors);
    } catch (error) {
      if (requireTarget || options.resolution !== undefined) throw error;
    }
    return { total, kind, target, match: matchFilters(this.database, options) };
  }

  // match holds the --query, --tag and --keywords filters
  pendingItems(kind, source, match = {}) {
    return this.database.findMedia({ downloaded: false, status: 'new', kind, ...(source ? { source } : {}), ...match });
  }

  // Lists media saved by searches and not yet downloaded, offline: the variant shown is chosen from
  // the variants stored at search time (sources that store none pick one at download time)
  async pending(options = {}) {
    const { kind, target, match } = await this.filters(options, { requireTarget: false });
    const items = this.pendingItems(kind, options.source, match);
    const shown = options.number === undefined ? items : items.slice(0, positiveInteger(options.number, 'Number'));
    const byQuery = new Map();
    let unsuitable = 0;
    for (const media of shown) {
      const extra = [];
      if (target && media.variants?.length) {
        const variant = selectVariant(media.variants, target, this.config);
        if (variant) extra.push(`${fmt.dim(`${icon('download')}`)}${formatResolution(variant.width, variant.height)} ${fmt.dim(variant.mime ?? '')}`.trim());
        else { unsuitable++; extra.push(fmt.yellow('no suitable variant')); }
      }
      printMedia(this.database, media, { extra });
      for (const query of this.database.getQueries(media.id)) byQuery.set(query, (byQuery.get(query) ?? 0) + 1);
    }
    if (!items.length) {
      out.info(hasMatchFilters(match) ? 'Nothing pending matches the filters'
        : 'Nothing pending; add some with `backdrop search-images` or `backdrop search-videos`');
      return { items: [], byQuery };
    }
    out.print();
    if (byQuery.size) {
      out.heading(`${icon('query')}By query`);
      const width = Math.max(...[...byQuery.keys()].map(query => query.length + 2));
      for (const [query, count] of [...byQuery].sort((a, b) => b[1] - a[1])) out.print(`  ${`"${query}"`.padEnd(width)}  ${count}`);
    }
    const counts = Object.entries(Object.groupBy(items, media => media.kind)).map(([name, list]) => `${list.length} ${name}s`);
    const partial = shown.length < items.length ? ` (showing ${shown.length})` : '';
    out.print(`${mark('info')}${fmt.bold(items.length)} pending: ${counts.join(', ')}${partial}`
      + (target ? fmt.dim(`  target ${formatResolution(target.width, target.height)}`) : '')
      + (unsuitable ? fmt.yellow(`, ${unsuitable} without a suitable variant`) : ''));
    if (!target) out.detail('Monitor size unknown; pass --resolution WIDTHxHEIGHT to see the variant each item would download');
    return { items: shown, byQuery };
  }

  async download(options = {}) {
    if (options.upgrade) return this.upgrade(options);
    const { total, kind, target, match } = await this.filters(options);
    const items = this.pendingItems(kind, options.source, match);
    const summary = { downloaded: [], duplicates: [], skipped: 0, failed: 0, bytes: 0 };
    const started = Date.now();
    const bar = new ProgressBar({ label: 'Downloading', total: Math.min(total, items.length) });
    try {
      for (const media of items) {
        if (summary.downloaded.length >= total) break;
        try {
          const source = this.sources.get(media.source);
          const variant = selectVariant(await source.downloadVariants(media), target, this.config);
          if (!variant) { summary.skipped++; continue; }
          bar.setDetail(`#${media.id}`);
          const downloaded = await this.downloadItem(media, variant, target, (received, size) => {
            bar.setDetail(`#${media.id} ${formatBytes(received)}${size ? ` / ${formatBytes(size)}` : ''}`);
          });
          if (downloaded.duplicate_of) {
            summary.duplicates.push(media.id);
            const queries = this.database.getQueries(downloaded.duplicate_of);
            out.print(`${mark('warn')}${fmt.bold(`#${media.id}`)}  ${fmt.yellow(`${icon('duplicate')}duplicate of #${downloaded.duplicate_of}`)}`
              + fmt.dim(queries.length ? `; its queries are now ${formatQueries(queries)}` : ''));
            continue;
          }
          const bytes = (await fs.stat(downloaded.path)).size;
          summary.bytes += bytes;
          summary.downloaded.push(downloaded.id);
          printMedia(this.database, downloaded, { tone: 'success', extra: [fmt.dim(formatBytes(bytes))] });
          bar.update(summary.downloaded.length, '');
        } catch (error) {
          summary.failed++;
          this.logger.error('Download failed', { mediaId: media.id, error: error.message });
          out.error(`#${media.id}: ${error.message}`);
        }
      }
    } finally {
      bar.stop();
    }
    try {
      await this.control.appendMedia(summary.downloaded);
    } catch (error) {
      this.logger.warn('Downloads saved but playlist update failed', { error: error.message });
      out.warn(`Downloads saved; playlist update failed: ${error.message}`);
    }
    const remaining = this.pendingItems(kind, options.source, match).length;
    const overall = hasMatchFilters(match) ? fmt.dim(` (${this.pendingItems(kind, options.source).length} overall)`) : '';
    const elapsed = (Date.now() - started) / 1000;
    const parts = [
      `${fmt.bold(`Downloaded ${summary.downloaded.length}`)} ${fmt.dim(`(${formatBytes(summary.bytes)} in ${formatDuration(elapsed)})`)}`,
      `duplicates ${summary.duplicates.length}`,
      `no suitable variant ${summary.skipped}`,
      summary.failed ? fmt.red(`failed ${summary.failed}`) : 'failed 0',
      `pending ${remaining}${overall}`
    ];
    out.print(`${mark(summary.failed ? 'warn' : 'success')}${parts.join(fmt.dim('  ·  '))}`);
    if (summary.failed) process.exitCode = 1;
    return summary;
  }

  async downloadItem(media, variant, target, onBytes) {
    const extension = EXTENSIONS[variant.mime];
    if (!extension) throw new Error(`Unsupported download format: ${variant.mime}`);
    const directory = this.config.get().paths.inbox;
    await fs.ensureDir(directory);
    const file = path.join(directory, `remote-${media.id}${extension}`);
    const partial = `${file}.${randomUUID()}.partial`;
    let moved = false;
    try {
      await this.transfer(variant.url, partial, onBytes);
      const info = await this.probe(partial);
      if (!info || !fits(info, target, this.config)) throw new Error('Downloaded file does not meet the required dimensions');
      const sha256 = await hashFile(partial);
      const duplicate = this.database.getMediaBySha256(sha256);
      if (duplicate) {
        this.database.markDuplicate(media.id, duplicate.id);
        return this.database.getMedia(media.id);
      }
      await fs.move(partial, file, { overwrite: false });
      moved = true;
      this.database.transaction(() => {
        const latest = this.database.getMedia(media.id);
        if (!latest || latest.path || latest.status !== 'new') throw new Error('Media changed during download');
        const duplicate = this.database.getMediaBySha256(sha256);
        if (duplicate) throw new Error(`Duplicate content of #${duplicate.id}`);
        this.database.updateMedia(media.id, { path: file, sha256, kind: info.kind,
          width: info.width, height: info.height, duration: info.duration, fps: info.fps ?? null, original_name: path.basename(file) });
      });
      return this.database.getMedia(media.id);
    } catch (error) {
      if (moved) await fs.unlink(file);
      throw error;
    } finally {
      await fs.remove(partial);
    }
  }

  // Replaces downloaded remote media that is smaller than the current target (e.g. after attaching
  // a larger monitor) with a larger stored variant. Ratings, speed, dim and history stay with the item.
  async upgrade(options = {}) {
    const { total, kind, target, match } = await this.filters(options);
    const items = this.database.findMedia({
      downloaded: true, status: ['new', 'kept'], kind, excludeLocal: true, ...(options.source ? { source: options.source } : {}), ...match
    }).filter(media => !fits(media, target, this.config));
    const summary = { upgraded: [], skipped: 0, failed: 0 };
    const bar = new ProgressBar({ label: 'Upgrading', total: Math.min(total, items.length) });
    try {
      for (const media of items) {
        if (summary.upgraded.length >= total) break;
        try {
          const source = this.sources.get(media.source);
          const variant = selectVariant(await source.downloadVariants(media), target, this.config);
          if (!variant || variant.width * variant.height <= media.width * media.height) { summary.skipped++; continue; }
          const upgraded = await this.upgradeItem(media, variant, target, (received, size) => {
            bar.setDetail(`#${media.id} ${formatBytes(received)}${size ? ` / ${formatBytes(size)}` : ''}`);
          });
          summary.upgraded.push(upgraded.id);
          out.success(`Upgraded ${fmt.bold(`#${media.id}`)}: ${formatResolution(media.width, media.height)} -> `
            + `${formatResolution(upgraded.width, upgraded.height)} ${fmt.dim(displayPath(upgraded.path))}`);
          bar.update(summary.upgraded.length, '');
          try {
            await this.control.refreshMedia(media);
            await this.control.appendMedia([media.id]);
          } catch (error) {
            out.warn(`#${media.id} upgraded; playlist update failed: ${error.message}`);
          }
        } catch (error) {
          summary.failed++;
          this.logger.error('Upgrade failed', { mediaId: media.id, error: error.message });
          out.error(`#${media.id}: ${error.message}`);
        }
      }
    } finally {
      bar.stop();
    }
    out.print(`Upgraded ${summary.upgraded.length}, no larger variant ${summary.skipped}, failed ${summary.failed}`);
    if (summary.failed) process.exitCode = 1;
    return summary;
  }

  // The old file is set aside until the database update commits, so a failure leaves the item as it was
  async upgradeItem(media, variant, target, onBytes) {
    const extension = EXTENSIONS[variant.mime];
    if (!extension) throw new Error(`Unsupported download format: ${variant.mime}`);
    const { dir, name } = path.parse(media.path);
    const file = path.join(dir, `${name}${extension}`);
    const partial = `${media.path}.${randomUUID()}.partial`;
    const backup = `${media.path}.${randomUUID()}.previous`;
    let state = 'downloading';
    try {
      await this.transfer(variant.url, partial, onBytes);
      const info = await this.probe(partial);
      if (!info || !fits(info, target, this.config)) throw new Error('Downloaded file does not meet the required dimensions');
      const sha256 = await hashFile(partial);
      const duplicate = this.database.getMediaBySha256(sha256);
      if (duplicate && duplicate.id !== media.id) throw new Error(`Duplicate content of #${duplicate.id}`);
      if (file !== media.path && await fs.pathExists(file)) throw new Error(`${file} already exists`);
      await fs.move(media.path, backup);
      state = 'set-aside';
      await fs.move(partial, file);
      state = 'replaced';
      this.database.transaction(() => {
        const latest = this.database.getMedia(media.id);
        if (!latest || latest.path !== media.path) throw new Error('Media changed during upgrade');
        this.database.updateMedia(media.id, { path: file, sha256, kind: info.kind,
          width: info.width, height: info.height, duration: info.duration, fps: info.fps ?? null });
        if (file !== media.path) this.database.renameRatingPaths(media.id, path.basename(media.path), path.basename(file));
      });
      state = 'committed';
      await fs.remove(backup).catch(error => this.logger.warn('Could not remove replaced file', { path: backup, error: error.message }));
      return this.database.getMedia(media.id);
    } catch (error) {
      if (state === 'replaced') await fs.remove(file);
      if (state === 'set-aside' || state === 'replaced') await fs.move(backup, media.path);
      throw error;
    } finally {
      await fs.remove(partial);
    }
  }
}
