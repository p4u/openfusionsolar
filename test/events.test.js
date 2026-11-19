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

test('an hour or more without home readings is a noData period; short gaps and time before the first reading are not', async () => {
  const { noData } = await import('../src/events.js');
  const m = 60e3;
  const slots = (a, b, extra = {}) => {
    const out = [];
    for (let ts = a * m; ts < b * m; ts += 5 * m) out.push({ ts, load_kw: 0.5, ...extra });
    return out;
  };
  // readings 0-60, a 55-minute hole, 115-200, a 2-hour hole (slots there carry a null load), 320-400
  const samples = [...slots(0, 60), ...slots(115, 200), ...slots(200, 320, { load_kw: null }), ...slots(320, 400)];
  const gaps = noData(samples, { from: 0, to: 600 * m, since: 0, now: 410 * m });
  assert.deepEqual(gaps.map((g) => [g.start / m, g.end / m, g.ongoing]), [[200, 320, false]]);
  // the trailing gap counts once it lasts an hour, and is ongoing while it reaches now
  const tail = noData(samples, { from: 0, to: 600 * m, since: 0, now: 470 * m });
  assert.deepEqual(tail.map((g) => [g.start / m, g.end / m, g.ongoing]), [[200, 320, false], [400, 470, true]]);
  // a range starting before the first stored reading counts from that reading
  assert.deepEqual(noData(slots(300, 400), { from: 0, to: 400 * m, since: 300 * m, now: 1e9 }), []);
  // a range in the past ends at its own end, not at now
  const past = noData(slots(0, 100), { from: 0, to: 200 * m, since: 0, now: 1e9 });
  assert.deepEqual(past.map((g) => [g.start / m, g.end / m, g.ongoing]), [[100, 200, false]]);
  assert.deepEqual(noData([], { from: 0, to: 200 * m, since: null, now: 1e9 }), [], 'no reading ever: nothing to compare with');
});

test('buildEvents adds noData only with a range, and says whether an internet loss was filled in afterwards', () => {
  const m = 60e3;
  const slots = (a, b) => {
    const out = [];
    for (let ts = a * m; ts < b * m; ts += 5 * m) out.push({ ts, load_kw: 0.4 });
    return out;
  };
  const alarms = [
    { name: 'Network Connection Error', occur_utc: 10 * m, clear_utc: 40 * m }, // readings filled in
    { name: 'Network Connection Error', occur_utc: 100 * m, clear_utc: 190 * m }, // inside the hole
  ];
  const samples = [...slots(0, 100), ...slots(190, 300)];
  assert.equal(buildEvents(alarms, samples, 300 * m).some((e) => e.kind === 'noData'), false);
  const ev = buildEvents(alarms, samples, 300 * m, { from: 0, to: 300 * m, since: 0 });
  assert.deepEqual(ev.filter((e) => e.kind === 'noData').map((e) => [e.start / m, e.end / m]), [[100, 190]]);
  const net = ev.filter((e) => e.kind === 'network').sort((a, b) => a.start - b.start);
  assert.deepEqual(net.map((e) => e.recovered), [true, false]);
});
