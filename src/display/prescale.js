// mpv sizes its GPU textures and render targets to the source image and keeps the largest it has needed,
// so one 7499x14998 photo pins about 5.7 GB of GPU memory for the rest of the session (on Intel that is
// system memory). Images far larger than the monitor are therefore scaled down on the CPU before upload,
// through a per-file vf that mpv drops again when the next file loads. Videos are never filtered: a vf
// would force hardware-decoded frames back to system memory.

// Prescale only when it would drop more than half of the image's pixels; a 4K image on a 1080p monitor
// (about 0.79 of its pixels kept) is left to mpv's own scaler
const MAX_KEPT = 0.5;

// The scale factor that brings the image's shorter side to the monitor's longer one, or null when the
// image should load as it is. Using the shorter and longer sides keeps the result at least the monitor's
// cover size whatever the image's EXIF rotation, which the stored (rotation-corrected) size has applied
// and the decoded frame the filter sees has not.
export function prescaleFactor(media, monitor) {
  if (media?.kind !== 'image') return null;
  const { width, height } = media;
  if (!(width > 0 && height > 0 && monitor?.width > 0 && monitor?.height > 0)) return null;
  const factor = Math.max(monitor.width, monitor.height) / Math.min(width, height);
  return factor * factor < MAX_KEPT ? factor : null;
}

// The vf for an item, or null. The factor is rounded up and the sizes to even numbers upward, so the
// result never falls short of the cover size and panscan never scales it up again.
export function prescaleFilter(media, monitor) {
  const factor = prescaleFactor(media, monitor);
  if (factor === null) return null;
  const f = Math.ceil(factor * 10000) / 10000;
  return `scale=w=ceil(iw*${f}/2)*2:h=ceil(ih*${f}/2)*2:flags=lanczos`;
}

// loadfile for one item, with the item's prescale as a per-file option when it needs one.
// flags is mpv's loadfile flag (replace, append, append-play).
export function loadMedia(client, item, flags, monitor) {
  const filter = prescaleFilter(item, monitor);
  return filter
    ? client.command('loadfile', item.path, flags, -1, `vf=${filter}`)
    : client.command('loadfile', item.path, flags);
}
