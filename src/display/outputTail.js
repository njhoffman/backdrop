// The last lines a child process wrote to its pipes, kept in memory so a crash can say why without
// a log file growing on the runtime dir's tmpfs. Every chunk is read, so a chatty child never blocks on a full pipe.
export const TAIL_LINES = 20;

export function outputTail(streams, max = TAIL_LINES) {
  const kept = [];
  for (const stream of streams) {
    if (!stream) continue;
    let partial = '';
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop();
      for (const line of parts) {
        if (line.trim()) kept.push(line.trimEnd());
      }
      kept.splice(0, Math.max(0, kept.length - max));
    });
    stream.on('end', () => {
      if (partial.trim()) kept.push(partial.trimEnd());
      partial = '';
      kept.splice(0, Math.max(0, kept.length - max));
    });
    // A child killed mid-write can leave a broken pipe; nothing more to read then
    stream.on('error', () => {});
  }
  return { lines: () => [...kept] };
}
