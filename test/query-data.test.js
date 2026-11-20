// query_data builder (spec 3.4, AC1): datasets from the store, the bills and the market prices, and its refusals.
// No TZ is forced: the suite runs under TZ=Europe/Madrid and TZ=UTC and every expectation is computed in local time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/db.js';
import * as aggregate from '../src/aggregate.js';
import { periodMoney } from '../src/tariff.js';
import { dayBounds, localDay } from '../src/collector.js';
import { normalise, toRow } from '../src/invoice-schema.js';
import { addDays, addMonths } from '../public/js/buckets.js';
import { DataError } from '../src/datasets.js';
import { buildDataset, METRICS } from '../src/query-data.js';

const HOUR = 3600e3;
const NOW = new Date(2026, 7, 1, 12).getTime(); // 2026-08-01 12:00 local
const ENV = { p1: 0.249, p2: 0.169, p3: 0.15, export: 0.03, adjust: 0.029, powerP1: 29.934, powerP2: 2.955, contractedP1: 4.4, contractedP2: 4.4,
  socialDay: 0.024839, meterDay: 0.044839, iee: 0.0511269, vat: 0.21 };
const near = (a, b, msg) => assert.ok(a === b || Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;

// A year of daily rows (2025-08-01..2026-07-31) and 5-minute samples over July 2026.
function seed() {
  const store = new Store(':memory:');
  let i = 0;
  for (let d = '2025-08-01'; d <= '2026-07-31'; d = addDays(d, 1), i++) {
    const load = 10 + (i % 5) + weekday(d);
    const imp = 3 + (i % 3);
    store.saveDaily(d, {
      pv_kwh: 12 + (i % 7), load_kwh: load, import_kwh: imp, export_kwh: 2 + (i % 2), self_use_kwh: 8, charge_kwh: 3, discharge_kwh: 2.5,
      import_p1: imp * 0.3, import_p2: imp * 0.3, import_p3: imp * 0.4, load_p1: load * 0.3, load_p2: load * 0.3, load_p3: load * 0.4,
    });
  }
  for (let d = '2026-07-01'; d <= '2026-07-31'; d = addDays(d, 1)) {
    const [start] = dayBounds(d);
    for (let s = 0; s < 288; s++) {
      const h = Math.floor(s / 12);
      const pv = h >= 7 && h < 20 ? 3 * Math.sin((Math.PI * (h - 7 + (s % 12) / 12)) / 13) : 0;
      const load = 0.4 + 0.1 * (h % 5) + Number(d.slice(8)) * 0.01;
      const battery = h >= 10 && h < 15 ? 1 : h >= 19 && h < 23 ? -0.8 : 0;
      store.saveSample(start + s * 300e3, { pv_kw: pv, load_kw: load, grid_kw: load - pv + battery, battery_kw: battery, soc: 20 + h * 3 });
    }
  }
  return store;
}
const store = seed();

// A fake REE cache: hourly prices for each requested day up to `lastPublished`; records its calls.
function fakeMarket({ lastPublished = '2099-12-31' } = {}) {
  const calls = [];
  return {
    calls,
    async hourly(from, to) {
      calls.push([from, to]);
      const pvpc = new Map(), spot = new Map();
      for (let d = from; d <= to && d <= lastPublished; d = addDays(d, 1)) {
        const [a, b] = dayBounds(d);
        for (let t = a; t < b; t += HOUR) {
          pvpc.set(t, price(t));
          spot.set(t, price(t) / 2);
        }
      }
      return { pvpc, spot };
    },
  };
}
const price = (t) => 0.1 + new Date(t).getHours() / 100 + Number(localDay(t).slice(8)) / 1000;
const deps = (over = {}) => ({ store, config: { prices: ENV }, now: () => NOW, market: fakeMarket(), ...over });
const column = (ds, name) => ds.columns.find((c) => c.name === name).values;

test('(a) July average day hour by hour: pv, load, charge and discharge kWh, 24 rows equal to the mean of the hourly series', async () => {
  const names = { pv_kwh: 'pv', load_kwh: 'load', charge_kwh: 'charge', discharge_kwh: 'discharge' };
  const args = { metrics: Object.keys(names), from: '2026-07-01', to: '2026-07-31', bucket: '1h', group_by: 'hour_of_day', agg: 'avg' };
  const ds = await buildDataset(args, deps());
  assert.deepEqual(ds.args, args);
  assert.deepEqual(ds.source, ['measured']);
  assert.equal(ds.x.type, 'hour_of_day');
  assert.deepEqual(ds.x.values, Array.from({ length: 24 }, (_, h) => h));
  const s = aggregate.series(store, { from: '2026-07-01', to: '2026-07-31', bucket: '1h', now: NOW });
  for (const [name, key] of Object.entries(names)) {
    const got = column(ds, name);
    for (let h = 0; h < 24; h++) {
      const vs = s.kwh[key].filter((v, j) => v != null && new Date(s.t[j]).getHours() === h);
      near(got[h], vs.reduce((a, b) => a + b, 0) / vs.length, `${name} ${h}h`);
    }
  }
  assert.equal(column(ds, 'pv_kwh')[2], 0);
  assert.ok(column(ds, 'pv_kwh')[13] > 0);
  assert.ok(column(ds, 'charge_kwh')[12] > 0 && column(ds, 'discharge_kwh')[20] > 0);
});

test('(b) weekday totals over a year equal sums of store.days by weekday', async () => {
  const [from, to] = ['2025-08-01', '2026-07-31'];
  const ds = await buildDataset({ metrics: ['load_kwh', 'import_kwh'], from, to, bucket: '1d', group_by: 'weekday', agg: 'sum' }, deps());
  assert.equal(ds.x.type, 'weekday');
  assert.deepEqual(ds.x.values, [1, 2, 3, 4, 5, 6, 7]);
  for (const name of ['load_kwh', 'import_kwh']) {
    const want = [0, 0, 0, 0, 0, 0, 0];
    for (const r of store.days(from, to)) want[weekday(r.day) - 1] += r[name];
    column(ds, name).forEach((v, k) => near(v, want[k], `${name} weekday ${k + 1}`));
  }
});

test("(c) yesterday's PVPC hour by hour joins the production on the hour", async () => {
  const yesterday = addDays(localDay(NOW), -1);
  const market = fakeMarket();
  const ds = await buildDataset({ metrics: ['pv_kwh', 'pvpc_eur_kwh'], from: yesterday, to: yesterday, bucket: '1h' }, deps({ market }));
  assert.deepEqual(market.calls, [[yesterday, yesterday]]);
  assert.deepEqual(ds.source, ['measured', 'ree']);
  assert.deepEqual(ds.columns.map((c) => [c.name, c.unit]), [['pv_kwh', 'kWh'], ['pvpc_eur_kwh', '€/kWh']]);
  const s = aggregate.series(store, { from: yesterday, to: yesterday, bucket: '1h', now: NOW });
  assert.equal(ds.x.type, 'time');
  assert.deepEqual(ds.x.values, s.t);
  assert.equal(ds.x.values.length, 24);
  assert.deepEqual(column(ds, 'pv_kwh'), s.kwh.pv);
  assert.deepEqual(column(ds, 'pvpc_eur_kwh'), s.t.map(price));
  assert.equal(ds.unavailableDays, undefined);
});

test('a price series alone at 1h has one column and groups by hour of day', async () => {
  const yesterday = addDays(localDay(NOW), -1);
  const ds = await buildDataset({ metrics: ['pvpc_eur_kwh'], from: yesterday, to: yesterday, bucket: '1h', group_by: 'hour_of_day', agg: 'avg' }, deps());
  assert.deepEqual(ds.columns.map((c) => c.name), ['pvpc_eur_kwh']);
  assert.equal(ds.x.type, 'hour_of_day');
  assert.equal(ds.columns[0].values.length, 24);
  assert.ok(ds.columns[0].values.every((v) => typeof v === 'number'));
});

test('(d) monthly savings this year equal periodMoney per month', async () => {
  const ds = await buildDataset({ metrics: ['savings_eur', 'estimated_eur'], from: '2026-01-01', to: '2026-12-31', bucket: '1mo' }, deps());
  assert.deepEqual(ds.source, ['estimate']);
  assert.equal(ds.x.type, 'month');
  assert.equal(ds.x.values.length, 12);
  ds.x.values.forEach((m, k) => {
    const m0 = `${m}-01`;
    const money = periodMoney(store.days(m0, addDays(addMonths(m0, 1), -1)), ENV);
    if (m > '2026-07') {
      assert.equal(money, null);
      assert.equal(column(ds, 'savings_eur')[k], null);
      return;
    }
    near(column(ds, 'savings_eur')[k], money.savings, `savings ${m}`);
    near(column(ds, 'estimated_eur')[k], money.bill, `bill ${m}`);
  });
});

test('import_cost_pvpc_eur sums import × pvpc per day', async () => {
  const [from, to] = ['2026-07-25', '2026-07-31'];
  const ds = await buildDataset({ metrics: ['import_cost_pvpc_eur', 'pvpc_eur_kwh'], from, to, bucket: '1d' }, deps());
  assert.deepEqual(ds.source, ['measured', 'ree']);
  assert.equal(ds.columns[0].unit, '€'); // ruling R7c: the caveat moved to the query_data note
  assert.equal(ds.x.type, 'day');
  const s = aggregate.series(store, { from, to, bucket: '1h', now: NOW });
  ds.x.values.forEach((d, k) => {
    const hours = s.t.map((t, j) => [t, j]).filter(([t]) => localDay(t) === d);
    near(column(ds, 'import_cost_pvpc_eur')[k], hours.reduce((a, [t, j]) => a + s.kwh.imp[j] * price(t), 0), `cost ${d}`);
    near(column(ds, 'pvpc_eur_kwh')[k], hours.reduce((a, [t]) => a + price(t), 0) / hours.length, `pvpc mean ${d}`);
  });
  assert.ok(column(ds, 'import_cost_pvpc_eur').every((v) => v > 0));
});

test('self_sufficiency_pct at 1mo comes from the month sums and is null on zero load', async () => {
  const s = new Store(':memory:');
  let i = 0;
  for (let d = '2026-05-01'; d <= '2026-06-30'; d = addDays(d, 1), i++) {
    const may = d < '2026-06';
    s.saveDaily(d, { load_kwh: may ? (i ? 20 : 10) : 0, import_kwh: may ? (i ? 2 : 8) : 0 });
  }
  const ds = await buildDataset({ metrics: ['self_sufficiency_pct'], from: '2026-05-01', to: '2026-06-30', bucket: '1mo' }, deps({ store: s }));
  assert.deepEqual(ds.x.values, ['2026-05', '2026-06']);
  const [load, imp] = [10 + 30 * 20, 8 + 30 * 2];
  near(column(ds, 'self_sufficiency_pct')[0], (100 * (load - imp)) / load, 'May');
  assert.notEqual(Math.round(column(ds, 'self_sufficiency_pct')[0] * 1000), Math.round(((20 + 30 * 90) / 31) * 1000)); // not the mean of daily ratios
  assert.equal(column(ds, 'self_sufficiency_pct')[1], null);
  assert.deepEqual(ds.columns.filter((c) => c.hidden).map((c) => c.name), ['load_kwh', 'import_kwh']);
});

test('market unavailable gives unavailable ree', async () => {
  const market = { hourly: async () => ({ unavailable: 'ree' }) };
  assert.deepEqual(await buildDataset({ metrics: ['spot_eur_kwh'], from: '2026-07-30', to: '2026-07-31', bucket: '1d' }, deps({ market })), { unavailable: 'ree' });
  assert.deepEqual(await buildDataset({ metrics: ['pvpc_eur_kwh'], from: '2026-07-30', to: '2026-07-31', bucket: '1d' }, deps({ market: undefined })), { unavailable: 'ree' });
});

test('days REE has not published come back unavailable, as nulls and never zero; later days are not asked for', async () => {
  const market = fakeMarket({ lastPublished: '2026-08-01' });
  const ds = await buildDataset({ metrics: ['pvpc_eur_kwh'], from: '2026-07-31', to: '2026-08-03', bucket: '1h' }, deps({ market }));
  assert.deepEqual(market.calls, [['2026-07-31', '2026-08-02']]); // tomorrow at most
  assert.deepEqual(ds.unavailableDays, ['2026-08-02', '2026-08-03']);
  const v = column(ds, 'pvpc_eur_kwh');
  ds.x.values.forEach((t, j) => {
    if (localDay(t) <= '2026-08-01') assert.equal(v[j], price(t));
    else assert.equal(v[j], null);
  });
  const later = fakeMarket();
  const none = await buildDataset({ metrics: ['spot_eur_kwh'], from: '2026-08-05', to: '2026-08-06', bucket: '1d' }, deps({ market: later }));
  assert.deepEqual(later.calls, []);
  assert.deepEqual(column(none, 'spot_eur_kwh'), [null, null]);
  assert.deepEqual(none.unavailableDays, ['2026-08-05', '2026-08-06']);
});

test('bills: one row per bill, a second bill of one month gets (2); power at 1d is keyed by day', async () => {
  const s = new Store(':memory:');
  const { row, readings } = toRow(normalise(JSON.parse(readFileSync(new URL('./fixtures/bills/sample-v1.json', import.meta.url)))));
  s.insertInvoice({ ...row, status: 'confirmed' }, [], readings);
  s.insertInvoice({ ...row, status: 'confirmed', total_eur: 61.2 }, [], readings);
  const ds = await buildDataset({ metrics: ['bill_total_eur', 'bill_price_p1', 'bill_kwh_p1'], from: '2026-10-01', to: '2026-10-31' }, deps({ store: s }));
  assert.deepEqual(ds.source, ['bills']);
  assert.deepEqual(ds.x, { type: 'bill', values: ['2026-10', '2026-10 (2)'] });
  assert.deepEqual(column(ds, 'bill_total_eur'), [59.15, 61.2]);
  assert.deepEqual(column(ds, 'bill_price_p1'), [0.249, 0.249]);
  assert.deepEqual(ds.columns.map((c) => c.unit), ['€', '€/kWh', 'kWh']);
  // a bill without a month (inverted period) is left out, as the browser would drop the figure (gate F1)
  s.insertInvoice({ ...row, status: 'confirmed', period_from: '2026-10-20', period_to: '2026-10-10' }, [], readings);
  const noMonth = await buildDataset({ metrics: ['bill_total_eur'], from: '2026-10-01', to: '2026-10-31' }, deps({ store: s }));
  assert.deepEqual(noMonth.x, { type: 'bill', values: ['2026-10', '2026-10 (2)'] });

  const p = await buildDataset({ metrics: ['import_kw_max', 'soc'], from: '2026-07-01', to: '2026-07-03', bucket: '1d' }, deps());
  assert.deepEqual(p.x, { type: 'day', values: ['2026-07-01', '2026-07-02', '2026-07-03'] });
  assert.ok(column(p, 'import_kw_max').every((v) => v > 0));
});

test('ruling R5: a 366-day import cost at 1mo builds in one market call; a 32-day pvpc_eur_kwh is refused', async () => {
  const market = fakeMarket();
  const [from, to] = ['2025-08-01', '2026-07-31']; // 365 days, the seeded year
  const ds = await buildDataset({ metrics: ['import_cost_pvpc_eur'], from: '2025-07-31', to, bucket: '1mo' }, deps({ market }));
  assert.deepEqual(market.calls, [['2025-07-31', to]]);
  assert.equal(ds.x.values.length, 13);
  const s = aggregate.series(store, { from, to, bucket: '1h', now: NOW });
  const july = s.t.map((t, j) => [t, j]).filter(([t]) => localDay(t).startsWith('2026-07'));
  near(column(ds, 'import_cost_pvpc_eur')[ds.x.values.indexOf('2026-07')], july.reduce((a, [t, j]) => a + (s.kwh.imp[j] ?? 0) * price(t), 0), 'July');
  await assert.rejects(buildDataset({ metrics: ['pvpc_eur_kwh'], from: '2026-06-30', to: '2026-07-31', bucket: '1d' }, deps({ market })), /at most 31 days/);
  assert.equal(market.calls.length, 1);
});

test('refusals', async () => {
  const july = { from: '2026-07-01', to: '2026-07-31' };
  const cases = [
    ['two groups', { metrics: ['pv_kwh', 'pv_kw'], ...july, bucket: '1h' }, /one group/],
    ['market at 1mo', { metrics: ['pvpc_eur_kwh'], ...july, bucket: '1mo' }, /pvpc_eur_kwh needs bucket 1h, 1d/],
    ['self_use_kwh at 1h', { metrics: ['self_use_kwh'], ...july, bucket: '1h' }, /self_use_kwh needs bucket 1d, 1mo, 1y/],
    ['1h over 32 days', { metrics: ['pv_kw'], from: '2026-07-01', to: '2026-08-01', bucket: '1h' }, /too many rows over 32 days/],
    ['751 rows', { metrics: ['pv_kwh'], from: '2024-07-01', to: addDays('2024-07-01', 750), bucket: '1d' }, /too many rows over 751 days: use 1mo, 1y/],
    ['market over 31 days', { metrics: ['spot_eur_kwh'], from: '2026-06-01', to: '2026-07-02', bucket: '1d' }, /at most 31 days/],
    ['import cost over 366 days', { metrics: ['import_cost_pvpc_eur'], from: '2025-07-30', to: '2026-07-31', bucket: '1mo' }, /at most 366 days/],
    ['pvpc over 31 days beside the import cost', { metrics: ['import_cost_pvpc_eur', 'pvpc_eur_kwh'], from: '2026-06-01', to: '2026-07-02', bucket: '1d' }, /at most 31 days/],
    ['bills with a bucket', { metrics: ['bill_total_eur'], ...july, bucket: '1mo' }, /takes no bucket/],
    ['market with bills', { metrics: ['bill_total_eur', 'pvpc_eur_kwh'], ...july }, /pvpc_eur_kwh needs bucket/],
    ['group_by without agg', { metrics: ['pv_kwh'], ...july, bucket: '1d', group_by: 'weekday' }, /group_by needs agg/],
    ['agg without group_by', { metrics: ['pv_kwh'], ...july, bucket: '1d', agg: 'sum' }, /agg needs group_by/],
    ['hour_of_day at 1d', { metrics: ['pv_kwh'], ...july, bucket: '1d', group_by: 'hour_of_day', agg: 'avg' }, /hour_of_day needs bucket 1h/],
    ['hour_of_day at 15m', { metrics: ['pv_kw'], from: '2026-07-01', to: '2026-07-02', bucket: '15m', group_by: 'hour_of_day', agg: 'avg' }, /hour_of_day needs bucket 1h/],
    ['weekday at 1mo', { metrics: ['pv_kwh'], ...july, bucket: '1mo', group_by: 'weekday', agg: 'sum' }, /weekday needs bucket 1d/],
    ['unknown argument', { metrics: ['pv_kwh'], ...july, bucket: '1d', x: 'time' }, /unknown argument x/],
    ['unknown metric', { metrics: ['pv_kwh', 'magic'], ...july, bucket: '1d' }, /unknown metric magic/],
    ['nine metrics', { metrics: Object.keys(METRICS).filter((n) => METRICS[n].group === 'power').slice(0, 9), ...july, bucket: '1d' }, /1 to 8/],
    ['no bucket', { metrics: ['pv_kwh'], ...july }, /pv_kwh needs bucket/],
    ['bad day', { metrics: ['pv_kwh'], from: '2026-02-30', to: '2026-03-01', bucket: '1d' }, /real days/],
    ['reversed range', { metrics: ['pv_kwh'], from: '2026-07-02', to: '2026-07-01', bucket: '1d' }, /from must not be after to/],
  ];
  for (const [name, args, re] of cases) {
    const market = fakeMarket();
    await assert.rejects(buildDataset(args, deps({ market })), (e) => e instanceof DataError && re.test(e.message), name);
    assert.deepEqual(market.calls, [], `${name}: no market call`);
  }
  await assert.rejects(buildDataset({ metrics: ['savings_eur'], ...july, bucket: '1mo' }, deps({ config: {} })), /prices are not configured/);
  await assert.rejects(buildDataset(null, deps()), DataError);
});

test('the catalogue: units, buckets and sources as spec 3.4', () => {
  assert.equal(Object.keys(METRICS).length, 41);
  assert.deepEqual(METRICS.pv_kwh, { group: 'energy', unit: 'kWh', buckets: ['1h', '1d', '1mo', '1y'], source: ['measured'] });
  assert.deepEqual(METRICS.import_p2.buckets, ['1d', '1mo', '1y']);
  assert.deepEqual(METRICS.soc_min, { group: 'power', unit: '%', buckets: ['5m', '15m', '1h', '1d'], source: ['measured'] });
  assert.equal(METRICS.import_kw_max.unit, 'kW');
  assert.deepEqual(METRICS.savings_eur, { group: 'money', unit: '€', buckets: ['1d', '1mo', '1y'], source: ['estimate'] });
  assert.equal(METRICS.self_consumption_pct.unit, '%');
  assert.deepEqual(METRICS.bill_surplus_price, { group: 'bills', unit: '€/kWh', buckets: [], source: ['bills'] });
  assert.deepEqual(METRICS.spot_eur_kwh, { group: 'market', unit: '€/kWh', buckets: ['1h', '1d'], source: ['ree'] });
  assert.deepEqual(METRICS.import_cost_pvpc_eur.source, ['measured', 'ree']);
});

test('query_data says import_cost_pvpc_eur is the energy term only; its unit is plain € (ruling R7c)', async () => {
  const { runTool } = await import('../src/assistant-tools.js');
  const { createDatasets } = await import('../src/datasets.js');
  const args = { metrics: ['import_cost_pvpc_eur'], from: '2026-07-25', to: '2026-07-31', bucket: '1d' };
  const out = await runTool('query_data', args, { ...deps(), datasets: createDatasets() });
  assert.equal(out.result.units.import_cost_pvpc_eur, '€');
  assert.match(out.result.note, /energy term only .*chart notes/);
  const plain = await runTool('query_data', { ...args, metrics: ['import_kwh'] }, { ...deps(), datasets: createDatasets() });
  assert.equal(plain.result.note, undefined);
  assert.equal(out.result.uncoveredDays, undefined);
});

test('import_cost_pvpc_eur reports days with daily import but no hourly data as uncoveredDays (gate F5)', async () => {
  const { runTool } = await import('../src/assistant-tools.js');
  const { createDatasets } = await import('../src/datasets.js');
  // June has daily rows only, July has 5-minute samples too
  const args = { metrics: ['import_cost_pvpc_eur'], from: '2026-06-29', to: '2026-07-02', bucket: '1d' };
  const ds = await buildDataset(args, deps());
  assert.deepEqual(ds.uncoveredDays, ['2026-06-29', '2026-06-30']);
  assert.deepEqual(column(ds, 'import_cost_pvpc_eur').map((v) => v != null), [false, false, true, true]);
  const out = await runTool('query_data', args, { ...deps(), datasets: createDatasets() });
  assert.deepEqual(out.result.uncoveredDays, ['2026-06-29', '2026-06-30']);
  assert.match(out.result.note, /leaves out uncoveredDays .*partial/);
  // a day REE has not published is reported once, as unavailable, not also as uncovered
  const late = await buildDataset(args, deps({ market: fakeMarket({ lastPublished: '2026-06-29' }) }));
  assert.deepEqual(late.unavailableDays, ['2026-06-30', '2026-07-01', '2026-07-02']);
  assert.deepEqual(late.uncoveredDays, ['2026-06-29']);
});
