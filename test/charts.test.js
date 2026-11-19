process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apexOptions, toCsv, gapBands, eventBands, opacityFor, isBelow, legendKey } from '../public/js/chart-data.js';

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
  assert.equal(a.chart.height, 120);
  assert.equal(a.chart.group, b.chart.group);
  assert.notEqual(a.chart.id, b.chart.id);
  assert.equal(a.yaxis.labels.minWidth, b.yaxis.labels.minWidth, 'same label width keeps synced plot areas aligned');
  const cat = apexOptions({ id: 'c', kind: 'category', unit: 'kWh', x: { categories: ['a', 'b'] }, series: [{ key: 'k', name: 'K', type: 'bar', entity: 'ok', data: [1, 2] }] }, palette, { mobile: true });
  assert.equal(cat.chart.height, 260);
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
