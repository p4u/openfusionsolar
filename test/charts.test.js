process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apexOptions, toCsv, gapBands, eventBands, opacityFor, isBelow, legendKey, timeTick, timeAxis, bucketAxis, chartLabel, legendItemTemplate, tooltipHtml, HEIGHTS } from '../public/js/chart-data.js';
import { setLang } from '../public/js/i18n.js';
import { setTimeZone, isoLocal, fmtMonthShort, fmtDate, dayOf, dayStart } from '../public/js/format.js';

const palette = {
  sun: '#c98500', home: '#2a78d6', grid: '#b0409a', battery: '#199e70', p1: '#7f2c6f', p2: '#b0409a', p3: '#d98fc8',
  ok: '#15803d', warn: '#b45309', alarm: '#dc2626', muted: '#777169', text: '#777169', ink: '#0c0a09',
  hairline: '#e7e5e4', surface: '#ffffff', fontFamily: 'Inter Variable',
  band: { gap: 'rgba(251,191,36,.25)', cut: 'rgba(248,113,113,.3)', stopped: 'rgba(100,116,139,.2)' },
};
const MIN = 60e3;
const T0 = Date.UTC(2026, 9, 14, 6);
const spec = (extra = {}) => ({
  id: 'a', kind: 'time', unit: 'kW', x: { min: T0, max: T0 + 4 * 900e3 }, y: { decimals: 2 },
  series: [
    { key: 'sun', name: 'Panels', type: 'area', entity: 'sun', data: [[T0, 1], [T0 + 900e3, 2], [T0 + 1800e3, null]] },
    { key: 'home', name: 'Home', type: 'bar', entity: 'home', data: [[T0, 1], [T0 + 900e3, 2], [T0 + 1800e3, 3]] },
    { key: 'band', name: 'Range', type: 'rangeArea', entity: 'grid', data: [[T0, [1, 2]], [T0 + 900e3, [2, 3]], [T0 + 1800e3, null]] },
  ],
  ...extra,
});

test('options have a single y axis and no opposite axis', () => {
  const o = apexOptions(spec({ group: 'g' }), palette);
  assert.ok(!Array.isArray(o.yaxis));
  assert.equal(typeof o.yaxis, 'object');
  assert.ok(!('opposite' in o.yaxis));
  assert.equal(o.chart.animations.enabled, false);
  assert.equal(o.chart.toolbar.show, false);
  assert.equal(o.chart.group, 'g');
  assert.equal(o.chart.id, 'a');
  assert.equal(apexOptions(spec(), palette).chart.group, undefined);
  assert.deepEqual(o.series[2].data[0], { x: T0, y: [1, 2] });
  assert.deepEqual(o.series[0].data[2], { x: T0 + 1800e3, y: null });
});

test('entities map to palette colours', () => {
  const s = spec({ refLines: [{ y: 3, label: 'Limit', entity: 'alarm' }], bands: [{ from: T0, to: T0 + MIN, kind: 'cut' }] });
  const o = apexOptions(s, palette);
  assert.equal(o.colors[0], '#c98500');
  assert.equal(o.colors[2], '#b0409a');
  assert.equal(typeof o.colors[1], 'function', 'bars take their colour per point so partial buckets can fade');
  assert.equal(o.colors[1]({ dataPointIndex: 0 }), 'rgba(42, 120, 214, 1)');
  assert.equal(o.annotations.yaxis[0].borderColor, '#dc2626');
  assert.equal(o.annotations.xaxis[0].fillColor, palette.band.cut);
  assert.equal(apexOptions(spec({ series: [{ ...spec().series[0], entity: 'p3' }] }), palette).colors[0], '#d98fc8');
});

test('csv rounds float noise to 3 decimals and keeps dot decimals', () => {
  assert.equal(toCsv(['v'], [[168.63999999999993], [0.1 + 0.2], [-0.0004], [2]]), 'v\r\n168.64\r\n0.3\r\n0\r\n2\r\n');
});

test('csv periods are ISO in the plant zone', () => {
  setTimeZone('Europe/Madrid');
  const t = Date.UTC(2026, 7, 10, 10, 15); // 12:15 in Madrid (summer time)
  assert.equal(isoLocal(t, '15m'), '2026-08-10T12:15');
  assert.equal(isoLocal(t, '1d'), '2026-08-10');
  assert.equal(isoLocal(t, '1mo'), '2026-08');
});

test('time ticks: hours in a day, day at midnight over a few days, months with their year, then years', () => {
  setLang('en');
  setTimeZone('Europe/Madrid');
  const DAY = 86400e3;
  const midnight = Date.UTC(2026, 7, 9, 22); // 10 Aug 00:00 Madrid
  assert.equal(timeTick(midnight + 12 * 3600e3, DAY), '12:00');
  assert.equal(timeTick(midnight, 3 * DAY), fmtDate(midnight));
  assert.match(timeTick(midnight, 3 * DAY), /10/);
  // ruling R26: past 2 days the ticks are days, so a tick near noon reads as its nearest day
  assert.equal(timeTick(midnight + 3 * 3600e3, 3 * DAY), '10 Aug');
  assert.equal(timeTick(midnight, 30 * DAY), fmtDate(midnight));
  assert.equal(timeTick(midnight, 400 * DAY), 'Aug 2026');
  assert.equal(timeTick(midnight, 1000 * DAY), '2026');
  setLang('ca');
  assert.equal(fmtMonthShort('2026-01'), 'gen. 2026', 'no "del" inside a tick');
});

test('tooltips show amounts without sign; the series name says the direction', () => {
  const s = { id: 't', kind: 'category', unit: 'kWh', y: { decimals: 1 }, x: { categories: ['a'] },
    series: [{ key: 'sold', name: 'Sold', type: 'bar', entity: 'grid', data: [-222.7] }] };
  const html = tooltipHtml(s, 0);
  assert.match(html, /222[.,]7/);
  assert.doesNotMatch(html, /-222/);
});

test('y axis ticks have no trailing decimals', () => {
  const o = apexOptions(spec(), palette);
  setLang('en');
  assert.equal(o.yaxis.labels.formatter(2), '2');
  assert.equal(o.yaxis.labels.formatter(2.5), '2.5');
});

test('csv has units in headers and empty cells for null', () => {
  const csv = toCsv([{ label: 'Day' }, { label: 'Panels', unit: 'kWh' }, 'Note'], [['2026-10-01', 12.5, 'a, "b"'], ['2026-10-02', null, 'x']]);
  assert.equal(csv, 'Day,Panels (kWh),Note\r\n2026-10-01,12.5,"a, ""b"""\r\n2026-10-02,,x\r\n');
});

test('gaps shorter than 15 minutes and the last 15 minutes are not bands', () => {
  const t = Array.from({ length: 12 }, (_, i) => T0 + i * 5 * MIN);
  const cov = [1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0];
  const now = t[11] + 5 * MIN;
  const bands = gapBands({ t, coverage: cov, bucketMs: 5 * MIN, now });
  assert.deepEqual(bands, [{ from: t[3], to: t[6], kind: 'gap' }], 'a 5 min gap is skipped; the trailing run ends 15 min before now');
  assert.deepEqual(gapBands({ t, coverage: cov, bucketMs: 5 * MIN, now: t[11] + 60 * MIN }).map((b) => b.from), [t[3], t[8]]);
  assert.deepEqual(gapBands({ t: t.slice(0, 2), coverage: [0, 0], bucketMs: 5 * MIN, now: t[11] + 60 * MIN }), [], '10 min in total');
});

test('event bands map kinds and clip to the range', () => {
  const ev = [{ kind: 'gridCut', start: T0, end: T0 + 10 * MIN }, { kind: 'noProduction', start: T0 - 5 * MIN, end: null }, { kind: 'other', start: T0, end: T0 + MIN }];
  assert.deepEqual(eventBands(ev, T0, T0 + 60 * MIN), [
    { from: T0, to: T0 + 10 * MIN, kind: 'cut' }, { from: T0, to: T0 + 60 * MIN, kind: 'stopped' },
  ]);
});

test('coverage below 0.9 lowers opacity', () => {
  assert.equal(opacityFor(1), 1);
  assert.equal(opacityFor(0.9), 1);
  assert.equal(opacityFor(0.89), 0.45);
  assert.equal(opacityFor(0), null);
  assert.equal(opacityFor(undefined), 1);
  const o = apexOptions(spec({ coverage: [1, 0.5, 0] }), palette);
  assert.equal(o.colors[1]({ dataPointIndex: 1 }), 'rgba(42, 120, 214, 0.45)');
});

test('no source file declares a second y axis', () => {
  const dir = fileURLToPath(new URL('../public/js/', import.meta.url));
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /opposite/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
    }
  })(dir);
  assert.deepEqual(hits, []);
});

test('the DOM modules import under node without touching the DOM, and every preset and bucket has a label', async () => {
  const { chart, figure } = await import('../public/js/charts.js');
  const { renderRangeBar } = await import('../public/js/range-bar.js');
  const { default: dict } = await import('../public/js/i18n/charts.js');
  const { PRESETS } = await import('../public/js/range.js');
  assert.equal(typeof chart, 'function');
  assert.equal(typeof figure, 'function');
  assert.equal(typeof renderRangeBar, 'function');
  for (const k of [...PRESETS.map((p) => `charts.range.${p}`), ...['5m', '15m', '1h', '1d', '1mo', '1y'].map((b) => `charts.bucket.${b}`)]) {
    assert.equal(typeof dict.en[k], 'string', k);
  }
});

test('mixed range, bar and synced strip configs carry what ApexCharts needs', () => {
  const a = apexOptions(spec({ group: 'g', stacked: true, height: 'strip' }), palette);
  const b = apexOptions(spec({ id: 'b', group: 'g' }), palette);
  assert.equal(a.chart.type, 'line');
  assert.deepEqual(a.series.map((s) => s.type), ['area', 'bar', 'rangeArea']);
  assert.equal(a.chart.height, HEIGHTS.strip);
  assert.ok(HEIGHTS.strip >= 160, 'strips are tall enough for readable ticks');
  assert.equal(a.chart.group, b.chart.group);
  assert.notEqual(a.chart.id, b.chart.id);
  assert.equal(a.yaxis.labels.minWidth, b.yaxis.labels.minWidth, 'same label width keeps synced plot areas aligned');
  const cat = apexOptions({ id: 'c', kind: 'category', unit: 'kWh', x: { categories: ['a', 'b'] }, series: [{ key: 'k', name: 'K', type: 'bar', entity: 'ok', data: [1, 2] }] }, palette, { mobile: true });
  assert.equal(cat.chart.height, HEIGHTS.mobile);
  assert.ok(HEIGHTS.mobile >= 280, 'a phone plot keeps about 200 px under a one-row legend');
  assert.deepEqual(cat.series[0].data, [{ x: 'a', y: 1 }, { x: 'b', y: 2 }]);
});

test('legend keys tell same-coloured series apart by shape, side and dash', () => {
  const x = [T0, T0 + 900e3];
  const energy = {
    id: 'e', kind: 'time', unit: 'kWh', stacked: true, x: { min: T0, max: T0 + 1800e3 },
    series: [
      { key: 'homeSolar', name: 'Home, solar', type: 'bar', entity: 'sun', data: [[x[0], 1], [x[1], 2]] },
      { key: 'sold', name: 'Sold', type: 'bar', entity: 'grid', below: true, data: [[x[0], 0], [x[1], 0]] },
      { key: 'bought', name: 'Bought', type: 'bar', entity: 'grid', data: [[x[0], 1], [x[1], null]] },
      { key: 'produced', name: 'Produced', type: 'line', entity: 'sun', markers: true, data: [[x[0], 3], [x[1], 4]] },
      { key: 'cmp', name: 'Last year', type: 'line', entity: 'sun', dashed: true, data: [[x[0], 2], [x[1], 3]] },
    ],
  };
  const o = apexOptions(energy, palette);
  const keys = o.legend.markers.customHTML.map((f) => f());
  assert.equal(new Set(keys).size, keys.length, 'every legend key differs');
  assert.match(keys[0], /<rect x="4" y="1"/, 'above the baseline');
  assert.match(keys[1], /<rect x="4" y="9"/, 'sold sits below the baseline even with only zeros');
  assert.match(keys[3], /<line [^>]*stroke="#c98500"[^>]*\/><circle/, 'produced: a line with a dot');
  assert.doesNotMatch(keys[3], /<rect/);
  assert.match(keys[4], /stroke-dasharray/);
  assert.deepEqual(o.markers.size, [0, 0, 0, 4, 0], 'only the produced line carries dots');
  assert.equal(o.markers.strokeColors, palette.surface);
  // a chart with nothing below zero keeps plain square keys
  assert.match(legendKey({ type: 'bar' }, { colour: '#c98500', text: '#777', surface: '#fff' }), /<rect x="3" y="3" width="12" height="12"/);
  assert.equal(isBelow({ kind: 'category' }, { data: [null, -1, 0] }), true);
  assert.equal(isBelow({ kind: 'category' }, { data: [0, 0] }), false);
});

test('range bars are a light, narrow wash and keep their own legend key', () => {
  const soc = {
    id: 's', kind: 'time', unit: '%', x: { min: T0, max: T0 + 2 * 86400e3 },
    series: [
      { key: 'range', name: 'Min and max', type: 'rangeBar', entity: 'battery', data: [[T0, [20, 90]], [T0 + 86400e3, null]] },
      { key: 'soc', name: 'Mean', type: 'line', entity: 'battery', data: [[T0, 50], [T0 + 86400e3, null]] },
    ],
  };
  const o = apexOptions(soc, palette);
  assert.ok(o.fill.opacity[0] <= 0.35, 'range bars are faint');
  assert.equal(o.fill.opacity[1], 1);
  assert.equal(o.plotOptions.bar.columnWidth, '40%');
  const [range, mean] = o.legend.markers.customHTML.map((f) => f());
  assert.match(range, /fill-opacity="0.3"/);
  assert.match(mean, /<line /);
  assert.equal(apexOptions(spec(), palette).plotOptions.bar.columnWidth, '80%', 'charts with real bars keep wide columns');
});

test('time axes: tick count lands every tick on an hour, day, month or year boundary', () => {
  setTimeZone('Europe/Madrid');
  const DAY = 86400e3;
  const d0 = Date.UTC(2026, 10, 12, 23); // 13 Nov 00:00 Madrid
  assert.deepEqual(timeAxis(d0, d0 + DAY), { unit: 'hour', tickAmount: 12, min: d0, max: d0 + DAY }, 'a day: every 2 hours');
  assert.equal(timeAxis(d0, d0 + DAY, { mobile: true }).tickAmount, 4, 'a phone: every 6 hours, so the date and the hours never touch');
  assert.equal(timeAxis(d0, d0 + 2 * DAY, { mobile: true }).tickAmount, 4);
  assert.deepEqual([timeAxis(d0, d0 + 7 * DAY).unit, timeAxis(d0, d0 + 7 * DAY).tickAmount], ['day', 7], '7 days: one tick a day');
  assert.equal(timeAxis(d0, d0 + 30 * DAY).tickAmount, 10);
  assert.equal(timeAxis(d0, d0 + 31 * DAY).tickAmount, 31, 'no step divides 31: one a day, overlaps hide');
  // a year in progress is drawn to the end of the current month, so every monthly tick sits on a month start
  const jan1 = Date.UTC(2025, 11, 31, 23);
  const partial = timeAxis(jan1, Date.UTC(2026, 10, 19, 23));
  assert.deepEqual(partial, { unit: 'month', tickAmount: 11, min: jan1, max: Date.UTC(2026, 10, 30, 23) });
  const mid = timeAxis(Date.UTC(2026, 2, 14, 23), Date.UTC(2026, 8, 20, 22));
  assert.equal(mid.min, Date.UTC(2026, 1, 28, 23), 'starts on 1 March');
  assert.equal(mid.max, Date.UTC(2026, 8, 30, 22), 'ends on 1 October');
  for (let k = 0; k <= partial.tickAmount; k++) {
    const ms = partial.min + (k * (partial.max - partial.min)) / partial.tickAmount;
    const nearest = dayStart(`${dayOf(ms + 15 * DAY).slice(0, 7)}-01`);
    assert.ok(Math.abs(ms - nearest) <= 2 * DAY, `tick ${k} within 2 days of its month start`);
  }
  assert.equal(timeAxis(d0, d0 + 365 * DAY).unit, 'month');
  assert.equal(timeAxis(d0, d0 + 365 * DAY).tickAmount, 13, '13 Nov to 13 Nov is drawn 1 Nov to 1 Dec: 13 months');
  assert.equal(timeAxis(d0, d0 + 5 * 365 * DAY).unit, 'year');
  // a 25 h DST day is still an hour axis with whole-hour ticks
  const oct25 = Date.UTC(2026, 9, 24, 22);
  const a = timeAxis(oct25, oct25 + 25 * 3600e3);
  assert.equal(a.unit, 'hour');
  assert.equal(25 % a.tickAmount, 0);
});

test('time ticks over 7 days are ascending dates, one per day, never hours', () => {
  setLang('ca');
  setTimeZone('Europe/Madrid');
  const DAY = 86400e3;
  const d0 = Date.UTC(2026, 10, 12, 23); // 13 Nov 00:00 Madrid
  const span = 7 * DAY;
  const { tickAmount } = timeAxis(d0, d0 + span);
  const labels = Array.from({ length: tickAmount + 1 }, (_, k) => timeTick(d0 + (k * span) / tickAmount, span));
  assert.deepEqual(labels, ['13 nov.', '14 nov.', '15 nov.', '16 nov.', '17 nov.', '18 nov.', '19 nov.', '20 nov.']);
  // over 2 days the date replaces the hour at midnight
  assert.equal(timeTick(d0 + DAY, 2 * DAY), '14 nov.');
  assert.equal(timeTick(d0 + DAY + 4 * 3600e3, 2 * DAY), '04:00');
  // a tick an hour off midnight (DST) still names its day
  assert.equal(timeTick(d0 + 3 * DAY - 3600e3, span), '16 nov.');
  assert.equal(timeTick(Date.UTC(2026, 0, 31), 400 * DAY), 'febr. 2026', 'nearest month start');
  setLang('en');
});

test('bucket axes: one short label per bar, the month or year in the title, no ellipsis', () => {
  setLang('ca');
  const days = Array.from({ length: 11 }, (_, i) => `2025-08-${String(10 + i).padStart(2, '0')}`);
  const d = bucketAxis(days, '1d');
  assert.equal(d.categories.length, 11);
  assert.deepEqual(d.categories.slice(0, 3), ['10', '11', '12']);
  assert.equal(d.title, 'agost del 2025');
  assert.equal(bucketAxis(['2025-08-31', '2025-09-01'], '1d').title, 'ag. – set. 2025');
  const months = ['2026-01', '2026-02', '2026-03'];
  assert.deepEqual(bucketAxis(months, '1mo'), { categories: ['gen.', 'febr.', 'març'], title: '2026' });
  const span = bucketAxis(['2025-11', '2025-12', '2026-01', '2026-02'], '1mo');
  assert.deepEqual(span.categories, ['nov. 2025', 'des.', 'gen. 2026', 'febr.']);
  assert.equal(span.title, '2025 – 2026');
  assert.deepEqual(bucketAxis(['2025', '2026'], '1y').categories, ['2025', '2026']);
  for (const c of [...d.categories, ...span.categories]) assert.doesNotMatch(c, /…/);
  const o = apexOptions({ id: 'c', kind: 'category', unit: 'kWh', x: { categories: d.categories, title: d.title }, series: [{ key: 'k', name: 'K', type: 'bar', entity: 'sun', data: days.map(() => 1) }] }, palette);
  assert.equal(o.xaxis.labels.trim, false, 'labels are never cut with an ellipsis');
  assert.equal(o.xaxis.title.text, 'agost del 2025');
  setLang('en');
});

test('charts carry a localised accessible name and a legend template ApexCharts can fill', () => {
  setLang('ca');
  const o = apexOptions(spec(), palette);
  assert.equal(o.chart.accessibility.description, 'Gràfic: Panels, Home, Range. Els valors són a la taula de sota.');
  assert.equal(chartLabel({ series: [{ name: 'Sol' }] }), 'Gràfic: Sol. Els valors són a la taula de sota.');
  const tpl = o.chart.locales[0].options.a11y.legendItem;
  assert.equal(tpl, legendItemTemplate());
  assert.match(tpl, /^\{name\}, \{state\}\./, 'placeholders survive our own t()');
  // what ApexCharts does with it
  assert.equal(tpl.replace(/\{(name|state)\}/g, (_, k) => (k === 'name' ? 'Sol' : 'visible')), 'Sol, visible. Prem Retorn o Espai per mostrar-la o amagar-la.');
  setLang('en');
});

test('a nearly flat signal gets a y axis wide enough for distinct labels; fixed ends and stacks are kept', async () => {
  const { yExtent } = await import('../public/js/chart-data.js');
  const flat = { kind: 'time', y: { decimals: 2 }, series: [{ data: [[0, -1], [1, -0.998], [2, -0.997], [3, null]] }, { type: 'rangeArea', data: [[0, [-1, -0.997]]] }] };
  const e = yExtent(flat);
  assert.ok(e.max - e.min >= 0.0998, 'a tenth of the size at least');
  assert.ok(e.min < -1 && e.max > -0.997, 'the data stays inside');
  // a real spread is left to ApexCharts
  assert.deepEqual(yExtent({ kind: 'time', y: { decimals: 1 }, series: [{ data: [[0, 0], [1, 3.2]] }] }), { min: undefined, max: undefined });
  // a fixed minimum stays; the top is lifted so a quiet night is not one label
  assert.deepEqual(yExtent({ kind: 'time', y: { min: 0, decimals: 1 }, series: [{ data: [[0, 0], [1, 0.1]] }] }), { min: 0, max: 0.4 });
  assert.deepEqual(yExtent({ kind: 'category', stacked: true, y: {}, series: [{ data: [1, 1] }] }), { min: undefined, max: undefined });
  assert.deepEqual(yExtent({ kind: 'time', y: {}, series: [{ data: [] }] }), { min: undefined, max: undefined });
});

test('a month label with its year is drawn on two lines, so the year at each change is kept', async () => {
  const { twoLines, bucketAxis, apexOptions: opts } = await import('../public/js/chart-data.js');
  setLang('ca');
  const span = bucketAxis(['2025-11', '2025-12', '2026-01'], '1mo');
  const o = opts({ id: 'm', kind: 'category', unit: 'kWh', x: { categories: span.categories }, series: [{ key: 'k', name: 'K', type: 'bar', entity: 'sun', data: [1, 2, 3] }] }, palette);
  assert.deepEqual(o.xaxis.categories, [['nov.', '2025'], 'des.', ['gen.', '2026']]);
  assert.deepEqual(o.series[0].data[2].x, ['gen.', '2026']);
  assert.equal(twoLines('10'), '10');
  assert.equal(twoLines('2026'), '2026', 'a year bar stays one line');
  setLang('en');
});

test('toCsv prefixes =, +, -, @ text cells', () => {
  const csv = toCsv([{ label: 'Day' }, { label: '=HYPERLINK("x")', unit: 'kWh' }, '@me'], [['+1', -5, '-cmd'], ['ok', 2.5, 'a=b']]);
  assert.equal(csv, 'Day,"\'=HYPERLINK(""x"") (kWh)",\'@me\r\n\'+1,-5,\'-cmd\r\nok,2.5,a=b\r\n');
});

const XSS = '<img src=x onerror=alert(1)>';
const round = (kind) => ({
  id: 'f', kind, unit: 'kWh', y: { decimals: 1 }, x: { categories: ['Mon', 'Tue'], title: '', label: (i) => ['Monday', 'Tuesday'][i] },
  series: [{ key: 's0', name: XSS, entity: 'sun', data: kind === 'donut' ? [3] : [1, 2] }, { key: 's1', name: 'Grid', entity: kind === 'donut' ? 'home' : 'sun', data: kind === 'donut' ? [1] : [null, 4] }],
});

test('apexOptions escapes legend names', () => {
  // preflight F8: ApexCharts' default tooltip inserts series names as HTML, so every kind builds its own with esc();
  // the legend writes an unchanged name with textContent, so no legend formatter
  for (const spec of [round('donut'), round('heatmap'), { ...round('category'), series: round('heatmap').series.map((s) => ({ ...s, type: 'bar' })) }]) {
    const o = apexOptions(spec, palette);
    assert.equal(typeof o.tooltip.custom, 'function', spec.kind);
    assert.equal(o.legend.formatter, undefined, spec.kind);
    for (const [seriesIndex, dataPointIndex] of [[0, 0], [1, 1], [0, 1]]) {
      const html = o.tooltip.custom({ seriesIndex, dataPointIndex });
      assert.doesNotMatch(html, /<img/, spec.kind);
      if (seriesIndex === 0 && spec.kind === 'donut') assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    }
  }
});

test('donut and heatmap options', () => {
  const d = apexOptions(round('donut'), palette);
  assert.equal(d.chart.type, 'donut');
  assert.deepEqual(d.series, [3, 1]);
  assert.deepEqual(d.labels, [XSS, 'Grid']);
  assert.deepEqual(d.colors, [palette.sun, palette.home]);
  assert.equal(d.dataLabels.enabled, false);
  assert.equal(d.legend.show, true);
  assert.equal(d.chart.animations.enabled, false);
  assert.match(d.chart.accessibility.description, /Grid/);
  assert.match(d.tooltip.custom({ seriesIndex: 0 }), /3\.0 kWh \(75\s%\)/);

  const h = apexOptions(round('heatmap'), palette);
  assert.equal(h.chart.type, 'heatmap');
  assert.deepEqual(h.series, [{ name: XSS, data: [{ x: 'Mon', y: 1 }, { x: 'Tue', y: 2 }] }, { name: 'Grid', data: [{ x: 'Mon', y: null }, { x: 'Tue', y: 4 }] }]);
  assert.deepEqual(h.colors, [palette.sun]);
  assert.equal(h.dataLabels.enabled, false);
  assert.equal(h.legend.show, false);
  assert.equal(h.plotOptions.heatmap.enableShades, true);
  assert.deepEqual(h.xaxis.categories, ['Mon', 'Tue']);
  assert.match(h.chart.accessibility.description, /Grid/);
  assert.match(h.tooltip.custom({ seriesIndex: 1, dataPointIndex: 1 }), /Tuesday.*Grid.*4\.0 kWh/s);
});
