import path from 'path';

// Where a tag came from: the imported file's name, the source page's URL slug, or the source's description
export const TAG_ORIGINS = ['filename', 'page', 'description'];

// Words that say nothing about the picture: grammar, file and camera naming, stock-site boilerplate
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'its', 'of', 'on',
  'or', 'over', 'the', 'their', 'this', 'that', 'to', 'under', 'with', 'while', 'near', 'during', 'very',
  'some', 'two', 'three', 'four', 'top', 'view', 'shot', 'close', 'closeup', 'background', 'scene',
  'through', 'across', 'along', 'around', 'between', 'among', 'amid', 'amidst', 'above', 'below', 'beneath',
  'behind', 'beside', 'against', 'within', 'toward', 'towards', 'surrounded', 'showcasing', 'featuring',
  'highlighting', 'depicting', 'capturing', 'captured', 'creating', 'showing', 'offering', 'overlooking',
  'video', 'videos', 'photo', 'photos', 'image', 'images', 'img', 'pic', 'picture', 'clip', 'footage', 'stock',
  'free', 'download', 'wallpaper', 'wallpapers', 'loop', 'loops', 'copy', 'final', 'edit', 'edited', 'export',
  'mov', 'mp4', 'mkv', 'webm', 'avi', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'raw',
  'uhd', 'fhd', 'qhd', 'hdr', 'sdr', 'hevc', 'avc', 'fps', 'hd', 'sd',
  'dsc', 'dji', 'gopro', 'pxl', 'pexels', 'unsplash', 'pixabay', 'local', 'remote'
]);

// Words in a file name, URL slug or description: split on punctuation and camelCase, lowercased.
// Words with digits (ids, resolutions, codecs, dates) and short or stop words are dropped.
export function parseTags(text) {
  if (!text) return [];
  const words = String(text)
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words.filter(word => word.length >= 3 && !/\d/.test(word) && !STOPWORDS.has(word)))];
}

// The last path segment of a page URL, e.g. https://www.pexels.com/video/aerial-view-of-waves-1234/
export function pageSlug(pageUrl) {
  try {
    return new URL(pageUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
  } catch {
    return '';
  }
}

// Tags for a media row as [{ tag, origin }], first origin wins. Local imports are named after their
// original file; remote downloads are named remote-<id>, so their page slug and description are used.
export function tagsFor(media) {
  const sources = [
    ['filename', media.source === 'local' && media.original_name ? path.parse(media.original_name).name : ''],
    ['page', media.page_url ? pageSlug(media.page_url) : ''],
    ['description', (media.tags ?? []).join(' ')]
  ];
  const seen = new Set();
  const result = [];
  for (const [origin, text] of sources) {
    for (const tag of parseTags(text)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      result.push({ tag, origin });
    }
  }
  return result;
}
