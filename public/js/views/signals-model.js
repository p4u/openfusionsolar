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

// What the view shows before anything is chosen: the inverter's active power and the battery's state of charge,
// each from its own device. [{ dn, ids: [id] }] with only the ones this plant reports.
export function defaultPicks(devices) {
  const find = (type, re) => {
    const dev = (devices ?? []).find((d) => d.type === type && d.signals?.some((s) => re.test(s.name ?? '')));
    return dev ? { dn: dev.dn, ids: [dev.signals.find((s) => re.test(s.name ?? '')).id] } : null;
  };
  return [find('Inverter', /^active power$/i), find('Battery', /\bsoc\b/i)].filter(Boolean);
}

// Link to the phase powers of the meter (names ending in Pa, Pb, Pc), or null when there are none.
export function phaseLink(devices) {
  for (const d of devices ?? []) {
    const ids = (d.signals ?? []).filter((s) => /\bP[abc]$/.test(s.name ?? '') && (s.unit === 'W' || s.unit === 'kW')).map((s) => s.id);
    if (ids.length) return `#/signals?dn=${encodeURIComponent(d.dn)}&ids=${ids.join(',')}`;
  }
  return null;
}
