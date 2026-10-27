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
import { out, fmt, ProgressBar, formatBytes } from '../utils/output.js';

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

  async download(options = {}) {
    const total = positiveInteger(options.total ?? 50, 'Total');
    const kinds = { both: ['image', 'video', 'gif'], images: ['image'], videos: ['video', 'gif'] };
    const kind = kinds[options.type ?? 'both'];
    if (!kind) throw new Error('Type must be images, videos or both');
    if (options.source) this.sources.get(options.source);
    const target = await targetResolution(this.config, options.resolution, this.monitors);
    const items = this.database.findMedia({ downloaded: false, status: 'new', kind, ...(options.source ? { source: options.source } : {}) });
    const summary = { downloaded: [], skipped: 0, failed: 0 };
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
          summary.downloaded.push(downloaded.id);
          out.success(`Downloaded ${fmt.bold(`#${media.id}`)}: ${downloaded.path}`);
          if (media.author || media.page_url) out.detail(`${media.author ?? media.source} ${media.page_url ?? ''}`.trim());
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
    out.print(`Downloaded ${summary.downloaded.length}, no suitable variant ${summary.skipped}, failed ${summary.failed}`);
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
      await fs.move(partial, file, { overwrite: false });
      moved = true;
      this.database.transaction(() => {
        const latest = this.database.getMedia(media.id);
        if (!latest || latest.path || latest.status !== 'new') throw new Error('Media changed during download');
        const duplicate = this.database.getMediaBySha256(sha256);
        if (duplicate) throw new Error(`Duplicate content of #${duplicate.id}`);
        this.database.updateMedia(media.id, { path: file, sha256, kind: info.kind,
          width: info.width, height: info.height, duration: info.duration, original_name: path.basename(file) });
      });
      return this.database.getMedia(media.id);
    } catch (error) {
      if (moved) await fs.unlink(file);
      throw error;
    } finally {
      await fs.remove(partial);
    }
  }
}
