import fs from 'fs-extra';

// /proc reports CPU time in USER_HZ ticks, which Linux fixes at 100 per second for user space
const TICKS_PER_SECOND = 100;
// Samples kept per monitor for its recent average; with the 30s health check about five minutes
export const RECENT_SAMPLES = 10;

// Seconds of CPU (user + system) a process has used, from the text of /proc/<pid>/stat.
// The command name is in parentheses and may contain spaces, so fields are counted after the last ')'.
export function parseProcStat(text) {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  // fields[0] is field 3 (state); utime and stime are fields 14 and 15
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) throw new Error('Unexpected /proc stat format');
  return (utime + stime) / TICKS_PER_SECOND;
}

export async function readCpuSeconds(pid, readFile = file => fs.readFile(file, 'utf8')) {
  return parseProcStat(await readFile(`/proc/${pid}/stat`));
}

// mpv reports 'no' (or nothing) when it decodes in software
export function isSoftwareDecoder(hwdec) {
  return !hwdec || hwdec === 'no';
}

// Software decoding is only worth a warning above 1080p, where it costs whole cores
export function isLargeVideo(media) {
  return (media.width ?? 0) * (media.height ?? 0) > 1920 * 1080;
}

// CPU use as a percentage of one core, like top
export function cpuPercent(cpuSeconds, seconds) {
  return seconds > 0 ? (cpuSeconds / seconds) * 100 : null;
}
