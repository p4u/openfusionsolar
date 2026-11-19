process.env.TZ = 'Europe/Madrid';
// Incidents view helpers, run under Node: hours per month across month boundaries, kind filter and grouping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayStart } from '../public/js/format.js';
import { groupNetwork } from '../public/js/incidents.js';
import { hoursPerMonth, filterKinds } from '../public/js/views/incidents-model.js';

const H = 3600e3;
const ev = (kind, start, end, extra = {}) => ({ kind, start, end, ongoing: false, names: [], ...extra });

test('hours per month split an event crossing a month boundary', () => {
  const first = dayStart('2026-04-01'); // 22:00 UTC on 31 March
  const rows = hoursPerMonth([ev('gridCut', first - 3 * H, first + 2 * H)]);
  assert.deepEqual(rows.map((r) => r.month), ['2026-03', '2026-04']);
  assert.equal(rows[0].hours.gridCut, 3);
  assert.equal(rows[1].hours.gridCut, 2);
});

test('hours per month cross a year end and fill the empty months', () => {
  const rows = hoursPerMonth([ev('network', dayStart('2025-11-10'), dayStart('2025-11-10') + H), ev('network', dayStart('2026-01-05'), dayStart('2026-01-05') + 2 * H)]);
  assert.deepEqual(rows.map((r) => r.month), ['2025-11', '2025-12', '2026-01']);
  assert.deepEqual(rows[1].hours, {});
  const split = hoursPerMonth([ev('noProduction', dayStart('2026-01-01') - H, dayStart('2026-01-01') + H)]);
  assert.deepEqual(split.map((r) => r.month), ['2025-12', '2026-01']);
});

test('hours per month honour the kind filter and an empty list', () => {
  const day = dayStart('2026-05-04');
  const events = [ev('gridCut', day, day + 2 * H), ev('network', day, day + H)];
  assert.deepEqual(hoursPerMonth(events, ['network'])[0].hours, { network: 1 });
  assert.deepEqual(hoursPerMonth(events, ['batteryLow']), []);
  assert.deepEqual(hoursPerMonth([]), []);
});

test('the kind filter keeps a day of internet losses in one group', () => {
  const day = dayStart('2026-05-04');
  const events = [
    ev('network', day + H, day + 2 * H, { names: ['Network Connection Error'] }),
    ev('gridCut', day + 3 * H, day + 4 * H),
    ev('network', day + 5 * H, day + 7 * H),
  ];
  const groups = (list) => groupNetwork(list).filter((e) => e.kind === 'networkDay');
  assert.deepEqual(groups(filterKinds(events, ['network'])), groups(events));
  assert.equal(groups(filterKinds(events, ['network']))[0].n, 2);
  assert.deepEqual(filterKinds(events, ['gridCut']).map((e) => e.kind), ['gridCut']);
  assert.equal(filterKinds(events, []).length, 3);
  assert.equal(filterKinds(events, null).length, 3);
});
