// Runs work(item) for up to `concurrency` items at once and yields { item, result } or { item, error }
// in input order, so callers can keep their side effects (database writes, output) sequential while
// the slow part (ffprobe, hashing) overlaps. No new work starts once shouldStop() returns true.
// Leaving the loop early lets work already started finish; its outcome is discarded.
export async function* inOrder(items, work, { concurrency = 4, shouldStop = () => false } = {}) {
  const limit = Math.max(1, Math.trunc(concurrency) || 1);
  const pending = [];
  let next = 0;
  const fill = () => {
    while (pending.length < limit && next < items.length && !shouldStop()) {
      const item = items[next++];
      pending.push(Promise.resolve()
        .then(() => work(item))
        .then(result => ({ item, result }), error => ({ item, error })));
    }
  };

  fill();
  while (pending.length) {
    const settled = await pending.shift();
    fill();
    yield settled;
  }
}
