import { listMonitors, selectMonitors, missingMonitors } from '../display/Monitors.js';
import { out } from '../utils/output.js';
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
  const setting = config.get().display.monitors;
  const selected = selectMonitors(active, setting);
  const missing = missingMonitors(active, setting);
  if (!selected.length) {
    if (config.get().display.allow_upscale) return { width: 1, height: 1 };
    const reason = missing.length ? `configured monitors not active: ${missing.join(', ')}` : 'no active monitors';
    throw new Error(`Cannot determine monitor resolution (${reason}); use --resolution WIDTHxHEIGHT`);
  }
  if (missing.length) {
    out.warn(`Configured monitors not active: ${missing.join(', ')}; sizing for ${selected.map(m => m.name).join(', ')}`);
  }
  return { width: Math.max(...selected.map(m => m.width)), height: Math.max(...selected.map(m => m.height)) };
}

// Whether a video is shorter than library.min_duration (seconds, 0 for no minimum): searches do not save it and
// downloads skip it. A duration not known yet does not count as short; images never do.
export function tooShort(media, config) {
  const min = config.get().library.min_duration ?? 0;
  return Boolean(min > 0 && ['video', 'gif'].includes(media?.kind) && Number.isFinite(media.duration) && media.duration < min);
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
