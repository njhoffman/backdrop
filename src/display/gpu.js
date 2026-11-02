import fs from 'fs-extra';

const UNITS = { '': 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

// The DRM client id and its memory from the text of one /proc/<pid>/fdinfo entry, or null for a file
// descriptor that is not a DRM client. drm-total-<region> is what the client holds in each region
// (system0 on Intel, where GPU buffers live in system memory; vram0 and gtt elsewhere).
export function parseDrmFdinfo(text) {
  const client = /^drm-client-id:\s*(\d+)/m.exec(text);
  if (!client) return null;
  let bytes = 0;
  for (const [, value, unit] of text.matchAll(/^drm-total-[\w-]+:\s*(\d+)\s*(\w*)/gm)) {
    bytes += Number(value) * (UNITS[unit] ?? 1);
  }
  return { client: client[1], bytes };
}

// Bytes of GPU memory a process holds, summed over its DRM clients (several file descriptors can share
// one client and report it once each), or null when it has none or /proc cannot be read
export async function readGpuMemory(pid, {
  readDir = dir => fs.readdir(dir), readFile = file => fs.readFile(file, 'utf8')
} = {}) {
  const dir = `/proc/${pid}/fdinfo`;
  let names;
  try {
    names = await readDir(dir);
  } catch {
    return null;
  }
  const clients = new Map();
  for (const name of names) {
    // A descriptor closed since the listing is skipped
    const entry = parseDrmFdinfo(await readFile(`${dir}/${name}`).catch(() => ''));
    if (entry) clients.set(entry.client, entry.bytes);
  }
  return clients.size ? [...clients.values()].reduce((sum, bytes) => sum + bytes, 0) : null;
}
