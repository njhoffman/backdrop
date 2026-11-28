// Picking the visualizer preset automatically (visualizer auto, `backdrop visualizer auto`): what is known of the
// moment (full screen or behind windows, timed lyrics or none, the album art or the wallpaper preferred, and what that
// image is like) matched against an ordered list of rules, the first that fits naming the preset. The user names rules
// as songs and wallpapers come up (2026-11-28); built-in ones are below, and visualizer.auto.rules in the config comes
// first.

// What an image is like, from its RGB pixels (3 bytes each): mean brightness (luma, 0 to 1), mean chroma (the brightest
// channel less the darkest, 0 to 1), and the shares of pixels with any color (chroma over COLORED) and with vivid color
// (over VIVID). Shares, not a mean, tell black and white: a black and white photo with one red band averages as
// colorless; and chroma, not HSL saturation, which rates a pale cream as colorful.
export const COLORED = 0.12;
export const VIVID = 0.3;
export function imageStats(pixels) {
  let luma = 0;
  let chroma = 0;
  let colored = 0;
  let vivid = 0;
  let count = 0;
  for (let at = 0; at + 2 < pixels.length; at += 3) {
    const r = pixels[at] / 255;
    const g = pixels[at + 1] / 255;
    const b = pixels[at + 2] / 255;
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    chroma += spread;
    if (spread > COLORED) colored++;
    if (spread > VIVID) vivid++;
    count++;
  }
  return count ? { brightness: luma / count, chroma: chroma / count, colored: colored / count, vivid: vivid / count } : null;
}

// Calibrated on covers seen on 2026-11-28 (pixels with chroma over 0.12): a desaturated photo (Indigo Road) 0.1%, a
// black and white photo with a red band (Cold War Kids) 7%, a white cover with a blue drawing (Channo) 10%, a beige one
// (Phoria) 86%. Black and white below 2% colored; colorful above 35% vivid.
export const GRAYSCALE_BELOW = 0.02;
export const COLORFUL_ABOVE = 0.35;
export const DARK_BELOW = 0.25;
export const BRIGHT_ABOVE = 0.6;

// The tags a rule's `image` can name: grayscale, colorful or muted (by color), and dark, bright or mid (by brightness);
// none for an image not known
export function imageTags(stats) {
  if (!stats) return [];
  const color = stats.colored < GRAYSCALE_BELOW ? 'grayscale' : stats.vivid > COLORFUL_ABOVE ? 'colorful' : 'muted';
  const light = stats.brightness < DARK_BELOW ? 'dark' : stats.brightness > BRIGHT_ABOVE ? 'bright' : 'mid';
  return [color, light];
}

export const VIEWS = ['fullscreen', 'background'];
export const PREFERENCES = ['cover', 'wallpaper'];
export const IMAGE_TAGS = ['grayscale', 'colorful', 'muted', 'dark', 'bright', 'mid'];

// The built-in rules, first match wins. Behind other windows never lyrics, and only the wallpaper with bars or a graph
// (2026-11-28); with lyrics a look that shows them, without one made for no lyrics.
export const AUTO_RULES = [
  { when: { view: 'background' }, preset: 'bars', reason: 'behind windows: the wallpaper with bars, never lyrics' },
  { when: { view: 'fullscreen', lyrics: true, prefer: 'cover', image: 'grayscale' }, preset: 'lyrics-sharp-duotone', reason: 'a black and white cover' },
  { when: { view: 'fullscreen', lyrics: true, prefer: 'cover' }, preset: 'lyrics-blurred-soft-tinted', reason: 'the cover, with lyrics' },
  { when: { view: 'fullscreen', lyrics: true, prefer: 'wallpaper' }, preset: 'lyrics-veil', reason: 'the wallpaper under a veil, with lyrics' },
  { when: { view: 'fullscreen', lyrics: false, prefer: 'wallpaper' }, preset: 'radials', reason: 'the wallpaper, no lyrics' },
  { when: { view: 'fullscreen', lyrics: false, prefer: 'cover' }, preset: 'cover-radials', reason: 'the cover, no lyrics' }
];

const RULE_KEYS = ['view', 'lyrics', 'prefer', 'image'];

// A rule's problem as a message, or null: config rules are checked like the rest of the visualizer section
export function ruleProblem(rule, presets) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'must be a mapping with when and preset';
  if (typeof rule.preset !== 'string' || !presets.includes(rule.preset)) return `preset must be one of the presets, not ${JSON.stringify(rule.preset)}`;
  const when = rule.when ?? {};
  if (typeof when !== 'object' || Array.isArray(when)) return 'when must be a mapping';
  for (const key of Object.keys(when)) if (!RULE_KEYS.includes(key)) return `when.${key} is not one of ${RULE_KEYS.join(', ')}`;
  if (when.view !== undefined && !VIEWS.includes(when.view)) return `when.view must be ${VIEWS.join(' or ')}`;
  if (when.prefer !== undefined && !PREFERENCES.includes(when.prefer)) return `when.prefer must be ${PREFERENCES.join(' or ')}`;
  if (when.lyrics !== undefined && typeof when.lyrics !== 'boolean') return 'when.lyrics must be true or false';
  const images = when.image === undefined ? [] : [when.image].flat();
  for (const tag of images) if (!IMAGE_TAGS.includes(tag)) return `when.image must be among ${IMAGE_TAGS.join(', ')}`;
  if (rule.reason !== undefined && typeof rule.reason !== 'string') return 'reason must be text';
  return null;
}

// Whether a rule fits the moment: { view, lyrics, prefer, image: tags of the preferred image }. Lyrics not known yet
// count as none, so a look with lyrics waits for them; every image tag a rule names must be the image's
export function ruleFits(rule, moment) {
  const when = rule.when ?? {};
  if (when.view !== undefined && when.view !== moment.view) return false;
  if (when.prefer !== undefined && when.prefer !== moment.prefer) return false;
  if (when.lyrics !== undefined && when.lyrics !== (moment.lyrics === true)) return false;
  if (when.image !== undefined && ![when.image].flat().every(tag => (moment.image ?? []).includes(tag))) return false;
  return true;
}

// The preset for the moment: { preset, reason } from the first rule that fits (the config's first, then the
// built-in ones), or null when none does
export function choosePreset(moment, rules = AUTO_RULES) {
  const rule = rules.find(item => ruleFits(item, moment));
  return rule ? { preset: rule.preset, reason: rule.reason ?? describeWhen(rule.when) } : null;
}

function describeWhen(when = {}) {
  const parts = [];
  if (when.view) parts.push(when.view === 'fullscreen' ? 'full screen' : 'behind windows');
  if (when.lyrics !== undefined) parts.push(when.lyrics ? 'lyrics' : 'no lyrics');
  if (when.prefer) parts.push(`the ${when.prefer === 'cover' ? 'cover' : 'wallpaper'} preferred`);
  if (when.image) parts.push([when.image].flat().join(' and '));
  return parts.join(', ') || 'always';
}
