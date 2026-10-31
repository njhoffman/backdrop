// The names in known nearest to text by edit distance, ignoring case; containment counts as closest.
// Used to suggest a saved query or a config key for a typo.
export function closestMatches(text, known, limit = 3) {
  const target = text.toLowerCase();
  return known
    .map(name => {
      const lower = name.toLowerCase();
      const distance = lower.includes(target) || target.includes(lower) ? 0 : editDistance(target, lower);
      return { name, distance };
    })
    .filter(({ name, distance }) => distance <= Math.max(2, Math.floor(Math.max(name.length, text.length) / 2)))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);
}

export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}
