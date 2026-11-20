// query_data (spec 3.4): the metric catalogue and the builder that turns one call into a dataset of src/datasets.js,
// computed by the existing pure functions (aggregate, tariff through aggregate, billing) and the REE price cache.
// Local days and hours are the process's: the server runs in the plant's time zone, as REE's (Europe/Madrid).
import * as aggregate from './aggregate.js';
import { billingSummary } from './billing.js';
import { localDay } from './collector.js';
import { isDate } from './invoice-schema.js';
import { DataError, MAX_COLUMNS, RATIOS, GROUPS, AGGS, groupDataset, withRatios } from './datasets.js';
import { addDays, spanDays, legalSeriesBuckets, legalEnergyBuckets } from '../public/js/buckets.js';

const fail = (m) => { throw new DataError(m); };

const SERIES_BUCKETS = ['5m', '15m', '1h'];
const ENERGY_BUCKETS = ['1d', '1mo', '1y'];
const POWER_BUCKETS = [...SERIES_BUCKETS, '1d'];
const X_TYPE = { '5m': 'time', '15m': 'time', '1h': 'time', '1d': 'day', '1mo': 'month', '1y': 'year' };
const KEY_LEN = { '1d': 10, '1mo': 7, '1y': 4 };
// Ruling R4: every range that reads market prices is at most 31 days (spec 3.3), checked before market.hourly.
export const MARKET_DAYS = 31;
const COST_UNIT = '€ (energy term only, no taxes or fixed terms)';
const KEYS = ['metrics', 'from', 'to', 'bucket', 'group_by', 'agg'];

// metric → where its values come from
const HOURLY_KWH = { pv_kwh: 'pv', load_kwh: 'load', import_kwh: 'imp', export_kwh: 'exp', charge_kwh: 'charge', discharge_kwh: 'discharge' };
const POWER = {
  pv_kw: 'pv_kw', load_kw: 'load_kw', import_kw: 'imp_kw', export_kw: 'exp_kw', charge_kw: 'charge_kw', discharge_kw: 'discharge_kw',
  soc: 'soc', load_kw_max: 'load_kw_max', import_kw_max: 'imp_kw_max', soc_max: 'soc_max', soc_min: 'soc_min',
};
const MONEY = { estimated_eur: 'bill', savings_eur: 'savings' };
const BILL = {
  bill_total_eur: (b) => b.total, bill_energy_eur: (b) => b.parts.energy, bill_fixed_eur: (b) => b.parts.fixed,
  bill_taxes_eur: (b) => b.parts.taxes, bill_other_eur: (b) => b.parts.other, bill_surplus_eur: (b) => b.parts.surplus,
  bill_kwh_p1: (b) => b.kwh.p1, bill_kwh_p2: (b) => b.kwh.p2, bill_kwh_p3: (b) => b.kwh.p3,
  bill_price_p1: (b) => b.prices.p1, bill_price_p2: (b) => b.prices.p2, bill_price_p3: (b) => b.prices.p3,
  bill_surplus_price: (b) => b.prices.surplus,
};
const MARKET = { pvpc_eur_kwh: 'pvpc', spot_eur_kwh: 'spot' };

const def = (names, group, unit, buckets, source) => names.map((n) => [n, { group, unit: typeof unit === 'function' ? unit(n) : unit, buckets, source }]);
// name → { group, unit, buckets, source }; buckets [] means one row per bill and no bucket argument
export const METRICS = Object.fromEntries([
  ...def(Object.keys(HOURLY_KWH), 'energy', 'kWh', ['1h', ...ENERGY_BUCKETS], ['measured']),
  ...def(['self_use_kwh', 'import_p1', 'import_p2', 'import_p3'], 'energy', 'kWh', ENERGY_BUCKETS, ['measured']),
  ...def(Object.keys(POWER), 'power', (n) => (n.startsWith('soc') ? '%' : 'kW'), POWER_BUCKETS, ['measured']),
  ...def(Object.keys(MONEY), 'money', '€', ENERGY_BUCKETS, ['estimate']),
  ...def(Object.keys(RATIOS), 'ratio', '%', ENERGY_BUCKETS, ['measured']),
  ...def(Object.keys(BILL), 'bills', (n) => (n.includes('_kwh_') ? 'kWh' : n.includes('price') ? '€/kWh' : '€'), [], ['bills']),
  ...def(Object.keys(MARKET), 'market', '€/kWh', ['1h', '1d'], ['ree']),
  ...def(['import_cost_pvpc_eur'], 'market_use', COST_UNIT, ['1d', '1mo'], ['measured', 'ree']),
]);
const readsMarket = (n) => METRICS[n].source.includes('ree');

// Checks the arguments; returns them normalised plus the call's group.
function parse(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('arguments must be an object');
  for (const k of Object.keys(args)) if (!KEYS.includes(k)) fail(`unknown argument ${k}`);
  const { metrics, from, to, bucket, group_by: by, agg } = args;
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > MAX_COLUMNS) fail(`metrics must hold 1 to ${MAX_COLUMNS} names`);
  for (const n of metrics) if (typeof n !== 'string' || !Object.hasOwn(METRICS, n)) fail(`unknown metric ${n}; metrics: ${Object.keys(METRICS).join(', ')}`);
  if (new Set(metrics).size !== metrics.length) fail('a metric is repeated');
  if (!isDate(from) || !isDate(to)) fail('from and to must be real days as YYYY-MM-DD');
  if (from > to) fail('from must not be after to');

  const groups = [...new Set(metrics.map((n) => METRICS[n].group).filter((g) => g !== 'market'))];
  if (groups.length > 1) fail(`one call takes metrics of one group plus market prices; these are of ${groups.join(', ')}: make one call per group`);
  const group = groups[0] ?? 'market';
  for (const n of metrics) {
    const { buckets } = METRICS[n];
    if (!buckets.length && bucket != null) fail(`${n} takes no bucket: one row per bill`);
    if (buckets.length && !buckets.includes(bucket)) fail(`${n} needs bucket ${buckets.join(', ')}`);
  }

  const days = spanDays(from, to);
  if (bucket != null) {
    const legal = SERIES_BUCKETS.includes(bucket) ? legalSeriesBuckets(days) : legalEnergyBuckets(days);
    if (!legal.includes(bucket)) fail(`bucket ${bucket} gives too many rows over ${days} days${legal.length ? `: use ${legal.join(', ')} or a shorter range` : ''}`);
  }
  if (metrics.some(readsMarket) && days > MARKET_DAYS) fail(`market prices take at most ${MARKET_DAYS} days`);

  if (by != null || agg != null) {
    if (by == null) fail('agg needs group_by');
    if (!Object.hasOwn(GROUPS, by)) fail(`group_by must be one of ${Object.keys(GROUPS).join(', ')}`);
    if (agg == null) fail(`group_by needs agg: ${AGGS.join(', ')}`);
    if (!AGGS.includes(agg)) fail(`agg must be one of ${AGGS.join(', ')}`);
    if (by === 'hour_of_day' ? bucket !== '1h' : !GROUPS[by].includes(X_TYPE[bucket])) {
      fail(by === 'hour_of_day' ? 'hour_of_day needs bucket 1h' : `${by} needs bucket 1d${by === 'month_of_year' ? ' or 1mo' : ''}`);
    }
  }
  return { args: { metrics: [...metrics], from, to, ...(bucket != null && { bucket }), ...(by != null && { group_by: by, agg }) }, group };
}

// One key per bucket of [from, to]: 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'.
function bucketKeys(from, to, bucket) {
  const out = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) out.add(d.slice(0, KEY_LEN[bucket]));
  return [...out];
}

const col = (name, values, hidden) => ({ name, unit: hidden ? 'kWh' : METRICS[name].unit, values, ...(hidden && { hidden }) });

// deps: { store, config: { prices }, now: () => ms, market: { hourly }, signal }.
// → dataset without id, or { unavailable: 'ree' } when the market prices could not be read. Bad arguments throw DataError.
export async function buildDataset(args, { store, config = {}, now = Date.now, market, signal } = {}) {
  const { args: norm, group } = parse(args);
  const { metrics, from, to, bucket } = norm;
  const t = now();
  const prices = config.prices ?? null;
  if (group === 'money' && !prices) fail('prices are not configured');
  const base = metrics.filter((n) => METRICS[n].group === group);
  let hours = null; // aggregate.series at 1h, read once
  const hourly = () => (hours ??= aggregate.series(store, { from, to, bucket: '1h', now: t }));

  let x;
  let columns;
  if (group === 'bills') {
    const bills = billingSummary(store, { from, to, prices, today: localDay(t) }).invoices;
    const seen = new Map();
    x = { type: 'bill', values: bills.map((b) => {
      const k = (seen.get(b.month) ?? 0) + 1;
      seen.set(b.month, k);
      return k > 1 ? `${b.month} (${k})` : b.month;
    }) };
    columns = base.map((n) => col(n, bills.map((b) => BILL[n](b) ?? null)));
  } else if (group === 'power' || bucket === '1h') {
    // power at any bucket, energy at 1h, market alone at 1h
    const s = bucket === '1h' ? hourly() : aggregate.series(store, { from, to, bucket, now: t });
    x = bucket === '1d' ? { type: 'day', values: s.t.map(localDay) } : { type: 'time', values: s.t };
    columns = base.map((n) => col(n, group === 'power' ? s.series[POWER[n]] : s.kwh[HOURLY_KWH[n]]));
  } else if (group === 'energy' || group === 'money' || group === 'ratio') {
    const e = aggregate.energy(store, { from, to, bucket, prices, now: t }).buckets;
    x = { type: X_TYPE[bucket], values: e.map((b) => b.key) };
    const field = (b, n) => (group === 'money' ? b.money?.[MONEY[n]] : b[n]) ?? null;
    columns = base.map((n) => col(n, group === 'ratio' ? e.map(() => null) : e.map((b) => field(b, n))));
    if (group === 'ratio') {
      const parts = [...new Set(base.flatMap((n) => RATIOS[n].uses))];
      columns.push(...parts.map((p) => col(p, e.map((b) => field(b, p)), true)));
    }
  } else {
    // market alone at 1d, or import_cost_pvpc_eur
    x = { type: X_TYPE[bucket], values: bucketKeys(from, to, bucket) };
    columns = [];
  }

  const priced = metrics.filter(readsMarket);
  let unavailableDays = [];
  if (priced.length) {
    // REE publishes a day the afternoon before: later days are never asked for, and come back unavailable (null), never 0
    const tomorrow = addDays(localDay(t), 1);
    const last = to < tomorrow ? to : tomorrow;
    const got = from > last ? { pvpc: new Map(), spot: new Map() } : market ? await market.hourly(from, last, { signal }) : { unavailable: 'ree' };
    if (got.unavailable) return { unavailable: 'ree' };
    const kinds = [...new Set(priced.map((n) => MARKET[n] ?? 'pvpc'))];
    const published = new Set(kinds.flatMap((k) => [...got[k].keys()].map(localDay)));
    unavailableDays = bucketKeys(from, to, '1d').filter((d) => !published.has(d));

    const keyOf = (ts) => localDay(ts).slice(0, KEY_LEN[bucket]);
    const byKey = (pairs) => {
      const acc = new Map();
      for (const [ts, v] of pairs) {
        const k = keyOf(ts);
        const a = acc.get(k) ?? [0, 0];
        acc.set(k, [a[0] + v, a[1] + 1]);
      }
      return acc;
    };
    for (const n of priced) {
      let values;
      if (n === 'import_cost_pvpc_eur') {
        const s = hourly();
        const pvpc = got.pvpc;
        const sums = byKey(s.t.flatMap((ts, j) => (s.kwh.imp[j] != null && pvpc.has(ts) ? [[ts, s.kwh.imp[j] * pvpc.get(ts)]] : [])));
        values = x.values.map((k) => sums.get(k)?.[0] ?? null);
      } else if (bucket === '1h') {
        values = x.values.map((ts) => got[MARKET[n]].get(ts) ?? null);
      } else {
        const means = byKey(got[MARKET[n]]);
        values = x.values.map((k) => (means.has(k) ? means.get(k)[0] / means.get(k)[1] : null));
      }
      columns.splice(metrics.indexOf(n), 0, col(n, values));
    }
  }

  let ds = { args: norm, source: [...new Set(metrics.flatMap((n) => METRICS[n].source))], x, columns };
  if (group === 'ratio') ds = withRatios(ds);
  if (norm.group_by) ds = groupDataset(ds, norm.group_by, norm.agg);
  return unavailableDays.length ? { ...ds, unavailableDays } : ds;
}
