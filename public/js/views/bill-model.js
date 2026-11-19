// Pure helpers of the Bill view (no DOM).

// One table row per month bucket of /api/energy. Without prices every bucket has money null and the row
// carries kWh only (money: null); the view then never shows a euro figure.
export function monthRows(buckets) {
  return buckets.map((b) => ({
    key: b.key,
    days: b.days,
    daysExpected: b.daysExpected,
    coverage: b.coverage,
    provisional: Boolean(b.provisional),
    pv: b.pv_kwh,
    load: b.load_kwh,
    bought: b.import_kwh,
    sold: b.export_kwh,
    byPeriod: [b.import_p1, b.import_p2, b.import_p3],
    money: b.money
      ? { energy: b.money.energy, fixed: b.money.fixed, bill: b.money.bill, savings: b.money.savings, exportIncome: b.money.exportIncome, withoutSolar: b.money.withoutSolar }
      : null,
  }));
}

// days: [{ day, peak }] (peak = highest import in kW that day, null without readings).
// A day is over when its peak exceeds the contracted power (unknown or zero contracted power flags nothing).
export function peakVsContracted(days, kw) {
  const limit = kw > 0 ? kw : null;
  const rows = days.map((d) => ({ day: d.day, peak: d.peak, over: limit != null && d.peak != null && d.peak > limit }));
  return {
    rows,
    contracted: limit,
    overCount: rows.filter((r) => r.over).length,
    max: rows.reduce((m, r) => (r.peak != null && r.peak > m ? r.peak : m), 0),
  };
}

// Meter phases from the /api/signals device list: { dn, signals: [{ id, phase, scale }] } or null.
// Only signals with unit W or kW whose name ends in Pa, Pb or Pc, all from the first device that has any.
export function phaseSignals(devices) {
  for (const dev of devices ?? []) {
    const found = [];
    for (const s of dev.signals ?? []) {
      const m = /\bP([abc])$/.exec(s.name ?? '');
      if (m && (s.unit === 'W' || s.unit === 'kW')) found.push({ id: s.id, phase: `P${m[1]}`, scale: s.unit === 'W' ? 0.001 : 1 });
    }
    if (found.length) return { dn: dev.dn, signals: found.sort((a, b) => a.phase.localeCompare(b.phase)) };
  }
  return null;
}

// The totals row of the month table: sums per column; a column with no known value stays null.
export function monthTotals(rows) {
  const add = (vals) => (vals.some((v) => v != null) ? vals.reduce((a, v) => a + (v ?? 0), 0) : null);
  const money = rows.some((r) => r.money)
    ? Object.fromEntries(['energy', 'fixed', 'bill', 'savings'].map((k) => [k, add(rows.map((r) => r.money?.[k]))]))
    : null;
  return { bought: add(rows.map((r) => r.bought)), sold: add(rows.map((r) => r.sold)), byPeriod: [0, 1, 2].map((i) => add(rows.map((r) => r.byPeriod[i]))), money };
}

// A real bill amount as typed: "61,23", "61.23", "1.234,56", "61 €"; empty clears it.
// { value: number | null } or { error: 'negative' | 'format' | 'range' }. The server checks the same rules again.
export function parseAmount(text) {
  const s = String(text ?? '').replace(/[\s €]/g, '');
  if (s === '') return { value: null };
  if (s.startsWith('-')) return { error: 'negative' };
  // a comma followed by 1 or 2 digits at the end is the decimal mark; other dots and commas group thousands
  const norm = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return { error: 'format' };
  const value = Number(norm);
  return value > 1e6 ? { error: 'range' } : { value };
}

// The real-bill cells of the totals row: the sum of the real amounts typed so far, the real-minus-estimate over the
// months that have both, and n (months with a real amount) of m (months shown). Null sums when there is nothing to add.
export function realTotals(rows, bills) {
  const round = (v) => Math.round(v * 100) / 100;
  const withReal = rows.filter((r) => bills?.[r.key] != null);
  const both = withReal.filter((r) => r.money?.bill != null);
  return {
    real: withReal.length ? round(withReal.reduce((a, r) => a + bills[r.key], 0)) : null,
    delta: both.length ? round(both.reduce((a, r) => a + bills[r.key] - r.money.bill, 0)) : null,
    n: withReal.length,
    m: rows.length,
  };
}

// Real bill minus the estimate, in euros; null when either is unknown.
export const billDelta = (real, estimate) => (real == null || estimate == null ? null : Math.round((real - estimate) * 100) / 100);

// The P1/P2/P3 kWh as whole numbers that add up to the whole kWh bought (largest remainder), so the cells never
// disagree with the total. Unknown parts stay null; parts that do not account for the total (off by 1 kWh or more) are only rounded.
export function periodParts(parts, bought) {
  const known = parts.filter((v) => v != null);
  const sum = known.reduce((a, v) => a + v, 0);
  if (bought == null || known.length !== parts.length || Math.abs(sum - bought) >= 1) return parts.map((v) => (v == null ? null : Math.round(v)));
  const out = parts.map(Math.floor);
  const order = parts.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  const extra = Math.round(bought) - out.reduce((a, v) => a + v, 0);
  for (let k = 0; k < extra && k < order.length; k++) out[order[k][1]] += 1;
  return out;
}

// Confirmed bills by the month holding most of their days: { 'YYYY-MM': { id, total } }. A bill without a total is left out
// (nothing to show), and when two bills fall in one month the later one wins.
export function confirmedMonths(invoices) {
  const out = {};
  for (const inv of [...(invoices ?? [])].sort((a, b) => (a.period.from < b.period.from ? -1 : 1))) {
    if (inv.total != null) out[inv.month] = { id: inv.id, total: inv.total };
  }
  return out;
}

// What the "real bill" cell of a month holds: a link to the confirmed bill, or the typed amount in an input.
export const realCellModel = (month, linked, bills) =>
  linked?.[month] ? { kind: 'link', id: linked[month].id, total: linked[month].total } : { kind: 'input', value: bills?.[month] ?? null };
