process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline, flow, autonomyHours, STALE_MS } from '../public/js/views/now-model.js';
import { fmtTime } from '../public/js/format.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0);
const rt = { pv_kw: 2, load_kw: 1, grid_kw: 0, battery_kw: 0, soc: 80 };
const status = (o = {}) => ({ lastSampleTs: NOW - 60e3, realtime: rt, battery: { reservePct: 30 }, ...o });

test('fine when data is fresh and no alarm', () => {
  const h = headline(status(), [], NOW);
  assert.deepEqual([h.state, h.key], ['ok', 'now.head.ok']);
  // an ended cut and an internet loss do not turn the headline
  const past = [{ kind: 'gridCut', start: NOW - 5 * 3600e3, end: NOW - 4 * 3600e3 }, { kind: 'network', ongoing: true, start: NOW - 1e6, end: NOW }];
  assert.equal(headline(status(), past, NOW).state, 'ok');
});

test('stale after 20 minutes names the time', () => {
  const last = NOW - STALE_MS - 60e3;
  const h = headline(status({ lastSampleTs: last }), [], NOW);
  assert.deepEqual([h.state, h.key], ['warn', 'now.head.stale']);
  assert.equal(h.vars.time, fmtTime(last));
  assert.equal(headline(status({ lastSampleTs: NOW - STALE_MS }), [], NOW).state, 'ok');
});

test('waiting when there has never been data', () => {
  const h = headline({ lastSampleTs: null, realtime: null, battery: {} }, [], NOW);
  assert.deepEqual([h.state, h.key], ['waiting', 'now.head.waiting']);
});

test('below reserve and recharging is info, not recharging is warn', () => {
  const low = (battery_kw) => status({ realtime: { ...rt, soc: 20, battery_kw } });
  const a = headline(low(1.5), [], NOW);
  assert.deepEqual([a.state, a.key, a.vars], ['info', 'now.head.recharging', { soc: 20, reserve: 30 }]);
  assert.deepEqual([headline(low(0), [], NOW).state, headline(low(-0.4), [], NOW).key], ['warn', 'now.head.notRecharging']);
  assert.equal(headline(status({ battery: {} , realtime: { ...rt, soc: 5 } }), [], NOW).state, 'ok'); // no reserve known
});

test('an ongoing cut outranks a stale reading', () => {
  const cut = [{ kind: 'gridCut', ongoing: true, start: NOW - 1e6, end: NOW }];
  assert.equal(headline(status({ lastSampleTs: NOW - 3600e3 }), cut, NOW).key, 'now.head.cut');
});

test('flow links follow the signs of grid and battery', () => {
  const pairs = (r) => flow(r).links.map((l) => `${l.from}>${l.to}`).sort();
  assert.deepEqual(pairs({ pv_kw: 0, load_kw: 1, grid_kw: 1, battery_kw: 0 }), ['grid>home']);
  assert.deepEqual(pairs({ pv_kw: 3, load_kw: 1, grid_kw: -2, battery_kw: 0 }), ['pv>grid', 'pv>home']);
  assert.deepEqual(pairs({ pv_kw: 3, load_kw: 1, grid_kw: 0, battery_kw: 2 }), ['pv>bat', 'pv>home']);
  assert.deepEqual(pairs({ pv_kw: 0, load_kw: 1, grid_kw: 0, battery_kw: -1 }), ['bat>home']);
  assert.deepEqual(pairs({ pv_kw: 0, load_kw: 0.5, grid_kw: 2, battery_kw: 1.5 }), ['grid>bat', 'grid>home']);
  assert.deepEqual(pairs(null), []);
});

test('autonomy is null without capacity', () => {
  assert.equal(autonomyHours(50, {}, 1), null);
  assert.equal(autonomyHours(null, { capacityKwh: 10 }, 1), null);
  assert.equal(autonomyHours(50, { capacityKwh: 10 }, 1), 5);
  assert.equal(autonomyHours(50, { capacityKwh: 10, minPct: 10 }, 2), 2); // the floor is not usable
  assert.equal(autonomyHours(5, { capacityKwh: 10, minPct: 10 }, 1), 0);
  assert.equal(autonomyHours(100, { capacityKwh: 10 }, 0), 10 / 0.15); // a tiny load is floored
});
