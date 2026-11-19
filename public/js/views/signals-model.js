// Pure helpers of the Technical data view.
export const MAX_SIGNALS = 6;

// [{ unit, signals }] in order of first appearance; a missing unit groups under ''.
export function groupByUnit(signals) {
  const groups = new Map();
  for (const s of signals) {
    const unit = s.unit ?? '';
    if (!groups.has(unit)) groups.set(unit, []);
    groups.get(unit).push(s);
  }
  return [...groups].map(([unit, list]) => ({ unit, signals: list }));
}

// '1,2,3' -> ids that exist in `valid`, no duplicates, at most `max`.
export function parseIds(text, valid, max = MAX_SIGNALS) {
  const ok = new Set(valid);
  const ids = String(text ?? '').split(',').map((x) => (/^\d+$/.test(x) ? Number(x) : NaN)).filter((n) => ok.has(n));
  return [...new Set(ids)].slice(0, max);
}

// Toggle an id; adding past the cap is refused (the list comes back unchanged).
export const toggleId = (ids, id, max = MAX_SIGNALS) =>
  ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= max ? ids : [...ids, id];
