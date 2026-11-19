process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { dayBounds } from '../src/collector.js';
import { series } from '../src/aggregate.js';
import { startTestServer } from './helpers.js';

const H = 3600e3;
const M = 60e3;
const NOW = new Date(2026, 10, 19, 12, 0).getTime(); // 2026-11-19 12:00 local
const at = (day, h, m = 0) => dayBounds(day)[0] + h * H + m * M;
const get = async (srv, path) => {
  const r = await srv.request(path);
  return [r.status, await r.json()];
};
const fill = (store, day, from, to, row) => {
  for (let ts = at(day, from); ts < at(day, to); ts += 5 * M) store.saveSample(ts, row);
};
const PRICES = { p1: 0.2, p2: 0.2, p3: 0.2, export: 0.1, adjust: 0, powerP1: 0, powerP2: 0, contractedP1: 4, contractedP2: 4, socialDay: 0, meterDay: 0, iee: 0, vat: 0 };

test('series 5m keeps nulls and marks gaps with coverage 0', () => {
  const store = new Store(':memory:');
  const day = '2026-11-10';
  for (let ts = at(day, 0); ts < at(day, 24); ts += 5 * M) if (ts !== at(day, 10)) store.saveSample(ts, { load_kw: 1, pv_kw: 2 });
  const r = series(store, { from: day, to: day, bucket: '5m', now: NOW });
  assert.equal(r.t.length, 288);
  const i = r.t.indexOf(at(day, 10));
  assert.equal(r.series.pv_kw[i], null);
  assert.equal(r.coverage[i], 0);
  assert.equal(r.series.pv_kw[i + 1], 2);
  assert.equal(r.coverage[i + 1], 1);
});

test('signs are split before averaging', () => {
  const store = new Store(':memory:');
  const day = '2026-11-10';
  store.saveSample(at(day, 10, 0), { grid_kw: 2, battery_kw: 1, load_kw: 1 });
  store.saveSample(at(day, 10, 5), { grid_kw: -2, battery_kw: -1, load_kw: 1 });
  const r = series(store, { from: day, to: day, bucket: '15m', now: NOW });
  const i = r.t.indexOf(at(day, 10));
  assert.equal(r.series.imp_kw[i], 1);
  assert.equal(r.series.exp_kw[i], 1);
  assert.equal(r.series.imp_kw_max[i], 2);
  assert.equal(r.series.charge_kw[i], 0.5);
  assert.equal(r.series.discharge_kw[i], 0.5);
});

test('DST days have 23 and 25 hourly buckets', () => {
  const store = new Store(':memory:');
  const now = new Date(2026, 11, 1).getTime();
  const n = (day, bucket) => series(store, { from: day, to: day, bucket, now }).t.length;
  assert.deepEqual([n('2026-03-29', '1h'), n('2026-03-29', '5m')], [23, 276]);
  assert.deepEqual([n('2026-10-25', '1h'), n('2026-10-25', '5m')], [25, 300]);
});

test('hourly kwh is scaled per day to the daily totals', () => {
  const store = new Store(':memory:');
  const day = '2026-11-10';
  fill(store, day, 10, 12, { pv_kw: 1 });
  store.saveDaily(day, { pv_kwh: 3 });
  const { kwh, t } = series(store, { from: day, to: day, bucket: '1h', now: NOW });
  assert.ok(Math.abs(kwh.pv.reduce((a, b) => a + b, 0) - 3) < 1e-9);
  assert.ok(Math.abs(kwh.pv[t.indexOf(at(day, 10))] - 1.5) < 1e-9);
  assert.ok(Math.abs(kwh.pv[t.indexOf(at(day, 11))] - 1.5) < 1e-9);
  assert.equal(kwh.pv[0], null);
});

test('too many buckets is rejected with the legal list', async () => {
  const srv = await startTestServer({ store: new Store(':memory:') });
  try {
    let [status, body] = await get(srv, '/api/series?from=2026-01-01&to=2026-01-03&bucket=5m');
    assert.equal(status, 400);
    assert.ok(!body.legal.includes('5m'));
    assert.equal((await get(srv, '/api/series?from=2026-01-01&to=2026-02-01&bucket=1h'))[0], 400);
    assert.equal((await get(srv, '/api/series?from=2026-01-01&to=2026-01-30&bucket=1d'))[0], 200);
    assert.equal((await get(srv, '/api/series?from=2026-01-05&to=2026-01-01&bucket=1d'))[0], 400);
    assert.equal((await get(srv, '/api/series?from=2026-01-01&to=2026-01-01&bucket=2h'))[0], 400);
    // impossible calendar dates are a 400, not a 500 from SQLite
    assert.equal((await get(srv, '/api/series?from=2026-02-30&to=2026-03-01&bucket=5m'))[0], 400);
    assert.equal((await get(srv, '/api/days?from=2026-02-30&to=2026-03-01'))[0], 400);
    assert.equal((await get(srv, '/api/events?from=2026-13-01&to=2026-13-02'))[0], 400);
  } finally {
    await srv.close();
  }
});

test('future buckets have null coverage and values', () => {
  const store = new Store(':memory:');
  const day = '2026-11-19';
  fill(store, day, 0, 24, { load_kw: 1, pv_kw: 1 }); // samples beyond now must not leak
  const r = series(store, { from: day, to: day, bucket: '1h', now: NOW });
  const i = r.t.indexOf(at(day, 13));
  assert.equal(r.coverage[i], null);
  assert.equal(r.series.pv_kw[i], null);
  assert.equal(r.kwh.pv[i], null);
  assert.equal(r.coverage[r.t.indexOf(at(day, 9))], 1);
});

test('provisional follows the 36 h rule', () => {
  const store = new Store(':memory:');
  const end = dayBounds('2026-11-10')[1];
  store.markDay('2026-11-10', 1, end + 35 * H);
  store.markDay('2026-11-11', 1, dayBounds('2026-11-11')[1] + 37 * H);
  const r = series(store, { from: '2026-11-10', to: '2026-11-12', bucket: '1d', now: NOW });
  assert.deepEqual(r.provisional, [true, false, true]);
});

test('energy groups daily rows by day, month and year with days and coverage', async () => {
  const store = new Store(':memory:');
  for (const day of ['2026-09-10', '2026-09-11', '2026-10-01', '2026-10-03']) store.saveDaily(day, { pv_kwh: 1, import_p1: 1, load_p1: 2, export_kwh: 0.5 });
  const srv = await startTestServer({ store, config: { prices: PRICES } });
  try {
    const [, e] = await get(srv, '/api/energy?from=2026-09-01&to=2026-10-04&bucket=1mo');
    assert.deepEqual(e.buckets.map((b) => b.key), ['2026-09', '2026-10']);
    assert.deepEqual(e.buckets.map((b) => [b.days, b.daysExpected]), [[2, 30], [2, 4]]);
    assert.equal(e.buckets[1].coverage, 0.5);
    assert.equal(e.buckets[0].pv_kwh, 2);
    assert.equal(e.buckets[1].from, '2026-10-01');
    assert.equal(e.total.days, 4);
    assert.ok(e.buckets[0].money.bill != null);
    const [, y] = await get(srv, '/api/energy?from=2026-01-01&to=2026-12-31&bucket=1y');
    assert.deepEqual(y.buckets.map((b) => [b.key, b.days]), [['2026', 4]]);
    const [, d] = await get(srv, '/api/energy?from=2026-09-10&to=2026-09-12&bucket=auto');
    assert.deepEqual(d.buckets.map((b) => b.key), ['2026-09-10', '2026-09-11', '2026-09-12']);
    assert.equal(d.buckets[2].pv_kwh, null);
    assert.equal(d.buckets[2].money, null);
    assert.equal((await get(srv, '/api/energy?from=2026-01-01&to=2026-12-31&bucket=1d'))[0], 200);
    assert.equal((await get(srv, '/api/energy?from=2020-01-01&to=2026-12-31&bucket=1d'))[0], 400);
  } finally {
    await srv.close();
  }
});

test('energy compare reports not comparable with a reason', async () => {
  const store = new Store(':memory:');
  const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(from[0], from[1], from[2] + i)).toISOString().slice(0, 10));
  for (const d of days([2026, 9, 1], 31)) store.saveDaily(d, { pv_kwh: 1 }); // October complete
  for (const d of days([2026, 10, 1], 10)) store.saveDaily(d, { pv_kwh: 1 }); // November 1-10
  const srv = await startTestServer({ store });
  try {
    const q = (from, to, c) => get(srv, `/api/energy?from=${from}&to=${to}&bucket=1d&compare=${c}`);
    let [, e] = await q('2026-11-01', '2026-11-10', 'yoy');
    assert.deepEqual([e.compare.comparable, e.compare.reason], [false, 'beforeFirstDay']);
    [, e] = await q('2026-11-11', '2026-11-20', 'prev');
    assert.equal(e.compare.from, '2026-11-01');
    assert.deepEqual([e.compare.comparable, e.compare.reason], [true, null]);
    assert.equal(e.compare.buckets.length, e.buckets.length);
    [, e] = await q('2026-11-01', '2026-11-10', 'prev');
    assert.deepEqual([e.compare.from, e.compare.comparable, e.compare.reason], ['2026-10-22', true, null]);
    [, e] = await q('2026-11-06', '2026-11-15', 'prev');
    assert.deepEqual([e.compare.comparable, e.compare.reason], [true, null]);
    [, e] = await q('2026-11-16', '2026-11-25', 'prev');
    assert.deepEqual([e.compare.comparable, e.compare.reason], [false, 'lowCoverage']);
    assert.equal(e.compare.total.coverage, 0.5);
  } finally {
    await srv.close();
  }
});

test('signals list and history', async () => {
  const store = new Store(':memory:');
  store.setKv('devices', [{ dn: 'D1', type: 'Inverter', name: 'Inv', signals: [{ id: 1, name: 'A', unit: 'kW' }, { id: 2, name: 'B', unit: 'V' }] }]);
  const day = '2026-11-10';
  store.saveHistory('D1', 1, at(day, 10, 0), 1);
  store.saveHistory('D1', 1, at(day, 10, 30), 3);
  store.saveHistory('D1', 2, at(day, 11, 0), 230);
  store.saveHistory('D1', 1, at(day, 11, 0), null);
  const srv = await startTestServer({ store });
  try {
    const [, list] = await get(srv, '/api/signals');
    assert.deepEqual(list[0].signals.map((s) => [s.id, s.firstTs, s.lastTs]), [[1, at(day, 10), at(day, 11)], [2, at(day, 11), at(day, 11)]]);
    const [, h] = await get(srv, `/api/signals/history?dn=D1&ids=1,2&from=${day}&to=${day}&bucket=1h`);
    const i = h.t.indexOf(at(day, 10));
    assert.deepEqual([h.signals[0].avg[i], h.signals[0].min[i], h.signals[0].max[i]], [2, 1, 3]);
    assert.equal(h.signals[0].unit, 'kW');
    assert.equal(h.signals[1].avg[h.t.indexOf(at(day, 11))], 230);
    assert.equal(h.signals[1].avg[i], null);
    assert.equal((await get(srv, `/api/signals/history?dn=D1&ids=1,2,3,4,5,6,7&from=${day}&to=${day}&bucket=1h`))[0], 400);
    assert.equal((await get(srv, `/api/signals/history?dn=D1&ids=x&from=${day}&to=${day}&bucket=1h`))[0], 400);
    assert.equal((await get(srv, `/api/signals/history?dn=nope&ids=1&from=${day}&to=${day}&bucket=1h`))[0], 404);
    assert.equal((await get(srv, `/api/signals/history?dn=D1&ids=1&from=${day}&to=${day}&bucket=auto`))[0], 200);
    assert.equal((await get(srv, `/api/signals/history?dn=D1&ids=1&from=2026-01-01&to=2026-03-01&bucket=1h`))[0], 400);
  } finally {
    await srv.close();
  }
});

test('status reports first days, version, today, time zone, backfill and auth block', async () => {
  const store = new Store(':memory:');
  store.saveDaily('2026-11-03', { pv_kwh: 1 });
  store.saveSample(at('2026-11-02', 10), { pv_kw: 1 });
  store.setKv('station', { batteryKwh: 10 });
  store.setKv('batteryConfig', { endOfDischargePct: 10, maxChargeKw: 5, maxDischargeKw: 6, gridChargeCutoffPct: 90 });
  const collector = { status: { lastTick: Date.now(), lastError: null, backfill: { done: 3, total: 10 } }, authBlockedUntil: 12345 };
  const mk = (battery) => startTestServer({ store, collector, config: { battery, prices: { ...PRICES, contractedP1: 4.4, contractedP2: 3.3 } } });
  let srv = await mk({ minPct: 15 });
  try {
    const [, s] = await get(srv, '/api/status');
    assert.equal(s.firstDay, '2026-11-03');
    assert.equal(s.firstSampleDay, '2026-11-02');
    assert.match(s.version, /^\d+\.\d+\.\d+/);
    assert.match(s.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(s.timeZone, 'Europe/Madrid');
    assert.deepEqual(s.collector.backfill, { done: 3, total: 10 });
    assert.equal(s.collector.authBlockedUntil, 12345);
    assert.equal(s.battery.source.minPct, 'env');
    assert.equal(s.battery.source.capacityKwh, 'fusionsolar');
    assert.equal(s.battery.source.reservePct, null);
    assert.deepEqual([s.battery.maxChargeKw, s.battery.maxDischargeKw, s.battery.source.maxChargeKw], [5, 6, 'fusionsolar']);
    assert.deepEqual([s.prices.contractedP1, s.prices.contractedP2], [4.4, 3.3]);
  } finally {
    await srv.close();
  }
  srv = await mk({});
  try {
    assert.equal((await get(srv, '/api/status'))[1].battery.source.minPct, 'fusionsolar');
  } finally {
    await srv.close();
  }
});

test('events accept day ranges up to 800 days and filter kinds', async () => {
  const store = new Store(':memory:');
  const day = '2026-11-10';
  store.saveAlarm({ csn: 1, alarmName: 'Grid Undervoltage', occurUtc: at(day, 10), clearUtc: at(day, 11), cleared: true });
  store.saveAlarm({ csn: 2, alarmName: 'Network Connection Error', occurUtc: at(day, 14), clearUtc: at(day, 16), cleared: true });
  const srv = await startTestServer({ store });
  try {
    const [, all] = await get(srv, `/api/events?from=${day}&to=${day}`);
    assert.deepEqual(all.map((e) => e.kind).sort(), ['gridCut', 'network']);
    const [, cut] = await get(srv, `/api/events?from=2025-01-01&to=2026-11-30&kinds=gridCut`);
    assert.deepEqual(cut.map((e) => e.kind), ['gridCut']);
    assert.equal((await get(srv, '/api/events?from=2024-01-01&to=2026-11-30'))[0], 400);
    assert.equal((await get(srv, `/api/events?from=${at(day, 0)}&to=${at(day, 24)}`))[0], 200);
  } finally {
    await srv.close();
  }
});
