process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../public/js/i18n.js';
import { shares, deltaText, energyBars, powerAllowed } from '../public/js/views/energy-model.js';

setLang('en');

test('shares sum to 100 and handle zero totals', () => {
  const s = shares({ pv_kwh: 30, load_kwh: 20, import_kwh: 7, export_kwh: 10 });
  assert.equal(s.consumption.solar + s.consumption.grid, 100);
  assert.equal(s.solar.home + s.solar.sold, 100);
  assert.deepEqual(s.consumption, { solar: 65, grid: 35 });
  assert.deepEqual(s.solar, { home: 67, sold: 33 });
  const rounding = shares({ pv_kwh: 3, load_kwh: 3, import_kwh: 1, export_kwh: 1 });
  assert.equal(rounding.consumption.solar + rounding.consumption.grid, 100);
  const nothing = { consumption: { solar: null, grid: null }, solar: { home: null, sold: null } };
  assert.deepEqual(shares({ pv_kwh: 0, load_kwh: 0, import_kwh: 0, export_kwh: 0 }), nothing);
  assert.deepEqual(shares(null), nothing);
  assert.equal(shares({ load_kwh: 5, import_kwh: 9 }).consumption.grid, 100, 'bought above consumption is clamped');
});

test('sold bars are negative and home from solar is load minus bought', () => {
  const bars = energyBars([
    { pv_kwh: 10, load_kwh: 8, import_kwh: 3, export_kwh: 4 },
    { pv_kwh: 0, load_kwh: 5, import_kwh: 5, export_kwh: 0 },
    { pv_kwh: null, load_kwh: null, import_kwh: null, export_kwh: null },
  ]);
  assert.deepEqual(bars.home_solar, [5, 0, null]);
  assert.deepEqual(bars.bought, [3, 5, null]);
  assert.deepEqual(bars.sold, [-4, 0, null]);
  assert.ok(Object.is(bars.sold[1], 0), 'no negative zero');
  assert.deepEqual(bars.produced, [10, 0, null]);
});

test('delta says not comparable with the reason', () => {
  assert.equal(deltaText(10, null), null);
  const base = { value: 8, comparable: true, reason: null, label: 'October 2025' };
  assert.match(deltaText(10, base), /^\+25\s?% vs October 2025$/);
  assert.match(deltaText(10, { ...base, comparable: false, reason: 'lowCoverage' }), /^Not comparable: .*missing days/);
  assert.match(deltaText(10, { ...base, comparable: false, reason: 'beforeFirstDay' }), /^Not comparable: .*first day/);
  assert.match(deltaText(10, { ...base, value: 0 }), /Nothing to compare/);
});

test('power mode is refused for ranges over 31 days', () => {
  for (const n of [1, 2, 7, 31]) assert.equal(powerAllowed(n), true, `${n} days`);
  for (const n of [32, 45, 120, 731]) assert.equal(powerAllowed(n), false, `${n} days`);
});
