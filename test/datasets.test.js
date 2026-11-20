process.env.TZ = 'Europe/Madrid';
// Dataset core: registry, summary, group_by over local time, ratios from sums, derived
// series and the resolved figure block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDatasets, summarize, groupDataset, withRatios, resolveFigure, xLabel, DataError, MAX_ROWS,
} from '../src/datasets.js';
import { groundedSet, check } from '../src/grounding.js';

const H = 3600e3;
const col = (name, unit, values, hidden) => ({ name, unit, values, ...(hidden && { hidden }) });
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 10, from + i)).toISOString().slice(0, 10));

test('the registry numbers datasets per turn and refuses more than 750 rows or 8 columns', () => {
  const reg = createDatasets();
  const ds = { args: {}, source: ['measured'], x: { type: 'day', values: ['2026-11-01'] }, columns: [col('pv_kwh', 'kWh', [1])] };
  assert.equal(reg.add(ds).id, 'd1');
  assert.equal(reg.add(ds).id, 'd2');
  assert.equal(reg.get('d2').columns[0].name, 'pv_kwh');
  assert.equal(reg.get('d9'), null);
  assert.equal(createDatasets().add(ds).id, 'd1');
  assert.throws(() => reg.add({ ...ds, x: { type: 'time', values: Array(MAX_ROWS + 1).fill(0) } }), DataError);
  assert.throws(() => reg.add({ ...ds, columns: Array.from({ length: 9 }, (_, i) => col(`c${i}`, 'kWh', [1])) }), /at most 8/);
  assert.doesNotThrow(() => reg.add({ ...ds, columns: [...Array.from({ length: 8 }, (_, i) => col(`c${i}`, 'kWh', [1])), col('h', 'kWh', [1], true)] }));
});

test('summary: head, tail, stats per visible column, all rows only up to 60', () => {
  const reg = createDatasets();
  const x = days(1, 30).concat(days(31, 31));
  const ds = reg.add({ args: { metrics: ['pv_kwh'] }, source: ['measured'], x: { type: 'day', values: x },
    columns: [col('pv_kwh', 'kWh', x.map((_, i) => (i === 5 ? null : i + 1))), col('load_kwh', 'kWh', x.map(() => 1), true)] });
  const s = summarize(ds);
  assert.deepEqual(s.columns, ['x', 'pv_kwh']);
  assert.deepEqual(s.units, { pv_kwh: 'kWh' });
  assert.equal(s.rowCount, 61);
  assert.deepEqual(s.head[0], ['2026-11-01', 1]);
  assert.deepEqual(s.tail.at(-1), ['2026-12-31', 61]);
  assert.deepEqual(s.stats.pv_kwh, { min: 1, minAt: '2026-11-01', max: 61, maxAt: '2026-12-31', sum: 1885, mean: 31.416666666666668, nonNull: 60 });
  assert.equal(s.rows, undefined);
  const small = summarize(reg.add({ ...ds, x: { type: 'day', values: x.slice(0, 60) }, columns: [col('pv_kwh', 'kWh', x.slice(0, 60).map(() => 2))] }));
  assert.equal(small.rows.length, 60);
});

test('time rows read as local time for the model', () => {
  assert.equal(xLabel('time', Date.parse('2026-07-15T12:00:00Z')), '2026-07-15 14:00');
  assert.equal(xLabel('month', '2026-07'), '2026-07');
});

// Two July days, hourly: hour h has pv = h on day 1 and h + 2 on day 2 (so the average is h + 1); hour 3 of day 2 is missing.
function julyHours() {
  const start = Date.parse('2026-07-01T00:00:00+02:00');
  const t = Array.from({ length: 48 }, (_, i) => start + i * H);
  const pv = t.map((_, i) => (i === 24 + 3 ? null : (i % 24) + (i >= 24 ? 2 : 0)));
  return { args: { metrics: ['pv_kwh'], bucket: '1h' }, source: ['measured'], x: { type: 'time', values: t }, columns: [col('pv_kwh', 'kWh', pv)] };
}

test('group_by hour_of_day averages over the values present, by local hour', () => {
  const g = groupDataset(julyHours(), 'hour_of_day', 'avg');
  assert.deepEqual(g.x, { type: 'hour_of_day', values: Array.from({ length: 24 }, (_, h) => h) });
  assert.equal(g.columns[0].values[13], 14);
  assert.equal(g.columns[0].values[3], 3); // only day 1 has hour 3: nulls are skipped, not zero
  assert.equal(groupDataset(julyHours(), 'hour_of_day', 'sum').columns[0].values[13], 28);
  assert.equal(groupDataset(julyHours(), 'hour_of_day', 'max').columns[0].values[0], 2);
});

test('the 25-hour day folds its repeated 02:00 into hour 2', () => {
  const start = Date.parse('2026-10-25T00:00:00+02:00');
  const t = Array.from({ length: 25 }, (_, i) => start + i * H);
  const g = groupDataset({ args: {}, source: ['measured'], x: { type: 'time', values: t }, columns: [col('load_kw', 'kW', t.map(() => 1))] }, 'hour_of_day', 'sum');
  assert.equal(g.x.values.length, 24);
  assert.equal(g.columns[0].values[2], 2);
});

test('group_by weekday reads the day key (no time zone) and recomputes ratios from sums', () => {
  // 2026-11-16 and 2026-11-23 are Mondays; 2026-11-22 is a Sunday
  const x = ['2026-11-16', '2026-11-22', '2026-11-23'];
  const ds = withRatios({ args: {}, source: ['measured'], x: { type: 'day', values: x },
    columns: [col('load_kwh', 'kWh', [10, 8, 30]), col('self_sufficiency_pct', '%', [null, null, null]), col('import_kwh', 'kWh', [5, 0, 3], true)] });
  assert.deepEqual(ds.columns[1].values, [50, 100, 90]);
  const g = groupDataset(ds, 'weekday', 'avg');
  assert.deepEqual(g.x.values, [1, 7]);
  assert.deepEqual(g.columns[0].values, [20, 8]); // load: average of the Mondays
  assert.equal(g.columns[1].values[0], 80); // 100 * (40 - 8) / 40, not the mean of 50 and 90
});

test('group_by refuses what it cannot read', () => {
  assert.throws(() => groupDataset(julyHours(), 'weekday', 'avg'), /needs daily/);
  assert.throws(() => groupDataset({ ...julyHours(), x: { type: 'day', values: [] } }, 'hour_of_day', 'avg'), /needs bucket 1h/);
  assert.throws(() => groupDataset(julyHours(), 'hour_of_day', 'median'), /agg must be/);
  assert.throws(() => groupDataset(julyHours(), 'week', 'avg'), /group_by must be/);
  assert.deepEqual(groupDataset({ args: {}, source: [], x: { type: 'month', values: ['2025-07', '2026-07'] }, columns: [col('pv_kwh', 'kWh', [1, 3])] }, 'month_of_year', 'avg').columns[0].values, [2]);
});

const ratioNull = withRatios({ args: {}, source: [], x: { type: 'day', values: ['2026-11-01'] }, columns: [col('load_kwh', 'kWh', [0]), col('import_kwh', 'kWh', [0]), col('self_sufficiency_pct', '%', [1])] });
test('a ratio over a zero divisor is null', () => assert.equal(ratioNull.columns[2].values[0], null));

// d1: monthly money, cumulative savings and derived columns
function money() {
  const reg = createDatasets();
  reg.add({ args: { metrics: ['savings_eur', 'estimated_eur'], from: '2026-01-01', to: '2026-04-30', bucket: '1mo' }, source: ['estimate'],
    x: { type: 'month', values: ['2026-01', '2026-02', '2026-03', '2026-04'] },
    columns: [col('savings_eur', '€', [10, null, 30.5, 40]), col('estimated_eur', '€', [50, 40, 0, 20]), col('import_kwh', 'kWh', [100, 80, 60, 40])] });
  return reg;
}
const G = groundedSet(['{"savings_eur":[10,30.5,40]}']);
const checkText = (s) => check(s, G, 'ca').map((f) => f.raw);

test('draw_chart resolves a cumulative series into a figure block and grounded stats', () => {
  const { block, result } = resolveFigure({ kind: 'bar', title: 'Estalvi acumulat 2026', series: [{ dataset: 'd1', op: 'cumulative', columns: ['savings_eur'], label: 'Estalvi acumulat' }] }, money(), { checkText });
  assert.deepEqual(block, {
    type: 'figure', kind: 'bar', title: 'Estalvi acumulat 2026', x: { type: 'month', values: ['2026-01', '2026-02', '2026-03', '2026-04'] },
    series: [{ label: 'Estalvi acumulat', values: [10, null, 40.5, 80.5] }], unit: '€', source: ['estimate'], notes: null,
    query: { metrics: ['savings_eur', 'estimated_eur'], from: '2026-01-01', to: '2026-04-30', bucket: '1mo' },
  });
  assert.deepEqual(result, { shown: true, series: [{ label: 'Estalvi acumulat', min: 10, max: 80.5, sum: 131, last: 80.5 }] });
});

test('derived series: ratio and share_pct are null on a zero divisor; difference and sum need one unit', () => {
  const reg = money();
  const r = resolveFigure({ kind: 'line', title: 'Ràtio', series: [{ dataset: 'd1', op: 'ratio', columns: ['savings_eur', 'estimated_eur'], label: 'r' }] }, reg).block;
  assert.deepEqual(r.series[0].values, [0.2, null, null, 2]);
  assert.equal(r.unit, '');
  const s = resolveFigure({ kind: 'line', title: 'Part', series: [{ dataset: 'd1', op: 'share_pct', columns: ['savings_eur', 'estimated_eur'], label: 's' }] }, reg).block;
  assert.deepEqual([s.unit, s.series[0].values], ['%', [20, null, null, 200]]);
  const d = resolveFigure({ kind: 'line', title: 'Dif', series: [{ dataset: 'd1', op: 'difference', columns: ['estimated_eur', 'savings_eur'], label: 'd' }] }, reg).block;
  assert.deepEqual(d.series[0].values, [40, null, -30.5, -20]);
  assert.throws(() => resolveFigure({ kind: 'line', title: 'x', series: [{ dataset: 'd1', op: 'sum', columns: ['estimated_eur', 'import_kwh'], label: 'x' }] }, reg), /same unit/);
  assert.equal(resolveFigure({ kind: 'line', title: 'x', series: [{ dataset: 'd1', op: 'ratio', columns: ['estimated_eur', 'import_kwh'], label: 'x' }] }, reg).block.unit, '€/kWh');
});

const REFUSED = [
  ['two units in one chart', { kind: 'bar', title: 't', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }, { dataset: 'd1', column: 'import_kwh', label: 'b' }] }, /different units \(€, kWh\)/],
  ['two datasets', { kind: 'bar', title: 't', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }, { dataset: 'd2', column: 'x', label: 'b' }] }, /one dataset/],
  ['unknown dataset', { kind: 'bar', title: 't', series: [{ dataset: 'd7', column: 'savings_eur', label: 'a' }] }, /unknown dataset d7/],
  ['unknown column', { kind: 'bar', title: 't', series: [{ dataset: 'd1', column: 'pv_kwh', label: 'a' }] }, /no column pv_kwh/],
  ['unknown kind', { kind: 'pie3d', title: 't', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /kind must be/],
  ['a y_unit argument', { kind: 'bar', title: 't', y_unit: 'kWh', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /unknown argument y_unit/],
  ['a long title', { kind: 'bar', title: 'x'.repeat(81), series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /at most 80/],
  ['a long label', { kind: 'bar', title: 't', series: [{ dataset: 'd1', column: 'savings_eur', label: 'x'.repeat(41) }] }, /at most 40/],
  ['long notes', { kind: 'bar', title: 't', notes: 'x'.repeat(201), series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /at most 200/],
  ['nine series', { kind: 'line', title: 't', series: Array(9).fill({ dataset: 'd1', column: 'savings_eur', label: 'a' }) }, /1 to 8/],
  ['a donut of one series', { kind: 'donut', title: 't', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /at least two/],
  ['a donut of percents', { kind: 'donut', title: 't', series: [{ dataset: 'd1', op: 'share_pct', columns: ['savings_eur', 'estimated_eur'], label: 'a' }, { dataset: 'd1', op: 'share_pct', columns: ['estimated_eur', 'savings_eur'], label: 'b' }] }, /needs kWh or €/],
  ['an invented figure in the title', { kind: 'bar', title: 'Has estalviat 999,99 €', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /title has figures .*999,99 €/],
  ['an invented figure in the notes', { kind: 'bar', title: 't', notes: 'Unes 7.777 kWh', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }] }, /notes has figures/],
  ['an invented figure in a label', { kind: 'bar', title: 't', series: [{ dataset: 'd1', column: 'savings_eur', label: 'Estalvi 555 €' }] }, /label has figures/],
];
for (const [name, args, re] of REFUSED) {
  test(`draw_chart refuses ${name}`, () => assert.throws(() => resolveFigure(args, money(), { checkText }), (e) => e instanceof DataError && re.test(e.message)));
}

test('a grounded figure in the title passes and control characters are stripped', () => {
  const { block } = resolveFigure({ kind: 'donut', title: 'Estalvi 30,5 €\u0007', series: [{ dataset: 'd1', column: 'savings_eur', label: 'a' }, { dataset: 'd1', column: 'estimated_eur', label: 'b' }] }, money(), { checkText });
  assert.equal(block.title, 'Estalvi 30,5 €');
});
