import { execFile } from 'child_process';

// Colors for a visualizer from the wallpaper under it (visualizer.palette.source: wallpaper). The daemon
// decodes one small sample of what a monitor shows on each load (sampleMedia); each instance then takes the
// strip under its window from it, finds its main colors and picks from them (paletteColors).

// Width of the decoded sample; the height follows the monitor's shape
const SAMPLE_WIDTH = 96;
const CLUSTERS = 6;
const ITERATIONS = 12;
// Main colors covering less of the strip than this are noise
const MIN_SHARE = 0.03;

// The part of a media item mpv shows on a monitor: with --panscan=1.0 it fills the monitor, centered,
// cropping what overflows. Media sizes are already rotation-corrected, as ffmpeg's frames are.
export function visibleRegion(media, monitor) {
  const scale = Math.max(monitor.width / media.width, monitor.height / media.height);
  const width = Math.min(media.width, Math.floor(monitor.width / scale));
  const height = Math.min(media.height, Math.floor(monitor.height / scale));
  return { x: Math.floor((media.width - width) / 2), y: Math.floor((media.height - height) / 2), width, height };
}

function decode(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

// What a monitor shows of a media item, as SAMPLE_WIDTH-wide RGB: { width, height, pixels, dim }. Videos
// are sampled a second in (or halfway through short clips), like their thumbnails.
export async function sampleMedia(media, monitor, { exec = decode } = {}) {
  const region = visibleRegion(media, monitor);
  const width = SAMPLE_WIDTH;
  const height = Math.max(1, Math.round(width * monitor.height / monitor.width));
  const seek = media.kind === 'image' ? [] : ['-ss', String(Math.min(1, (media.duration || 2) / 2))];
  const pixels = await exec('nice', [
    '-n', '19', 'ffmpeg', '-v', 'error', ...seek, '-i', media.path, '-frames:v', '1',
    '-vf', `crop=${region.width}:${region.height}:${region.x}:${region.y},scale=${width}:${height}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ]);
  if (pixels.length < width * height * 3) throw new Error(`ffmpeg returned ${pixels.length} bytes for a ${width}x${height} sample`);
  return { width, height, pixels, dim: media.dim ?? 0 };
}

// The sample's pixels under a window ({ x, y, width, height } in root coordinates) on monitor, as [r, g, b]
export function stripPixels(sample, monitor, geometry) {
  const scaleX = sample.width / monitor.width;
  const scaleY = sample.height / monitor.height;
  const x0 = Math.max(0, Math.floor((geometry.x - monitor.x) * scaleX));
  const y0 = Math.max(0, Math.floor((geometry.y - monitor.y) * scaleY));
  const x1 = Math.min(sample.width, Math.max(x0 + 1, Math.ceil((geometry.x - monitor.x + geometry.width) * scaleX)));
  const y1 = Math.min(sample.height, Math.max(y0 + 1, Math.ceil((geometry.y - monitor.y + geometry.height) * scaleY)));
  const pixels = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * sample.width + x) * 3;
      pixels.push([sample.pixels[offset], sample.pixels[offset + 1], sample.pixels[offset + 2]]);
    }
  }
  return pixels;
}

const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

// Starting centers, the same every time: the pixel of median brightness, then repeatedly the pixel farthest
// from every center so far, so distinct colors get their own center however small their share
function initialCenters(pixels, k) {
  const sorted = [...pixels].sort((a, b) => luma(a) - luma(b));
  const centers = [sorted[Math.floor(sorted.length / 2)]];
  const nearest = pixels.map(pixel => distance(pixel, centers[0]));
  while (centers.length < k) {
    let farthest = 0;
    for (let index = 1; index < pixels.length; index++) if (nearest[index] > nearest[farthest]) farthest = index;
    if (nearest[farthest] === 0) break;
    centers.push(pixels[farthest]);
    pixels.forEach((pixel, index) => { nearest[index] = Math.min(nearest[index], distance(pixel, pixels[farthest])); });
  }
  return centers;
}

// The main colors of pixels by k-means, largest share first: [{ color: [r, g, b], share }]
export function mainColors(pixels, k = CLUSTERS) {
  if (!pixels.length) return [];
  let centers = initialCenters(pixels, k);
  let assignment = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    assignment = pixels.map(pixel => {
      let best = 0;
      for (let index = 1; index < centers.length; index++) {
        if (distance(pixel, centers[index]) < distance(pixel, centers[best])) best = index;
      }
      return best;
    });
    const sums = centers.map(() => [0, 0, 0, 0]);
    pixels.forEach((pixel, index) => {
      const sum = sums[assignment[index]];
      sum[0] += pixel[0]; sum[1] += pixel[1]; sum[2] += pixel[2]; sum[3]++;
    });
    const next = sums.map((sum, index) => (sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] : centers[index]));
    const moved = next.some((center, index) => distance(center, centers[index]) > 0.25);
    centers = next;
    if (!moved) break;
  }
  const counts = centers.map(() => 0);
  for (const index of assignment) counts[index]++;
  return centers
    .map((center, index) => ({ color: center.map(Math.round), share: counts[index] / pixels.length }))
    .filter(cluster => cluster.share > 0)
    .sort((a, b) => b.share - a.share);
}

export function toHsl([r, g, b]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function fromHsl([h, s, l]) {
  if (s === 0) return [l, l, l].map(value => Math.round(value * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = t => {
    const u = ((t % 1) + 1) % 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const hue = h / 360;
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map(value => Math.round(value * 255));
}

// Piped colors ({ fg, fg2 } as #rrggbb or #rrggbbaa) with the hue turned by degrees, for palette.source: cycle.
// Saturation, lightness and alpha stay, so a gray (black included) stays as it is.
export function turnHue(colors, degrees) {
  return Object.fromEntries(Object.entries(colors).map(([name, value]) => {
    const rgb = [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16));
    const [h, s, l] = toHsl(rgb);
    const turned = fromHsl([(((h + degrees) % 360) + 360) % 360, s, l]);
    return [name, `#${turned.map(channel => channel.toString(16).padStart(2, '0')).join('')}${value.slice(7)}`];
  }));
}

// WCAG relative luminance and contrast ratio (1 to 21)
function relativeLuminance(color) {
  const [r, g, b] = color.map(value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

// color made lighter or darker, keeping its hue, until it has ratio against background: whichever direction
// needs the smaller change, unless that ends near black or white and the other does not (on a mid-tone strip
// the dark way out is near black, which reads as holes, not bars), or the extreme with the most contrast
// when neither gets there. Saturation is
// capped by how colorful the color is (its chroma), since a near-black's or near-grey's HSL saturation is
// noise: lifting a faint green tint must give a grey-green, not pure green.
export function ensureContrast(color, background, ratio) {
  if (contrastRatio(color, background) >= ratio) return color;
  const [h, saturation, l] = toHsl(color);
  const s = Math.min(saturation, chroma(color) / 128);
  const search = step => {
    for (let lightness = l + step; lightness >= 0 && lightness <= 1; lightness += step) {
      const candidate = fromHsl([h, s, lightness]);
      if (contrastRatio(candidate, background) >= ratio) return { candidate, change: Math.abs(lightness - l), extreme: lightness < 0.15 || lightness > 0.9 };
    }
    return null;
  };
  const found = [search(0.02), search(-0.02)].filter(Boolean).sort((a, b) => a.extreme - b.extreme || a.change - b.change)[0];
  if (found) return found.candidate;
  const extremes = [fromHsl([h, s, 1]), fromHsl([h, s, 0])];
  return extremes.sort((a, b) => contrastRatio(b, background) - contrastRatio(a, background))[0];
}

// count colors from the main colors by rule: dominant (largest share first), vivid (most colorful first,
// small specks discounted) or complement (the vivid picks with their hue turned halfway round). With fewer
// main colors than needed, the last pick is repeated lighter or darker.
export function pickColors(clusters, rule, count) {
  const usable = clusters.filter(cluster => cluster.share >= MIN_SHARE);
  const pool = usable.length ? usable : clusters;
  const ranked = rule === 'dominant'
    ? pool.map(cluster => cluster.color)
    : [...pool].sort((a, b) => chroma(b.color) * b.share ** 0.25 - chroma(a.color) * a.share ** 0.25).map(cluster => cluster.color);
  const picks = (rule === 'complement'
    ? ranked.map(color => {
      const [h, s, l] = toHsl(color);
      return fromHsl([(h + 180) % 360, s, l]);
    })
    : ranked).slice(0, count);
  while (picks.length < count) {
    const [h, s, l] = toHsl(picks.at(-1) ?? [128, 128, 128]);
    picks.push(fromHsl([h, s, l > 0.5 ? l - 0.25 : l + 0.25]));
  }
  return picks;
}

// The average color of pixels as shown, after mpv's contrast for the item's dim (0-100), which scales them
export function shownAverage(pixels, dim = 0) {
  const sum = [0, 0, 0];
  for (const pixel of pixels) for (let channel = 0; channel < 3; channel++) sum[channel] += pixel[channel];
  return sum.map(value => Math.round(value / Math.max(1, pixels.length) * (1 - dim / 100)));
}

const hex = color => `#${color.map(value => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')).join('')}`;

// A sleeve background of `auto`: its color and strength when nothing is known of the wallpaper yet
export const DEFAULT_VEIL = '#0a0f1a99';

// A sleeve background's veil strength: 1 for `auto`, the factor for `auto@0.5`, null for one that is not a veil
export function veilStrength(background) {
  if (background === 'auto') return 1;
  const strength = typeof background === 'string' ? /^auto@(\d*\.?\d+)$/.exec(background) : null;
  return strength ? Number(strength[1]) : null;
}

// A veil (#rrggbbaa) with its alpha times strength, the color as it was
export function scaleVeil(veil, strength = 1) {
  if (strength === 1) return veil;
  const alpha = Math.round(parseInt(veil.slice(7, 9), 16) * strength);
  return `${veil.slice(0, 7)}${Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, '0')}`;
}
// How far a picture's mean color must lean toward a hue (0-1) for a veil to take it; below this it is close enough
// to gray that its hue means nothing, and the veil keeps the default's navy
const VEIL_MIN_COLOR = 0.05;
// A tint's saturation and lightness, those of the default's navy: dark enough to read as the picture darkened
const VEIL_SATURATION = 0.44;
const VEIL_LIGHTNESS = 0.07;
// The luma (0-1) a veil aims to leave at the bright end of what it matters over, how far it may go to reach it,
// and what counts as the bright end: 10% of the pixels are brighter, so a small highlight does not darken everything.
// Set by white text's contrast over 125 wallpapers: no worse than 4.5:1, with dark pictures keeping most of their light.
const VEIL_TARGET_LUMA = 0.35;
const VEIL_MIN_ALPHA = 0.35;
const VEIL_MAX_ALPHA = 0.85;
const VEIL_BRIGHT_SHARE = 0.9;

// An RGB color (0-1) from a hue in radians and the veil's saturation and lightness
function veilTint(hue) {
  const chroma = (1 - Math.abs(2 * VEIL_LIGHTNESS - 1)) * VEIL_SATURATION;
  const sector = (((hue / (Math.PI / 3)) % 6) + 6) % 6;
  const side = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = [[chroma, side, 0], [side, chroma, 0], [0, chroma, side], [0, side, chroma], [side, 0, chroma], [chroma, 0, side]][Math.floor(sector)];
  return base.map(value => value + VEIL_LIGHTNESS - chroma / 2);
}

// A see-through background for pixels (as #rrggbbaa) that darkens them to about the same level whatever they are:
// the color is the picture's own hue, very dark, each pixel's hue counting by how colorful it is so that gray
// and white add nothing. The strength follows the bright end of area, the part text sits on (default all of them), as
// shown after dim (0-100), so a bright patch behind the lyrics counts however dark the rest is.
export function veilBackground(pixels, dim = 0, area = pixels) {
  if (!pixels.length) return DEFAULT_VEIL;
  let hueX = 0;
  let hueY = 0;
  for (const pixel of pixels) {
    const [red, green, blue] = pixel.map(value => value / 255);
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (!chroma) continue;
    // The hexagon hue as an angle: red at 0, green a third of the way round and blue two thirds
    const hue = Math.atan2(Math.sqrt(3) * (green - blue), 2 * red - green - blue);
    hueX += chroma * Math.cos(hue);
    hueY += chroma * Math.sin(hue);
  }
  const colored = Math.hypot(hueX, hueY) / pixels.length >= VEIL_MIN_COLOR;
  const tint = colored ? veilTint(Math.atan2(hueY, hueX)) : DEFAULT_VEIL.slice(1, 7).match(/../g).map(part => parseInt(part, 16) / 255);
  const lumas = (area.length ? area : pixels).map(pixel => luma(pixel) / 255).sort((a, b) => a - b);
  const shown = lumas[Math.min(lumas.length - 1, Math.floor(lumas.length * VEIL_BRIGHT_SHARE))] * (1 - dim / 100);
  const alpha = shown > VEIL_TARGET_LUMA ? (shown - VEIL_TARGET_LUMA) / (shown - luma(tint)) : 0;
  const clamped = Math.min(VEIL_MAX_ALPHA, Math.max(VEIL_MIN_ALPHA, alpha));
  return `${hex(tint.map(value => Math.round(value * 255)))}${hex([Math.round(clamped * 255)]).slice(1)}`;
}

// The pipe values for an instance ({ fg } or { fg, fg2 }, as #rrggbbaa) from the strip under its window,
// keeping the alpha of the configured colors; null when the strip is empty
export function paletteColors(sample, monitor, geometry, instance) {
  const pixels = stripPixels(sample, monitor, geometry);
  if (!pixels.length) return null;
  const { pick, minContrast } = instance.palette;
  const names = Object.keys(instance.pipe);
  const background = shownAverage(pixels, sample.dim);
  const picks = pickColors(mainColors(pixels), pick, names.length);
  return Object.fromEntries(names.map((name, index) => {
    const alpha = instance.pipe[name].slice(7, 9);
    return [name, `${hex(ensureContrast(picks[index], background, minContrast))}${alpha}`];
  }));
}
