import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildEvents, noProduction } from '../src/events.js';

test('Huawei alarm names map to plain kinds', () => {
  assert.equal(classify('Network Connection Error'), 'network');
  assert.equal(classify('Grid Undervoltage'), 'gridCut');
  assert.equal(classify('On-Grid/Off-Grid Controller Error'), 'gridCut');
  assert.equal(classify('Off-Grid Output Overload'), 'overload');
  assert.equal(classify('The remaining dischargeable capacity of the battery is low'), 'batteryLow');
  assert.equal(classify('Something new'), 'other');
});

test('overlapping and close alarms of a kind merge; battery coverage is detected', () => {
  const m = 60e3;
  const alarms = [
    { name: 'Grid Undervoltage', occur_utc: 0, clear_utc: 10 * m },
    { name: 'Grid Underfrequency', occur_utc: 5 * m, clear_utc: 30 * m },
    { name: 'Grid Undervoltage', occur_utc: 35 * m, clear_utc: 40 * m }, // 5 min gap: same cut
    { name: 'Grid Underfrequency', occur_utc: 60 * m, clear_utc: 61 * m }, // 20 min later: still the same cut
    { name: 'Network Connection Error', occur_utc: 100 * m, clear_utc: null }, // ongoing
    { name: 'Network Connection Error', occur_utc: 150 * m, clear_utc: 152 * m }, // too short to matter
  ];
  const samples = [{ ts: 15 * m, battery_kw: -0.4 }];
  const ev = buildEvents(alarms, samples, 200 * m);
  assert.equal(ev.length, 2);
  const cut = ev.find((e) => e.kind === 'gridCut');
  assert.deepEqual([cut.start, cut.end, cut.batteryCovered], [0, 61 * m, true]);
  const net = ev.find((e) => e.kind === 'network');
  assert.deepEqual([net.ongoing, net.end], [true, 200 * m]);
});

test('panels stuck at exactly 0 kW for an hour of sun hours is reported, a cloudy trickle is not', () => {
  const day = (h, mi) => new Date(2026, 10, 18, h, mi).getTime();
  const slots = (h0, h1, pv) => {
    const out = [];
    for (let ts = day(h0, 0); ts < day(h1, 0); ts += 5 * 60e3) out.push({ ts, pv_kw: pv });
    return out;
  };
  const stuck = noProduction([...slots(9, 11, 1.2), ...slots(11, 17, 0)]);
  assert.equal(stuck.length, 1);
  assert.equal(new Date(stuck[0].start).getHours(), 11);
  assert.equal(new Date(stuck[0].end).getHours(), 15);
  assert.equal(noProduction(slots(9, 17, 0.03)).length, 0);
  assert.equal(noProduction(slots(10, 10.5, 0)).length, 0);
});

test('a cut with an overload inside is reported as covered until the overload', () => {
  const m = 60e3;
  const ev = buildEvents([
    { name: 'Grid Undervoltage', occur_utc: 0, clear_utc: 60 * m },
    { name: 'Off-Grid Output Overload', occur_utc: 9 * m, clear_utc: 19 * m },
  ], [{ ts: 5 * m, battery_kw: -1 }], 100 * m);
  assert.equal(ev.find((e) => e.kind === 'gridCut').batteryCovered, 'overload');
});
