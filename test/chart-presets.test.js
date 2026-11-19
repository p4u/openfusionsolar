process.env.TZ = 'Europe/Madrid';
// Chart presets under Node: the pure parts (data in, spec out; request checks). Drawing needs a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../public/js/i18n.js';
import { PRESET_TYPES, presetModel, presetCheck } from '../public/js/chart-presets.js';
import { bill, summaryOf } from './fixtures/billing-summary.js';

setLang('en');

const ENTITIES = new Set(['sun', 'home', 'grid', 'battery', 'sold', 'discharge', 'fixed', 'ac', 'p1', 'p2', 'p3', 'ok', 'warn', 'alarm', 'muted']);
const energy = {
  bucket: '1mo', total: { import_p1: 10, import_p2: 20, import_p3: 30 },
  buckets: ['2026-08', '2026-09'].map((key) => ({ key, from: `${key}-01`, to: `${key}-28`, coverage: 1, provisional: false, pv_kwh: 300, load_kwh: 200, import_kwh: 60, export_kwh: 150, import_p1: 10, import_p2: 20, import_p3: 30 })),
};
const t0 = Date.UTC(2026, 10, 10);
const series = {
  bucket: '1h', t: [t0, t0 + 3600e3, t0 + 7200e3], coverage: [1, 1, 1], provisional: [false, false, false],
  series: { pv_kw: [0, 1, 2], load_kw: [1, 1, 1], imp_kw: [1, 0, 0], exp_kw: [0, 0, 1], soc: [50, 60, 70] },
};
const summary = summaryOf([bill(1, '2026-09', 'ok'), bill(2, '2026-10', 'nodata')]);
const DATA = { energy_bars: energy, import_by_period: energy, power_lines: series, battery_soc: series };

test('every preset type builds a single-axis spec from fixture data', () => {
  for (const type of [...PRESET_TYPES, 'bill_by_period', 'bill_surplus']) {
    const m = presetModel(type, DATA[type] ?? summary);
    assert.ok(m, type);
    const { spec } = m;
    assert.equal(typeof spec.unit, 'string', `${type}: one unit`);
    assert.ok(!Array.isArray(spec.y) && !spec.y2 && !spec.series.some((s) => s.axis || s.yAxis), `${type}: one y axis`);
    assert.ok(spec.series.length > 0);
    for (const s of spec.series) {
      assert.ok(ENTITIES.has(s.entity), `${type}: ${s.entity}`);
      assert.equal(s.data.length, m.rows.length, `${type}: ${s.key} has one value per table row`);
    }
    assert.equal(m.iso.length, m.rows.length);
  }
  // one bill: billed against measured per period
  const one = presetModel('bill_kwh_vs_measured', bill(1, '2026-09', 'ok').compare, { invoice: true });
  assert.deepEqual(one.spec.x.categories.length, 3);
  assert.equal(one.spec.series[1].data[0], 11);
  assert.equal(presetModel('bill_breakdown', { invoices: [] }), null);
});

test('surplus is drawn below zero', () => {
  const s = presetModel('bill_breakdown', summary).spec.series.find((x) => x.key === 'surplus');
  assert.equal(s.entity, 'sold');
  assert.equal(s.below, true);
  assert.ok(s.data.every((v) => v <= 0));
  assert.equal(s.data[0], -1.5);
  const sold = presetModel('energy_bars', energy).spec.series.find((x) => x.key === 'sold');
  assert.equal(sold.below, true);
  assert.deepEqual(sold.data, [-150, -150]);
});

test('bills that cannot be compared stay out of the crossed charts and are named', () => {
  const m = presetModel('bill_kwh_vs_measured', summary);
  assert.equal(m.spec.series[1].data[1], null); // measured: nothing, not zero
  assert.match(m.caption, /Not compared: .*October.*12 days/);
  assert.equal(presetModel('savings', summary).spec.series[0].data[1], null);
});

test('power presets refuse ranges over 7 days', () => {
  for (const type of ['power_lines', 'battery_soc']) {
    assert.equal(presetCheck(type, { from: '2026-11-01', to: '2026-11-09' }), 'billing.preset.range');
    assert.equal(presetCheck(type, { from: '2026-11-01', to: '2026-11-07' }), null);
    assert.equal(presetCheck(type, { from: '2026-11-01', to: '2026-11-07', bucket: '5m' }), 'billing.preset.bucket');
  }
  assert.equal(presetCheck('energy_bars', { from: '2026-01-01', to: '2026-12-31', bucket: '1mo' }), null);
  assert.equal(presetCheck('pie_chart', { from: '2026-11-01', to: '2026-11-02' }), 'billing.preset.unknown');
  assert.equal(presetCheck('bill_kwh_vs_measured', { invoiceId: 3 }), null);
});
