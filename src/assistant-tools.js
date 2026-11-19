// The assistant's tools: read-only views over the store, each validating its arguments like the HTTP routes and
// returning compact JSON with the numbers already computed (the model narrates, it does not calculate).
// Nothing here writes: no store method that saves or deletes, no files, no network.
import { batteryInfo } from './server.js';
import { billingSummary, compareInvoice } from './billing.js';
import { buildEvents } from './events.js';
import { periodMoney } from './tariff.js';
import { dayBounds, localDay } from './collector.js';
import * as aggregate from './aggregate.js';
import { checks, maskCups, isDate, missingMonths } from './invoice-schema.js';
import { spanDays, bucketCount, billMonth, legalEnergyBuckets, legalSeriesBuckets } from '../public/js/buckets.js';

// Same list as public/js/chart-presets.js (a test compares both files).
export const PRESET_TYPES = ['energy_bars', 'power_lines', 'battery_soc', 'import_by_period', 'bill_breakdown',
  'bill_real_vs_estimate', 'bill_kwh_vs_measured', 'price_per_kwh', 'savings'];
const POWER_TYPES = ['power_lines', 'battery_soc'];
const ENERGY_TYPES = ['energy_bars', 'import_by_period'];

const MAX_ENERGY_BUCKETS = 62;
const MAX_POWER_DAYS = 7;
const MAX_INCIDENTS = 50;
const MAX_EVENT_DAYS = 800;
const MAX_DAYS = 36600;

const DAY = { type: 'string', description: 'YYYY-MM-DD' };
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const RANGE = { from: { ...DAY, description: 'first day, YYYY-MM-DD' }, to: { ...DAY, description: 'last day (inclusive), YYYY-MM-DD' } };
const ID = { type: 'integer', description: 'bill id from list_invoices' };

export const TOOLS = [
  fn('get_plant', 'The installation: name, peak power, battery, contracted power, today, first day with data, whether prices are set.'),
  fn('get_energy', 'Measured energy (kWh) per day, month or year: solar, home use, bought, sold, self-use, bought per period P1-P3, coverage, and money at the configured prices. At most 62 buckets.',
    { ...RANGE, bucket: { type: 'string', enum: ['1d', '1mo', '1y'] } }, ['from', 'to', 'bucket']),
  fn('get_power', 'Measured power (kW) per hour over at most 7 days: means and maxima, plus the highest import and when.', RANGE, ['from', 'to']),
  fn('get_tariff', 'Configured electricity prices, the P1/P2/P3 timetable, fixed terms and tax rates.'),
  fn('estimate_bill', 'Estimated bill for a range from measured data and the configured prices: energy, fixed part, total, savings, surplus income.', RANGE, ['from', 'to']),
  fn('list_invoices', 'Confirmed bills (id, period, supplier, total, kWh, surplus), bills waiting for review and months without a bill.',
    { from: { ...DAY, description: 'optional first day' }, to: { ...DAY, description: 'optional last day' } }),
  fn('get_invoice', 'One bill with all its fields, lines and arithmetic checks.', { id: ID }, ['id']),
  fn('compare_invoice', 'One bill against what the installation measured over its exact days: billed vs measured kWh, real vs estimated euros, savings, verdict.', { id: ID }, ['id']),
  fn('get_billing_summary', 'Bills over a range: totals, breakdown (energy, fixed, taxes, other), per-bill comparison, missing months and the advice cards with their numbers.', RANGE, ['from', 'to']),
  fn('get_incidents', 'Power cuts, internet losses, low battery, overloads and stops over a range, newest first, at most 50.', RANGE, ['from', 'to']),
  fn('show_chart', 'Draws a chart in the chat from the app data. Types: energy_bars, import_by_period (bucket 1d/1mo/1y); power_lines, battery_soc (at most 7 days); bill_breakdown, bill_real_vs_estimate, bill_kwh_vs_measured, price_per_kwh, savings (bills in the range, or one bill with invoice_id).',
    { type: { type: 'string', enum: PRESET_TYPES }, ...RANGE, bucket: { type: 'string', enum: ['5m', '15m', '1h', '1d', '1mo', '1y'] }, invoice_id: ID },
    ['type', 'from', 'to']),
];

class ArgError extends Error {}
const fail = (reason) => { throw new ArgError(reason); };

function allow(args, allowed) {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) fail(`unknown argument ${k}`);
}

function range(args, maxDays) {
  const { from, to } = args;
  if (!isDate(from) || !isDate(to)) fail('from and to must be real days as YYYY-MM-DD');
  if (from > to) fail('from must not be after to');
  const n = spanDays(from, to);
  if (n > maxDays) fail(`the range is too long: at most ${maxDays} days`);
  return { from, to, n };
}

function invoiceOf(store, id) {
  if (!Number.isInteger(id) || id < 1) fail('id must be a whole number');
  return store.invoice(id) ?? fail(`there is no bill with id ${id}`);
}

const pad = (n) => String(n).padStart(2, '0');
const localTime = (ts) => {
  const d = new Date(ts);
  return `${localDay(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const month = (inv) => (isDate(inv.period_from) && isDate(inv.period_to) && inv.period_from <= inv.period_to
  ? billMonth(inv.period_from, inv.period_to) : null);

// Full CUPS, contract number, holder-side ids and bookkeeping columns never reach the model.
const HIDDEN = new Set(['cups', 'contract_number', 'supplier_tax_id', 'group_id', 'edits', 'created_at', 'updated_at']);

const cents = (v) => Math.round(v * 100) / 100;
const add = (inv, cols) => cents(cols.reduce((s, c) => s + (inv[c] ?? 0), 0));
// The bill's parts as Facturació shows them, so the model never adds amounts itself.
const breakdown = (inv) => ({
  energy: add(inv, ['energy_eur']), surplusDiscount: add(inv, ['surplus_eur']),
  fixed: add(inv, ['power_eur', 'social_bonus_eur', 'meter_rent_eur']), taxes: add(inv, ['elec_tax_eur', 'vat_eur']),
  other: add(inv, ['other_taxed_eur', 'other_exempt_eur']), total: inv.total_eur,
  howToRead: 'energy already includes adjust_eur (adjustment services); fixed = contracted power + social bonus + meter rent; taxes = electricity tax + VAT; energy - surplusDiscount + fixed + taxes + other = total',
});

export function invoiceForModel(store, inv, today = localDay(Date.now())) {
  const fields = Object.fromEntries(Object.entries(inv).filter(([k]) => !HIDDEN.has(k)));
  const readings = store.invoiceReadings(inv.id);
  return {
    ...fields, cups_masked: maskCups(inv.cups), month: month(inv), breakdown: breakdown(inv),
    lines: store.invoiceLines(inv.id).map((l) => pick(l, ['section', 'concept', 'period', 'quantity', 'unit', 'unit_price', 'amount_eur', 'info'])),
    readings: readings.map((r) => pick(r, ['kind', 'period', 'from_date', 'to_date', 'start_kwh', 'end_kwh', 'estimated'])),
    checks: checks(inv, { readings, today }).map((c) => ({ id: c.id, hard: c.hard, outcome: c.outcome })),
  };
}

const COMPARE_NOTE = 'Billed kWh are the supplier\'s hourly net balance; measured kWh come from the installation meter. verdict: ok (within 5 %), small (5-10 %), check (more), nodata (under 90 % of the days measured). estimateBill uses the bill\'s own prices, estimateEnv the configured ones.';

export function compareForModel(store, inv, prices) {
  return { id: inv.id, month: month(inv), period: { from: inv.period_from, to: inv.period_to }, ...compareInvoice(store, inv, { prices }), howToRead: COMPARE_NOTE };
}

const ENERGY_KEYS = ['key', 'from', 'to', 'pv_kwh', 'load_kwh', 'import_kwh', 'export_kwh', 'self_use_kwh', 'import_p1', 'import_p2', 'import_p3',
  'days', 'daysExpected', 'coverage', 'provisional'];
const moneyOf = (m) => m && pick(m, ['bill', 'energy', 'fixed', 'bought', 'exportIncome', 'withoutSolar', 'savings']);
const energyRow = (b) => ({ ...pick(b, ENERGY_KEYS), money: moneyOf(b.money) });

const TOOL_FNS = {
  get_plant(args, { store, config, now }) {
    allow(args, []);
    const station = store.getKv('station') ?? {};
    const b = batteryInfo(store, config.battery ?? {});
    const p = config.prices;
    return {
      name: config.plantName || station.name || null, peakKw: station.capacity ?? null,
      battery: { capacityKwh: b.capacityKwh, minPct: b.minPct, reservePct: b.reservePct },
      contractedKw: p ? { p1: p.contractedP1, p2: p.contractedP2 } : null,
      today: localDay(now()), firstDayWithData: store.firstDay(), pricesSet: Boolean(p),
    };
  },

  get_energy(args, { store, config, now }) {
    allow(args, ['from', 'to', 'bucket']);
    const { from, to } = range(args, MAX_DAYS);
    if (!['1d', '1mo', '1y'].includes(args.bucket)) fail('bucket must be 1d, 1mo or 1y');
    if (bucketCount(from, to, args.bucket) > MAX_ENERGY_BUCKETS) fail(`too many buckets: at most ${MAX_ENERGY_BUCKETS}, use a coarser bucket or a shorter range`);
    const e = aggregate.energy(store, { from, to, bucket: args.bucket, prices: config.prices, now: now() });
    return { bucket: e.bucket, pricesSet: Boolean(config.prices), buckets: e.buckets.map(energyRow), total: energyRow(e.total) };
  },

  get_power(args, { store, now }) {
    allow(args, ['from', 'to']);
    const { from, to } = range(args, MAX_POWER_DAYS);
    const s = aggregate.series(store, { from, to, bucket: '1h', now: now() });
    const cols = ['pv_kw', 'load_kw', 'imp_kw', 'exp_kw', 'soc', 'imp_kw_max'];
    const rows = s.t.map((t, j) => [localTime(t), ...cols.map((c) => s.series[c][j])]).filter((r) => r.slice(1).some((v) => v != null));
    let max = null;
    s.series.imp_kw_max.forEach((v, j) => { if (v != null && (!max || v > max.kw)) max = { kw: v, at: localTime(s.t[j]) }; });
    return { columns: ['hour', 'solar_kw', 'home_kw', 'import_kw', 'export_kw', 'battery_pct', 'import_kw_max'], rows, maxImport: max, note: 'hourly means of 5-minute readings; import_kw_max is the highest 5-minute reading of the hour' };
  },

  get_tariff(args, { config }) {
    allow(args, []);
    const p = config.prices;
    const timetable = 'Weekdays: P1 (punta) 10-14 and 18-22 h, P2 (pla) 8-10, 14-18 and 22-24 h, P3 (vall) 0-8 h. Weekends and national holidays: all P3.';
    if (!p) return { configured: false, timetable };
    return {
      configured: true, timetable,
      energyEurPerKwh: { p1: p.p1, p2: p.p2, p3: p.p3, adjust: p.adjust }, surplusEurPerKwh: p.export,
      powerEurPerKwYear: { p1: p.powerP1, p2: p.powerP2 }, contractedKw: { p1: p.contractedP1, p2: p.contractedP2 },
      socialBonusEurPerDay: p.socialDay, meterEurPerDay: p.meterDay, electricityTaxPct: p.iee * 100, vatPct: p.vat * 100,
    };
  },

  estimate_bill(args, { store, config }) {
    allow(args, ['from', 'to']);
    const { from, to, n } = range(args, MAX_DAYS);
    if (!config.prices) fail('prices are not configured, so there is no estimate');
    const rows = store.days(from, to);
    const m = periodMoney(rows, config.prices);
    if (!m) fail('there is no measured data in that range');
    return { from, to, days: n, daysWithData: rows.length, ...moneyOf(m), note: 'estimate at the configured prices, taxes included; the energy part is capped at zero per calendar month' };
  },

  list_invoices(args, { store, now }) {
    allow(args, ['from', 'to']);
    const { from = null, to = null } = args;
    if ((from != null && !isDate(from)) || (to != null && !isDate(to))) fail('from and to must be real days as YYYY-MM-DD');
    if (from && to && from > to) fail('from must not be after to');
    const live = (i) => !i.superseded_by;
    const confirmed = store.listInvoices({ status: 'confirmed', from, to }).filter(live);
    const sum = (inv, cols) => (cols.some((c) => inv[c] != null) ? cols.reduce((s, c) => s + (inv[c] ?? 0), 0) : null);
    const missing = missingMonths(store.listInvoices({ status: 'confirmed' }).filter(live), localDay(now()), store.measuredDays())
      .filter((m) => (!from || m >= from.slice(0, 7)) && (!to || m <= to.slice(0, 7)));
    return {
      invoices: confirmed.map((i) => ({
        id: i.id, month: month(i), period: { from: i.period_from, to: i.period_to }, supplier: i.supplier, kind: i.kind, total_eur: i.total_eur,
        kwh: sum(i, ['kwh_p1', 'kwh_p2', 'kwh_p3']), surplus_kwh: sum(i, ['surplus_p1_kwh', 'surplus_p2_kwh', 'surplus_p3_kwh']),
        status: i.status, auto_confirmed: Boolean(i.auto_confirmed), duplicate_of: i.duplicate_of,
      })),
      waitingForReview: store.listInvoices({ status: 'draft', from, to }).filter(live).map((i) => ({ id: i.id, month: month(i) })),
      missingMonths: missing,
    };
  },

  get_invoice(args, { store, now }) {
    allow(args, ['id']);
    return invoiceForModel(store, invoiceOf(store, args.id), localDay(now()));
  },

  compare_invoice(args, { store, config }) {
    allow(args, ['id']);
    return compareForModel(store, invoiceOf(store, args.id), config.prices ?? null);
  },

  get_billing_summary(args, { store, config, now }) {
    allow(args, ['from', 'to']);
    const { from, to } = range(args, MAX_DAYS);
    return billingSummary(store, { from, to, prices: config.prices ?? null, today: localDay(now()) });
  },

  get_incidents(args, { store, now }) {
    allow(args, ['from', 'to']);
    const { from, to } = range(args, MAX_EVENT_DAYS);
    const [a, b] = [dayBounds(from)[0], dayBounds(to)[1]];
    const events = buildEvents(store.alarms(a, b), store.samples(a, b), now(), { from: a, to: b, since: store.firstSampleTs() });
    return {
      incidents: events.slice(0, MAX_INCIDENTS).map((e) => ({
        kind: e.kind, start: localTime(e.start), minutes: Math.round((e.end - e.start) / 60e3), ongoing: Boolean(e.ongoing),
        // batteryCovered: true, false, 'overload' (the home went dark anyway) or null (unknown)
        ...(e.kind === 'gridCut' && { houseAffected: e.batteryCovered == null ? null : e.batteryCovered !== true }),
        ...(e.recovered != null && { dataRecovered: e.recovered }),
      })),
      total: events.length, truncated: events.length > MAX_INCIDENTS,
    };
  },

  show_chart(args, { store }) {
    allow(args, ['type', 'from', 'to', 'bucket', 'invoice_id']);
    const { type, bucket, invoice_id: invoiceId } = args;
    if (!PRESET_TYPES.includes(type)) fail(`type must be one of ${PRESET_TYPES.join(', ')}`);
    const power = POWER_TYPES.includes(type);
    const { from, to, n } = range(args, power ? MAX_POWER_DAYS : MAX_DAYS);
    if (bucket != null) {
      const legal = power ? legalSeriesBuckets(n) : ENERGY_TYPES.includes(type) ? legalEnergyBuckets(n) : [];
      if (!legal.includes(bucket)) fail(legal.length ? `bucket must be one of ${legal.join(', ')} for this range` : 'this chart takes no bucket');
    }
    if (invoiceId != null) {
      if (power || ENERGY_TYPES.includes(type)) fail('invoice_id only applies to bill charts');
      invoiceOf(store, invoiceId);
    }
    const chart = { type, from, to, ...(bucket != null && { bucket }), ...(invoiceId != null && { invoiceId }) };
    return { result: { shown: chart, note: 'The chart is drawn in the chat from the app data. Describe it in one sentence; quote numbers only from tool results.' }, block: { type: 'chart', chart } };
  },
};

export const TOOL_NAMES = Object.keys(TOOL_FNS);

// deps: { store, config: { prices, plantName, battery }, now }. Returns { result, block? }; bad arguments give
// { result: { error } } so the model can try again.
export function runTool(name, args, deps) {
  const run = Object.hasOwn(TOOL_FNS, name) ? TOOL_FNS[name] : null;
  if (!run) return { result: { error: `unknown tool ${name}` } };
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return { result: { error: 'arguments must be a JSON object' } };
  try {
    const out = run(args, { ...deps, now: deps.now ?? Date.now, config: deps.config ?? {} });
    return name === 'show_chart' ? out : { result: out };
  } catch (err) {
    if (err instanceof ArgError) return { result: { error: err.message } };
    throw err;
  }
}

// Tool results are sent as compact JSON: non-integers rounded to 3 decimals.
export const toJson = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 1000) / 1000 : x));
