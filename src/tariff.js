// Spanish 2.0TD (Península) periods and a bill estimate.
// P1 punta, P2 llano, P3 valle. Weekends and national holidays are all P3.

// shortcut: fixed-date national holidays only (no Good Friday); add movable ones if bills disagree.
const HOLIDAYS = new Set(['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25']);

export function period(ts) {
  const d = new Date(ts);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dow = d.getDay();
  if (dow === 0 || dow === 6 || HOLIDAYS.has(md)) return 'p3';
  const h = d.getHours();
  if (h < 8) return 'p3';
  if ((h >= 10 && h < 14) || (h >= 18 && h < 22)) return 'p1';
  return 'p2';
}

const n = (v, d = 0) => (v == null || v === '' ? d : Number(v));

// null when energy prices are not configured.
export function pricesFromEnv(env) {
  if (!env.PRICE_P1 || !env.PRICE_P2 || !env.PRICE_P3) return null;
  return {
    p1: n(env.PRICE_P1), p2: n(env.PRICE_P2), p3: n(env.PRICE_P3),
    export: n(env.PRICE_EXPORT),
    adjust: n(env.PRICE_ADJUST), // per imported kWh, e.g. REE adjustment services
    powerP1: n(env.PRICE_POWER_P1), powerP2: n(env.PRICE_POWER_P2), // EUR per kW and year
    contractedP1: n(env.POWER_P1_KW), contractedP2: n(env.POWER_P2_KW),
    socialDay: n(env.PRICE_SOCIAL_BONUS_DAY), meterDay: n(env.PRICE_METER_DAY),
    iee: n(env.TAX_ELECTRICITY_PCT) / 100, vat: n(env.TAX_VAT_PCT) / 100,
  };
}

// One day of the bill, taxes included. `energy` can be negative on a day with more surplus than purchases;
// the bill caps the energy term at zero per billing period, which callers apply when summing a month.
export function dayMoney(day, p) {
  if (!p || (day.import_p1 == null && day.load_p1 == null)) return null;
  const byPeriod = (prefix) => ['p1', 'p2', 'p3'].reduce((s, k) => s + (day[`${prefix}_${k}`] ?? 0) * (p[k] + p.adjust), 0);
  const tax = (x) => x * (1 + p.iee) * (1 + p.vat);
  const bought = tax(byPeriod('import'));
  const exportIncome = tax((day.export_kwh ?? 0) * p.export);
  const withoutSolar = tax(byPeriod('load'));
  const fixed = (((p.powerP1 * p.contractedP1 + p.powerP2 * p.contractedP2) / 365 + p.socialDay) * (1 + p.iee) + p.meterDay) * (1 + p.vat);
  return { bought, exportIncome, energy: bought - exportIncome, withoutSolar, savings: withoutSolar - (bought - exportIncome), fixed };
}
