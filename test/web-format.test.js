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
  assert.equal(eventTitle(cut), 'Power cut from the grid: the battery powered the home');
  const grouped = groupNetwork([cut, ...nets]);
  assert.equal(grouped.length, 2);
  const g = grouped.find((e) => e.kind === 'networkDay');
  assert.equal(g.n, 2);
  assert.equal(g.total, 1.5 * H);
  assert.equal(summarize([cut, ...nets]), '1 power cut (1 h), 2 internet losses (2.5 h in total)');
  assert.match(eventItem(g), /2 internet losses \(1.5 h in total\)/);
  assert.match(eventItem(cut), /<use href="\/icons.svg#zap-off"\/>/);
  assert.doesNotMatch(eventItem({ ...cut, names: ['<b>'] , kind: 'other' }), /<b>/);
});
