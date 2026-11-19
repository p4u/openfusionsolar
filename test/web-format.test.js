process.env.TZ = 'Europe/Madrid';
// Browser formatters and incident texts, run under Node: plant time zone, locale, unknowns, grouping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, setLang } from '../public/js/i18n.js';
import core from '../public/js/i18n/core.js';
import * as f from '../public/js/format.js';
import { eventTitle, eventItem, summarize, groupNetwork } from '../public/js/incidents.js';

register(core);
const NB = '\u00a0';
const H = 3600e3;

test('formatters use the plant time zone and the language locale', () => {
  setLang('en');
  const ts = Date.UTC(2026, 6, 1, 12, 5); // 14:05 in Madrid (summer)
  f.setTimeZone('Europe/Madrid');
  assert.equal(f.fmtTime(ts), '14:05');
  f.setTimeZone('UTC');
  assert.equal(f.fmtTime(ts), '12:05');
  f.setTimeZone('Not/AZone');
  assert.equal(f.fmtTime(ts), '14:05', 'an invalid zone falls back to the browser zone');
  f.setTimeZone('Europe/Madrid');
  assert.equal(f.fmtDate('2026-10-03'), '3 Oct');
  assert.equal(f.fmtMonth('2026-10'), 'October 2026');
  assert.equal(f.dayOf(Date.UTC(2026, 9, 24, 22, 30)), '2026-10-25');
  assert.equal(f.dayStart('2026-10-25'), Date.UTC(2026, 9, 24, 22));
  assert.equal(f.dayStart('2026-10-26') - f.dayStart('2026-10-25'), 25 * H, 'DST day has 25 hours');
  setLang('ca');
  assert.equal(f.fmtMonth('2026-10'), 'Octubre del 2026');
  assert.equal(f.kw(2.5), `2,50${NB}kW`);
  assert.equal(f.pct(61.6), `62${NB}%`);
});

test('null values read as unknown', () => {
  for (const fn of [f.kw, f.kwh, f.eur, f.pct, f.fmtTime, f.fmtDate, f.fmtDateTime, f.duration]) assert.equal(fn(null), '–');
});

test('delta compares with the previous value and refuses a zero base', () => {
  setLang('en');
  assert.deepEqual(f.delta(112, 100), { pct: 12, text: `+12${NB}%` });
  assert.deepEqual(f.delta(95, 100), { pct: -5, text: `-5${NB}%` });
  assert.deepEqual(f.delta(5, 0), { pct: null, text: '–' });
  assert.deepEqual(f.delta(null, 4), { pct: null, text: '–' });
});

test('duration picks minutes, hours or days', () => {
  setLang('en');
  assert.equal(f.duration(20e3), '1 min');
  assert.equal(f.duration(42 * 60e3), '42 min');
  assert.equal(f.duration(1.5 * H), '1.5 h');
  assert.equal(f.duration(60 * H), '2.5 days');
});

test('incidents: titles have no em dash, internet losses group per plant day', () => {
  setLang('en');
  f.setTimeZone('Europe/Madrid');
  const day = f.dayStart('2026-10-10');
  const cut = { kind: 'gridCut', start: day + 10 * H, end: day + 11 * H, ongoing: false, batteryCovered: true, names: ['Grid loss'] };
  const nets = [
    { kind: 'network', start: day + 2 * H, end: day + 2.5 * H, ongoing: false, names: [] },
    { kind: 'network', start: day + 23 * H, end: day + 25 * H, ongoing: false, names: [] }, // 1 h falls on the next day
  ];
  assert.equal(eventTitle(cut), 'Power cut from the grid: the battery powered the home.', 'a full sentence, with its full stop');
  const grouped = groupNetwork([cut, ...nets]);
  assert.equal(grouped.length, 2);
  const g = grouped.find((e) => e.kind === 'networkDay');
  assert.equal(g.n, 2);
  // one counting rule: a loss belongs to the day it started with its full length, so the day row and the summary agree
  assert.equal(g.total, 2.5 * H);
  assert.equal(summarize([cut, ...nets]), '1 power cut (1 h), 2 internet losses (2.5 h in total)');
  assert.match(eventItem(g), /2 internet losses \(2.5 h in total\)/);
  assert.match(eventItem(cut), /<use href="\/icons.svg#zap-off"\/>/);
  assert.doesNotMatch(eventItem({ ...cut, names: ['<b>'] , kind: 'other' }), /<b>/);
});

test('ledger columns fill every row when they can', async () => {
  const { ledgerColumns } = await import('../public/js/ui.js');
  assert.equal(ledgerColumns(4, 5), 4);
  assert.equal(ledgerColumns(9, 5), 3, '3 by 3, not 5 and 4');
  assert.equal(ledgerColumns(8, 5), 4);
  assert.equal(ledgerColumns(10, 5), 5);
  assert.equal(ledgerColumns(7, 5), 4, 'no exact fit: the fullest last row');
});

test('a power cut and the overload and low battery it caused are one episode', async () => {
  const { groupEpisodes, whenText } = await import('../public/js/incidents.js');
  setLang('en');
  f.setTimeZone('Europe/Madrid');
  const day = f.dayStart('2026-11-10');
  const M = 60e3;
  const cut = { kind: 'gridCut', start: day + 7 * H + 41 * M, end: day + 8 * H + 45 * M, ongoing: false, batteryCovered: 'overload', names: [] };
  const low = { kind: 'batteryLow', start: cut.start - 3e3, end: day + 8 * H, ongoing: false, names: ['low'] };
  const over = { kind: 'overload', start: day + 7 * H + 50 * M, end: day + 8 * H, ongoing: false, names: ['over'] };
  const later = { kind: 'batteryLow', start: day + 12 * H, end: day + 12 * H + 5 * M, ongoing: false, names: [] };
  const list = groupEpisodes([cut, over, low, later]);
  assert.deepEqual(list.map((e) => e.kind), ['gridCut', 'batteryLow']);
  assert.deepEqual(list[0].related, [low, over]);
  assert.equal(list[1], later);
  assert.match(eventItem(list[0]), /During the cut: battery almost empty \(07:40 – 08:00\), overload \(07:50 – 08:00\)/);
  // same day: the end shows only its time
  assert.doesNotMatch(whenText(cut), /Nov.*Nov/);
  assert.match(whenText({ ...cut, end: day + 30 * H }), /Nov.*Nov/);
});

test('internet losses: the 24 h summary and the day rows count the same losses and hours', () => {
  const day = f.dayStart('2026-11-17');
  const nets = [
    { kind: 'network', start: day + 8 * H, end: day + 9 * H, ongoing: false, names: [] },
    { kind: 'network', start: day + 21 * H, end: day + 31 * H, ongoing: false, names: [] }, // 10 h across midnight
  ];
  const rows = groupNetwork(nets);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].total, 11 * H);
  const sum = nets.reduce((a, e) => a + e.end - e.start, 0);
  assert.equal(rows[0].total, sum);
});
