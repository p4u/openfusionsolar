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
