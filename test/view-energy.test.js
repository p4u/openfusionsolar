process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../public/js/i18n.js';
import { shares, percents, ofPeriod, deltaText, energyBars, powerAllowed } from '../public/js/views/energy-model.js';

setLang('en');

test('shares sum to 100 and handle zero totals', () => {
  // 30 produced, 10 sold, 20 used, 7 bought: the home took 13 of the sun, so 7 of the sun went to the battery
  const s = shares({ pv_kwh: 30, load_kwh: 20, import_kwh: 7, export_kwh: 10 });
  assert.equal(s.consumption.solar + s.consumption.grid + s.consumption.battery, 100);
  assert.equal(s.solar.home + s.solar.battery + s.solar.sold, 100);
  assert.deepEqual(s.consumption, { solar: 65, grid: 35, battery: 0 });
  assert.deepEqual(s.solar, { home: 44, battery: 23, sold: 33 });
  const rounding = shares({ pv_kwh: 3, load_kwh: 3, import_kwh: 1, export_kwh: 1 });
  assert.equal(rounding.consumption.solar + rounding.consumption.grid + rounding.consumption.battery, 100);
  const nothing = { consumption: { solar: null, grid: null, battery: null }, solar: { home: null, battery: null, sold: null } };
  assert.deepEqual(shares({ pv_kwh: 0, load_kwh: 0, import_kwh: 0, export_kwh: 0 }), nothing);
  assert.deepEqual(shares(null), nothing);
  assert.equal(shares({ load_kwh: 5, import_kwh: 9 }).consumption.grid, 100, 'bought above consumption is clamped');
  assert.deepEqual(percents([1, 1, 1]), [34, 33, 33]);
});

test('yesterday: the sun went to the battery and the home ran on the grid, never "100 % at home"', () => {
  // the ruling's figures: no self-use, nothing sold
  const r = shares({ pv_kwh: 1.5, load_kwh: 11.8, import_kwh: 11.8, self_use_kwh: 0, export_kwh: 0 });
  assert.deepEqual(r.solar, { home: 0, battery: 100, sold: 0 });
  assert.deepEqual(r.consumption, { solar: 0, grid: 100, battery: 0 });
  // the stored day (Huawei self-use includes what went into the battery): grid charged the rest of the battery
  const d = shares({ pv_kwh: 1.48, load_kwh: 11.79, import_kwh: 11.78, export_kwh: 0, self_use_kwh: 1.48, charge_kwh: 2.42, discharge_kwh: 0.95 });
  assert.deepEqual(d.solar, { home: 0, battery: 100, sold: 0 });
  assert.deepEqual(d.consumption, { solar: 0, grid: 92, battery: 8 });
  // a sunny day: 8 kWh charged, 6 given back in the evening
  const sunny = shares({ pv_kwh: 30, load_kwh: 20, import_kwh: 2, export_kwh: 10, self_use_kwh: 20, charge_kwh: 8, discharge_kwh: 6 });
  assert.deepEqual(sunny.solar, { home: 40, battery: 27, sold: 33 });
  assert.deepEqual(sunny.consumption, { solar: 60, grid: 10, battery: 30 });
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

test('the power caption names the highest plotted mean, not an average of the period', async () => {
  const { default: dict } = await import('../public/js/i18n/energy.js');
  for (const lang of ['en', 'ca']) {
    const s = dict[lang]['energy.caption.power'];
    assert.match(s, /\{bucket\}/, lang);
    assert.doesNotMatch(s, /averaged up to|mitjana de \{pv\}/, lang);
    assert.ok(dict[lang]['energy.cmp.powerLine'] && dict[lang]['energy.provisional'], lang);
  }
});

test('catalan comparisons use the right contraction', () => {
  setLang('ca');
  assert.match(deltaText(10, { value: 8, comparable: true, label: '17 de nov. del 2026' }), /respecte del 17 de nov\./);
  assert.equal(ofPeriod('octubre del 2025'), 'd’octubre del 2025');
  assert.equal(ofPeriod('març del 2025'), 'de març del 2025');
  assert.equal(ofPeriod('2025'), 'del 2025');
  setLang('en');
  assert.equal(ofPeriod('2025'), '2025');
});
