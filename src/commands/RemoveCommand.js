import fs from 'fs-extra';
import { DisplayControl } from '../display/DisplayControl.js';

export class RemoveCommand {
  constructor(config, database, logger, { control } = {}) {
    this.database = database;
    this.logger = logger;
    this.control = control ?? new DisplayControl({ config, database });
  }

  async remove(id, options = {}) {
    if (id !== undefined && options.current) {
      throw new Error('Specify either a media id or --current, not both');
    }
    if (options.monitor && !options.current) {
      throw new Error('--monitor requires --current');
    }

    let media;
    if (options.current) {
      const current = await this.control.current(options.monitor);
      media = current.media;
      if (!media) {
        throw new Error(`Nothing from the library is playing on ${current.monitor.name}`);
      }
    } else {
      if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) {
        throw new Error('Specify a media id or --current (see `backdrop current` for the id)');
      }
      media = this.database.getMedia(Number(id));
      if (!media) {
        throw new Error(`Media ${id} not found`);
      }
    }

    // Remove all playlist references before unlinking, including on other monitors.
    await this.control.removeMedia(media);
    if (media.path) {
      try {
        await fs.unlink(media.path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    // Foreign keys retain imported_files with a null media_id and cascade ratings.
    this.database.deleteMedia(media.id);
    this.logger.info('Media removed', { mediaId: media.id, path: media.path });
    console.log(`Removed #${media.id}${media.path ? `: ${media.path}` : ''}`);
    return media;
  }
}
