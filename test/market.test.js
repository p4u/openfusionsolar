// REE market price cache (spec 3.3, AC6): parsing the recorded answer, storing past whole days once, never today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMarket, parseRee } from '../src/market.js';
import { Store } from '../src/db.js';

// Recorded 2026-11-20 from apidatos.ree.es for 2026-10-24..26 (holds the 25-hour 2026-10-25). Public data, no key.
const REE = fs.readFileSync(new URL('./fixtures/ree/2026-10-24_26.json', import.meta.url), 'utf8');
const ree = () => JSON.parse(REE);
const MADRID = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
const ofDay = (rows, day, kind) => rows.filter((r) => r.kind === kind && MADRID.format(r.ts) === day);
const at = (s) => Date.parse(s);

function fakeFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const step = queue.shift();
    if (!step) throw new Error('fakeFetch: no step left');
    if (step === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const body = typeof step.response === 'string' ? step.response : JSON.stringify(step.response);
    return new Response(body, { status: step.status });
  };
  return { fetch, calls };
}

function setup(steps, now, store = new Store(':memory:')) {
  const f = fakeFetch(steps);
  const logs = [];
  const market = createMarket({ store, fetch: f.fetch, now: () => at(now), log: (l) => logs.push(l) });
  return { market, store, logs, ...f };
}
const ok = (response = ree()) => ({ status: 200, response });
const AFTER = '2026-11-20T12:00:00+01:00';
const stored = (store) => store.marketPrices(0, at('2100-01-01T00:00:00Z'));

test('parseRee reads 24 pvpc and 24 spot values for a normal day in EUR/kWh', () => {
  const rows = parseRee(ree());
  const pvpc = ofDay(rows, '2026-10-24', 'pvpc');
  const spot = ofDay(rows, '2026-10-24', 'spot');
  assert.equal(pvpc.length, 24);
  assert.equal(spot.length, 24);
  const first = ree().included.find((s) => s.attributes.title === 'PVPC').attributes.values[0];
  assert.equal(first.datetime, '2026-10-24T00:00:00.000+02:00');
  assert.deepEqual(pvpc.find((r) => r.ts === at(first.datetime)), { ts: at(first.datetime), kind: 'pvpc', eur_kwh: first.value / 1000 });
  // spot comes in quarter hours: the hour is their mean
  const q = ree().included.find((s) => s.attributes.title === 'Precio mercado spot').attributes.values.slice(0, 4);
  const mean = q.reduce((s, v) => s + v.value, 0) / 4 / 1000;
  assert.ok(Math.abs(spot.find((r) => r.ts === at(first.datetime)).eur_kwh - mean) < 1e-6);
  assert.ok(rows.every((r) => r.ts % 3600e3 === 0 && Number.isFinite(r.eur_kwh)));
  assert.ok(rows.some((r) => r.eur_kwh < 0), 'negative prices are kept');
});

test('2026-10-25 holds 25 hourly values', () => {
  const rows = parseRee(ree());
  for (const kind of ['pvpc', 'spot']) {
    const day = ofDay(rows, '2026-10-25', kind);
    assert.equal(day.length, 25, kind);
    assert.equal(new Set(day.map((r) => r.ts)).size, 25);
    // 02:00 summer time and 02:00 winter time are two hours
    assert.ok(day.some((r) => r.ts === at('2026-10-25T02:00:00+02:00')) && day.some((r) => r.ts === at('2026-10-25T02:00:00+01:00')));
  }
  assert.equal(ofDay(rows, '2026-10-26', 'pvpc').length, 24);
});

test('a past complete day is stored once and a second request makes no network call', async () => {
  const t = setup([ok()], AFTER);
  const a = await t.market.hourly('2026-10-24', '2026-10-26');
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, 'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real'
    + '?start_date=2026-10-24T00:00&end_date=2026-10-26T23:59&time_trunc=hour');
  assert.equal(t.calls[0].method, 'GET');
  assert.equal(a.pvpc.size, 73);
  assert.equal(a.spot.size, 73);
  assert.equal(a.pvpc.get(at('2026-10-24T00:00:00+02:00')), 0.2282);
  assert.equal(stored(t.store).length, 146);
  const b = await t.market.hourly('2026-10-24', '2026-10-26');
  assert.equal(t.calls.length, 1);
  assert.deepEqual(b, a);
  const c = await t.market.hourly('2026-10-25', '2026-10-25');
  assert.equal(t.calls.length, 1);
  assert.equal(c.pvpc.size, 25);
});

test('today is fetched each time and never stored', async () => {
  const t = setup([ok(), ok()], '2026-10-25T12:00:00+01:00');
  const a = await t.market.hourly('2026-10-24', '2026-10-25');
  assert.equal(a.pvpc.size, 49);
  assert.deepEqual([...new Set(stored(t.store).map((r) => MADRID.format(r.ts)))], ['2026-10-24']);
  await t.market.hourly('2026-10-24', '2026-10-25');
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[1].url, /start_date=2026-10-25T00:00&end_date=2026-10-25T23:59/); // only the day not stored
  assert.deepEqual([...new Set(stored(t.store).map((r) => MADRID.format(r.ts)))], ['2026-10-24']);
});

test('a day with 22 values is not stored', async () => {
  const j = ree();
  const pvpc = j.included.find((s) => s.attributes.title === 'PVPC').attributes;
  pvpc.values = pvpc.values.filter((v) => !/^2026-10-24T0[01]:/.test(v.datetime));
  const t = setup([ok(j), ok(j)], AFTER);
  const a = await t.market.hourly('2026-10-24', '2026-10-24');
  assert.equal(a.pvpc.size, 22);
  assert.equal(a.spot.size, 24);
  assert.equal(stored(t.store).length, 0);
  await t.market.hourly('2026-10-24', '2026-10-24');
  assert.equal(t.calls.length, 2);
});

test('a 70-day range makes 3 requests of at most 31 days', async () => {
  const empty = { data: {}, included: [] };
  const t = setup([ok(empty), ok(empty), ok(empty)], AFTER);
  const r = await t.market.hourly('2026-01-01', '2026-03-11');
  assert.deepEqual(r, { pvpc: new Map(), spot: new Map() });
  const spans = t.calls.map((c) => new URL(c.url).searchParams).map((p) => [p.get('start_date'), p.get('end_date')]);
  assert.deepEqual(spans, [['2026-01-01T00:00', '2026-01-31T23:59'], ['2026-02-01T00:00', '2026-03-03T23:59'], ['2026-03-04T00:00', '2026-03-11T23:59']]);
});

test('timeout, 500, non-JSON and oversize answer unavailable ree', async () => {
  const big = JSON.stringify({ included: [], pad: 'x'.repeat(1024 * 1024) });
  for (const step of ['timeout', { status: 500, response: 'oops' }, { status: 200, response: '<html>' }, { status: 200, response: big },
    { status: 200, response: { included: [{ attributes: { title: 'PVPC', values: [{ value: 'x', datetime: 'y' }] } }] } }]) {
    const t = setup([step], AFTER);
    assert.deepEqual(await t.market.hourly('2026-10-24', '2026-10-24'), { unavailable: 'ree' });
    assert.equal(stored(t.store).length, 0);
    assert.doesNotMatch(t.logs.join('\n'), /html|oops/);
  }
});

test('a bad day range is a programming error', async () => {
  const t = setup([], AFTER);
  await assert.rejects(t.market.hourly('2026-10-25', '2026-10-24'), TypeError);
  await assert.rejects(t.market.hourly('2026-10-24&x=1', '2026-10-25'), TypeError);
  assert.equal(t.calls.length, 0);
});

test('market_prices keeps one row per hour and kind', () => {
  const store = new Store(':memory:');
  const ts = at('2026-10-24T00:00:00+02:00');
  store.saveMarketDay([{ ts, kind: 'pvpc', eur_kwh: 0.1 }, { ts, kind: 'spot', eur_kwh: -0.002 }]);
  store.saveMarketDay([{ ts, kind: 'pvpc', eur_kwh: 0.2 }]);
  assert.deepEqual(store.marketPrices(ts, ts + 1).map((r) => ({ ...r })), [{ ts, kind: 'pvpc', eur_kwh: 0.2 }, { ts, kind: 'spot', eur_kwh: -0.002 }]);
  assert.deepEqual(store.marketPrices(ts + 1, ts + 3600e3), []);
  assert.throws(() => store.saveMarketDay([{ ts: ts + 3600e3, kind: 'pvpc', eur_kwh: 0.3 }, { ts, kind: 'pvpc', eur_kwh: null }]));
  assert.equal(store.marketPrices(ts, ts + 7200e3).length, 2, 'a failed day leaves nothing behind');
});
