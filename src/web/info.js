import fs from 'fs-extra';
import { webPath } from '../display/runtimeFiles.js';

// The running `backdrop web` as web.json records it, for the CLI: `backdrop web` (a second one points at the first),
// `--open` and `status`. A file whose process is gone (killed without its cleanup) counts as none.

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// { pid, port, token }, or null
export async function readWebInfo(runtimeDir, { alive = processAlive, self = process.pid } = {}) {
  const info = await fs.readJson(webPath(runtimeDir)).catch(() => null);
  return info && Number.isInteger(info.pid) && info.pid !== self && alive(info.pid) ? info : null;
}

// The address that opens the page: with the token, which the page swaps for a cookie, or without it for showing
export function webAddress(port, token) {
  return token ? `http://127.0.0.1:${port}/?token=${token}` : `http://127.0.0.1:${port}/`;
}
