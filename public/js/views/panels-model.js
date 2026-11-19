// Pure helpers of the Panels view.

export const kwhPerKwp = (kwh, kwp) => (kwh == null || !(kwp > 0) ? null : kwh / kwp);

// series: [[ms, kW | null]]; the highest reading and when it was; null when there is none.
export function peak(series) {
  let best = null;
  for (const [ts, v] of series) if (v != null && (best === null || v > best.kw)) best = { kw: v, ts };
  return best;
}

// Strings: voltage id 31001 + 3k with the current at id + 1, confirmed by the units V and A. Any count, unmatched ids ignored.
export function stringPairs(signals) {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const out = [];
  for (const s of [...signals].sort((a, b) => a.id - b.id)) {
    const k = (s.id - 31001) / 3;
    const amp = byId.get(s.id + 1);
    if (Number.isInteger(k) && k >= 0 && s.unit === 'V' && amp?.unit === 'A') out.push({ n: k + 1, voltage: s.id, current: amp.id });
  }
  return out;
}

export const stringPower = (v, a) => (v == null || a == null ? null : (v * a) / 1000);

// 12 rows for Jan to Dec; a month missing from either list stays null. Inputs are 1mo energy buckets { key: 'YYYY-MM', pv_kwh }.
export function yoyMonths(thisYear, lastYear) {
  const pick = (list) => {
    const m = new Map((list ?? []).map((b) => [Number(b.key.slice(5, 7)), b.pv_kwh ?? null]));
    return (n) => m.get(n) ?? null;
  };
  const [a, b] = [pick(thisYear), pick(lastYear)];
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, thisYear: a(i + 1), lastYear: b(i + 1) }));
}

// Hours the plant sat stopped inside [fromMs, toMs] (events of kind noProduction; an open one runs to `now`).
export function stoppedHours(events, fromMs, toMs, now) {
  const ms = events.filter((e) => e.kind === 'noProduction').reduce((sum, e) => {
    const end = Math.min(e.end ?? now, toMs);
    const start = Math.max(e.start, fromMs);
    return sum + Math.max(0, end - start);
  }, 0);
  return ms / 3600e3;
}
