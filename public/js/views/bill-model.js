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
