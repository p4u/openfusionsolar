process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kwhPerKwp, peak, stringPairs, stringPower, yoyMonths, stoppedHours } from '../public/js/views/panels-model.js';

const sig = (id, unit) => ({ id, unit, name: `s${id}` });

test('kWh per kWp is null without capacity', () => {
  assert.equal(kwhPerKwp(10, 5), 2);
  assert.equal(kwhPerKwp(10, null), null);
  assert.equal(kwhPerKwp(null, 5), null);
});

test('peak skips gaps and reports when', () => {
  assert.deepEqual(peak([[1, 2], [2, null], [3, 5], [4, 4]]), { kw: 5, ts: 3 });
  assert.equal(peak([[1, null]]), null);
});

test('string pairs are found for any count and ignore unmatched ids', () => {
  const two = [sig(31001, 'V'), sig(31002, 'A'), sig(31004, 'V'), sig(31005, 'A'), sig(30011, '℃')];
  assert.deepEqual(stringPairs(two).map((p) => [p.n, p.voltage, p.current]), [[1, 31001, 31002], [2, 31004, 31005]]);
  const four = [...two, sig(31007, 'V'), sig(31008, 'A'), sig(31010, 'V'), sig(31011, 'A')];
  assert.equal(stringPairs(four).length, 4);
  // voltage without current, current with the wrong unit, a voltage off the 3k grid
  assert.deepEqual(stringPairs([sig(31001, 'V'), sig(31004, 'V'), sig(31005, 'W'), sig(31003, 'V')]), []);
  assert.deepEqual(stringPairs([]), []);
});

test('string power is V x I in kW', () => {
  assert.equal(stringPower(400, 5), 2);
  assert.equal(stringPower(null, 5), null);
});

test('year on year leaves missing months null', () => {
  const rows = yoyMonths([{ key: '2026-01', pv_kwh: 10 }, { key: '2026-03', pv_kwh: null }], [{ key: '2025-03', pv_kwh: 7 }]);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], { month: 1, thisYear: 10, lastYear: null });
  assert.deepEqual(rows[2], { month: 3, thisYear: null, lastYear: 7 });
  assert.equal(rows[11].thisYear, null);
});

test('stopped hours clip events to the range and run open ones to now', () => {
  const H = 3600e3;
  const ev = [{ kind: 'noProduction', start: 0, end: 3 * H }, { kind: 'noProduction', start: 9 * H, end: null }, { kind: 'gridCut', start: 0, end: 99 * H }];
  assert.equal(stoppedHours(ev, 1 * H, 10 * H, 12 * H), 2 + 1);
});

test('year on year compares a year in progress with the same days of the year before', async () => {
  const { yoySpan } = await import('../public/js/views/panels-model.js');
  assert.deepEqual(yoySpan(2026, '2026-11-19'), { thisTo: '2026-11-19', lastTo: '2025-11-19', partial: true });
  assert.deepEqual(yoySpan(2025, '2026-11-19'), { thisTo: '2025-12-31', lastTo: '2024-12-31', partial: false });
  assert.equal(yoySpan(2028, '2028-02-29').lastTo, '2027-02-28');
});
