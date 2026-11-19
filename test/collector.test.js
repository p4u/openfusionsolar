import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, toK, dayBounds, localDay } from '../src/collector.js';
import { Store } from '../src/db.js';

test('Huawei no-data markers become null, real zeros stay', () => {
  assert.equal(num('--'), null);
  assert.equal(num(1.7976931348623157e308), null);
  assert.equal(num('-'), null);
  assert.equal(num(undefined), null);
  assert.equal(num('0.000'), 0);
  assert.equal(num('-0.422'), -0.422);
});

test('W/Wh are scaled to kW/kWh, other units untouched', () => {
  assert.equal(toK(1523, 'W'), 1.523);
  assert.equal(toK(2.5, 'kW'), 2.5);
  assert.equal(toK(22, '%'), 22);
  assert.equal(toK(null, 'W'), null);
});

test('day bounds are local midnight to midnight and round-trip', () => {
  const [a, b] = dayBounds('2026-11-18');
  assert.equal(localDay(a), '2026-11-18');
  assert.equal(localDay(b), '2026-11-19');
  assert.equal(new Date(a).getHours(), 0);
});

test('samples upsert keeps known values when a later fetch has gaps', () => {
  const s = new Store(':memory:');
  s.saveSample(1000, { load_kw: 0.4, soc: 20 });
  s.saveSample(1000, { load_kw: null, soc: 21, grid_kw: -0.1 });
  assert.deepEqual({ ...s.samples(0, 2000)[0] }, {
    ts: 1000, pv_kw: null, inverter_kw: null, yield_kwh: null, load_kw: 0.4, self_use_kw: null, grid_kw: -0.1, battery_kw: null, soc: 21,
  });
  assert.equal(s.saveRaw('x', { a: 1 }, { v: 1 }), true);
  assert.equal(s.saveRaw('x', { a: 1 }, { v: 1 }), false); // identical response is not stored twice
  assert.equal(s.saveRaw('x', { a: 1 }, { v: 2 }), true);
});

test('shiftDay walks calendar days across DST changes', async () => {
  const { shiftDay } = await import('../src/collector.js');
  assert.equal(shiftDay('2026-03-30', -1), '2026-03-29'); // spring forward in Europe
  assert.equal(shiftDay('2026-03-29', -1), '2026-03-28');
  assert.equal(shiftDay('2026-10-26', -1), '2026-10-25'); // fall back
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
});

test('every tick syncs current alarms and fetches history when an active alarm disappears', async () => {
  const { Collector } = await import('../src/collector.js');
  const store = new Store(':memory:');
  const calls = [];
  const cut = { csn: 7, alarmName: 'Grid loss', severity: 1, occurUtc: 1000, cleared: false };
  let current = [cut];
  let history = [];
  const client = {
    energyFlow: async () => ({}),
    energyBalance: async () => ({ data: { xAxis: [] } }),
    alarms: async (st, { dataType, pageNo, pageSize }) => {
      calls.push(`${dataType}:${pageNo}:${pageSize}`);
      const hits = dataType === 'CURRENT' ? current : history;
      return { data: { hits, totalCount: hits.length } };
    },
  };
  const c = new Collector({ client, store, log: () => {} });
  c.station = { dn: 'st' };
  c.devices = [];
  await c.tick(); // first tick runs the full sync, which already includes CURRENT (no second fetch)
  assert.deepEqual(calls, ['CURRENT:1:100', 'HISTORY:1:100']);
  assert.equal(store.activeAlarms().length, 1);
  calls.length = 0;
  await c.tick();
  assert.deepEqual(calls, ['CURRENT:1:100']);
  calls.length = 0;
  current = [];
  history = [{ ...cut, cleared: true, clearUtc: 5000 }];
  await c.tick(); // the stored active alarm is gone from CURRENT: its clear time is in HISTORY
  assert.deepEqual(calls, ['CURRENT:1:100', 'HISTORY:1:100']);
  assert.equal(store.activeAlarms().length, 0);
  calls.length = 0;
  await c.tick();
  assert.deepEqual(calls, ['CURRENT:1:100']);
});
