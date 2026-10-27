import { listMonitors, selectMonitors } from '../display/Monitors.js';
import { meetsMinimum } from './probe.js';

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

export async function targetResolution(config, explicit, monitors = listMonitors) {
  if (explicit !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(explicit);
    if (!match) throw new Error('Resolution must be WIDTHxHEIGHT, e.g. 1920x1080');
    return { width: positiveInteger(match[1], 'Width'), height: positiveInteger(match[2], 'Height') };
  }
  let active;
  try { active = await monitors(); } catch { active = []; }
  const selected = selectMonitors(active, config.get().display.monitors);
  if (!selected.length) {
    if (config.get().display.allow_upscale) return { width: 1, height: 1 };
    throw new Error('Cannot determine monitor resolution; use --resolution WIDTHxHEIGHT');
  }
  return { width: Math.max(...selected.map(m => m.width)), height: Math.max(...selected.map(m => m.height)) };
}

export function fits(media, target, config) {
  const { library, display } = config.get();
  return meetsMinimum(media, library.min_width, library.min_height)
    && (display.allow_upscale || (media.width >= target.width && media.height >= target.height));
}

export function selectVariant(variants, target, config) {
  return variants.filter(variant => variant.url && fits(variant, target, config))
    .sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}
