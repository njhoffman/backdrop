import { DISPLAY_STATUSES, MODE_KINDS } from '../display/Playlist.js';
import { fmt, formatTable, out } from '../utils/output.js';
import { wantsJson } from '../utils/mediaView.js';

const DEFAULT_LIMIT = 50;
const KIND_CHOICES = { video: MODE_KINDS.video, image: MODE_KINDS.image };

// `backdrop tags [prefix]`: the tags of downloaded items with how many items carry each, most used first, for
// --tag in the lists, next and playlist. Counts the items that can play (new and kept) unless --all.
export class TagsCommand {
  constructor(config, database) {
    this.config = config;
    this.database = database;
  }

  run(prefix, options = {}) {
    const limit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit must be a whole number (0 for every tag), not ${options.limit}`);
    if (options.kind !== undefined && !KIND_CHOICES[options.kind]) throw new Error(`--kind must be video or image, not ${options.kind}`);
    const tags = this.database.getTagCounts(limit === 0 ? null : limit + 1, {
      prefix: prefix || undefined,
      kinds: options.kind ? KIND_CHOICES[options.kind] : undefined,
      statuses: options.all ? undefined : DISPLAY_STATUSES
    });
    const more = limit !== 0 && tags.length > limit;
    const shown = more ? tags.slice(0, limit) : tags;
    if (wantsJson(options)) {
      out.json({ tags: shown, more });
      return;
    }
    if (!shown.length) {
      out.print(fmt.yellow(prefix ? `No tag starts with "${prefix}"` : 'No tags yet; tags come from file names, page slugs and descriptions'));
      return;
    }
    for (const line of formatTable(shown.map(row => [row.count, row.tag]), { align: ['r', 'l'], indent: 0 })) out.print(line);
    if (more) out.detail(`First ${limit}; --limit 0 lists every tag`);
  }
}
