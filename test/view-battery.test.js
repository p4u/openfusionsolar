process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycles, roundTrip, daysAtMin, hoursBelow, clampFrom, seriesBucket, energyBucket } from '../public/js/views/battery-model.js';

test('round-trip efficiency is null under 7 days and without charge', () => {
  assert.equal(roundTrip(10, 8, 6), null);
  assert.equal(roundTrip(10, 8, 7), 80);
  assert.equal(roundTrip(0, 8, 30), null);
  assert.equal(roundTrip(null, 8, 30), null);
});

test('cycles are null without capacity', () => {
  assert.equal(cycles(20, 10), 2);
  assert.equal(cycles(20, null), null);
  assert.equal(cycles(20, 0), null);
  assert.equal(cycles(null, 10), null);
});

test('days at minimum counts days within one point of the end-of-discharge level', () => {
  assert.equal(daysAtMin([10, 11, 12, null, 50], 10), 2);
  assert.equal(daysAtMin([null], 10), null);
  assert.equal(daysAtMin([10], null), null);
});

test('hours below reserve counts only present buckets', () => {
  assert.equal(hoursBelow([10, null, null, 50, 12], 20, 900e3), 0.5);
  assert.equal(hoursBelow([null, null], 20, 900e3), null);
  assert.equal(hoursBelow([10], null, 900e3), null);
});

test('series are clamped to 750 days and to the first reading', () => {
  assert.deepEqual(clampFrom('2024-01-01', '2026-11-19', null), { from: '2024-10-31', clamped: true, empty: false });
  assert.equal(clampFrom('2026-11-01', '2026-11-19', '2026-11-10').from, '2026-11-10');
  assert.equal(clampFrom('2026-11-01', '2026-11-19', '2026-11-01').clamped, false);
  assert.equal(clampFrom('2026-11-01', '2026-11-05', '2026-11-10').empty, true);
});

test('bucket choice honours a legal request and falls back to auto', () => {
  assert.equal(seriesBucket({ days: 3, b: '5m' }), '15m');
  assert.equal(seriesBucket({ days: 3, b: '1h' }), '1h');
  assert.equal(energyBucket({ days: 400, b: 'auto' }), '1mo');
});

test('the reserve only counts and draws from the day it was set', async () => {
  const { reserveMarks } = await import('../public/js/views/battery-model.js');
  const H = 3600e3;
  const t = [0, H, 2 * H, 3 * H];
  const soc = [10, 10, 10, 90];
  assert.equal(hoursBelow(soc, 50, H), 3);
  assert.equal(hoursBelow(soc, 50, H, t, 2 * H), 1, 'buckets before the reserve existed are not time below it');
  assert.equal(hoursBelow(soc, 50, H, t, 10 * H), null, 'a range before the reserve has nothing to count');
  assert.deepEqual(reserveMarks(50, null, t), { mode: 'all' });
  assert.deepEqual(reserveMarks(50, 0, t), { mode: 'all' });
  assert.deepEqual(reserveMarks(50, 10 * H, t), { mode: 'none' });
  assert.deepEqual(reserveMarks(50, 2 * H, t), { mode: 'part', data: [[0, null], [H, null], [2 * H, 50], [3 * H, 50]] });
  assert.deepEqual(reserveMarks(null, 0, t), { mode: 'none' });
});

test('the time estimate aims at the grid cutoff when the grid charges, at the end of charge when the sun does', async () => {
  const { chargeEta } = await import('../public/js/views/battery-model.js');
  const b = { capacityKwh: 10, minPct: 10, gridChargeCutoffPct: 50 };
  // the round-3 case: 43 %, 1 kW from the grid at night, cutoff 50 %: 0.7 kWh, about 42 minutes, never "full"
  const grid = chargeEta({ soc: 43, battery_kw: 1, grid_kw: 1.4, pv_kw: 0, load_kw: 0.4 }, b);
  assert.equal(grid.kind, 'grid');
  assert.equal(grid.target, 50);
  assert.ok(Math.abs(grid.hours - 0.7) < 1e-9);
  // the sun covers the charge: up to the end of charge, 100 % when unknown, or the level FusionSolar reports
  const sunRt = { soc: 43, battery_kw: 1, grid_kw: -0.5, pv_kw: 2.5, load_kw: 1 };
  assert.deepEqual([chargeEta(sunRt, b).kind, chargeEta(sunRt, b).target], ['sun', 100]);
  assert.equal(chargeEta(sunRt, { ...b, endOfChargePct: 90 }).target, 90);
  // giving power: down to the minimum charge
  const give = chargeEta({ soc: 30, battery_kw: -2, grid_kw: 0, pv_kw: 0, load_kw: 2 }, b);
  assert.deepEqual([give.kind, give.target, give.hours], ['min', 10, 1]);
  // already at the cutoff, idle, unknown capacity, or more than two days: nothing to say
  assert.equal(chargeEta({ soc: 50, battery_kw: 1, grid_kw: 1.2, pv_kw: 0 }, b), null);
  assert.equal(chargeEta({ soc: 43, battery_kw: 0.01 }, b), null);
  assert.equal(chargeEta({ soc: 43, battery_kw: 1 }, { gridChargeCutoffPct: 50 }), null);
  assert.equal(chargeEta({ soc: 11, battery_kw: -0.06, grid_kw: 0, pv_kw: 0 }, { capacityKwh: 1000, minPct: 10 }), null);
  // grid charging with an unknown cutoff falls back to the end of charge
  assert.equal(chargeEta({ soc: 43, battery_kw: 1, grid_kw: 1.4, pv_kw: 0 }, { capacityKwh: 10 }).kind, 'sun');
});
