process.env.TZ = 'Europe/Madrid';
// Bill view helpers, run under Node: month rows with and without prices, peak vs contracted power, meter phases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, setLang } from '../public/js/i18n.js';
import billDict from '../public/js/i18n/bill.js';
import { monthRows, peakVsContracted, phaseSignals } from '../public/js/views/bill-model.js';

register(billDict);

const bucket = (key, money) => ({
  key, days: 30, daysExpected: 30, coverage: 1, provisional: false, pv_kwh: 300, load_kwh: 400, import_kwh: 150, export_kwh: 50,
  import_p1: 20, import_p2: 30, import_p3: 100, money,
});

test('without prices the rows carry kWh only', () => {
  const rows = monthRows([bucket('2026-05', null), bucket('2026-06', null)]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.money, null);
    assert.equal(r.bought, 150);
    assert.deepEqual(r.byPeriod, [20, 30, 100]);
  }
});

test('with prices the rows carry the month bill terms', () => {
  const money = { energy: 12, fixed: 8, bill: 20, savings: 30, exportIncome: 3, withoutSolar: 42, bought: 15 };
  const [r] = monthRows([bucket('2026-05', money)]);
  assert.deepEqual(r.money, { energy: 12, fixed: 8, bill: 20, savings: 30, exportIncome: 3, withoutSolar: 42 });
});

test('peak rows flag days over the contracted power', () => {
  const res = peakVsContracted([{ day: '2026-05-01', peak: 3.2 }, { day: '2026-05-02', peak: 5.6 }, { day: '2026-05-03', peak: null }, { day: '2026-05-04', peak: 4.4 }], 4.4);
  assert.deepEqual(res.rows.map((r) => r.over), [false, true, false, false]); // equal is not over; no readings is not over
  assert.equal(res.overCount, 1);
  assert.equal(res.max, 5.6);
});

test('peak rows flag nothing without contracted power', () => {
  for (const kw of [undefined, null, 0]) {
    const res = peakVsContracted([{ day: '2026-05-01', peak: 9 }], kw);
    assert.equal(res.contracted, null);
    assert.equal(res.rows[0].over, false);
  }
});

test('phases come from W or kW signals named Pa, Pb, Pc and are scaled to kW', () => {
  const devices = [
    { dn: 'inv', signals: [{ id: 1, name: 'Active power', unit: 'kW' }] },
    { dn: 'meter', signals: [
      { id: 30003, name: 'Active power', unit: 'W' },
      { id: 30019, name: 'Active power Pc', unit: 'W' },
      { id: 30017, name: 'Active power Pa', unit: 'W' },
      { id: 30018, name: 'Active power Pb', unit: 'kW' },
      { id: 5, name: 'Voltage Pa', unit: 'V' },
    ] },
  ];
  const p = phaseSignals(devices);
  assert.equal(p.dn, 'meter');
  assert.deepEqual(p.signals, [{ id: 30017, phase: 'Pa', scale: 0.001 }, { id: 30018, phase: 'Pb', scale: 1 }, { id: 30019, phase: 'Pc', scale: 0.001 }]);
  assert.equal(phaseSignals([devices[0]]), null);
  assert.equal(phaseSignals(undefined), null);
});

// ruling R26: key names only in the Settings administrator detail; the bill sentence points there
test('the price keys are named for the administrator, and the money sentence points there', async () => {
  const { default: settingsDict } = await import('../public/js/i18n/settings.js');
  for (const lang of ['en', 'ca']) {
    const admin = settingsDict[lang]['settings.admin.prices'];
    assert.ok(admin.includes('PRICE_P1') && admin.includes('PRICE_P3'), lang);
    assert.ok(billDict[lang]['bill.noPrices'].includes(settingsDict[lang]['settings.admin.title']), lang);
    assert.doesNotMatch(billDict[lang]['bill.noPrices'], /PRICE_|\.env/, lang);
  }
});

test('the month table totals each column and keeps unknown columns empty', async () => {
  const { monthTotals } = await import('../public/js/views/bill-model.js');
  const rows = [
    { bought: 10, sold: 1, byPeriod: [2, 3, 5], money: { energy: 3, fixed: 10, bill: 13, savings: 4 } },
    { bought: 20, sold: null, byPeriod: [4, null, 16], money: { energy: 6, fixed: 10, bill: 16, savings: 5 } },
  ];
  assert.deepEqual(monthTotals(rows), { bought: 30, sold: 1, byPeriod: [6, 3, 21], money: { energy: 9, fixed: 20, bill: 29, savings: 9 } });
  assert.equal(monthTotals([{ bought: null, sold: null, byPeriod: [null, null, null], money: null }]).money, null);
});

test('real bill amounts are read the way people type them, and wrong ones are named', async () => {
  const { parseAmount, billDelta } = await import('../public/js/views/bill-model.js');
  assert.deepEqual(parseAmount('61,23'), { value: 61.23 });
  assert.deepEqual(parseAmount('61.23'), { value: 61.23 });
  assert.deepEqual(parseAmount(' 1.234,5 € '), { value: 1234.5 });
  assert.deepEqual(parseAmount('1,234.56'), { value: 1234.56 });
  assert.deepEqual(parseAmount('0'), { value: 0 });
  assert.deepEqual(parseAmount(''), { value: null }, 'empty clears the month');
  assert.deepEqual(parseAmount('-5'), { error: 'negative' });
  assert.deepEqual(parseAmount('abc'), { error: 'format' });
  assert.deepEqual(parseAmount('12,345'), { value: 12345 }, 'three digits after a comma group thousands');
  assert.deepEqual(parseAmount('61,234'), { value: 61234 });
  assert.deepEqual(parseAmount('2000000'), { error: 'range' });
  assert.equal(billDelta(61.23, 58.1), 3.13);
  assert.equal(billDelta(null, 58.1), null);
  assert.equal(billDelta(50, null), null);
});

test('the totals row adds the real bills typed so far and their difference with the estimate', async () => {
  const { realTotals } = await import('../public/js/views/bill-model.js');
  const rows = [
    { key: '2026-01', money: { bill: 80.5 } },
    { key: '2026-02', money: { bill: 40 } },
    { key: '2026-03', money: null }, // no estimate: its real amount is summed, not compared
    { key: '2026-04', money: { bill: 20 } },
  ];
  assert.deepEqual(realTotals(rows, { '2026-01': 82.1, '2026-02': 39.95, '2026-03': 30 }), { real: 152.05, delta: 1.55, n: 3, m: 4 });
  assert.deepEqual(realTotals(rows, {}), { real: null, delta: null, n: 0, m: 4 });
  assert.deepEqual(realTotals(rows, { '2026-03': 30 }), { real: 30, delta: null, n: 1, m: 4 });
});

test('period kWh are rounded to add up to the rounded bought total', async () => {
  const { periodParts } = await import('../public/js/views/bill-model.js');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const p = periodParts([300.4, 400.4, 385.4], 1086.2);
  assert.equal(sum(p), 1086);
  assert.equal(sum(periodParts([0.5, 0.5, 0.5], 1.5)), 2);
  assert.deepEqual(periodParts([10.4, null, 5.2], 16), [10, null, 5]);
  assert.deepEqual(periodParts([10.4, 5.2, 1], 30), [10, 5, 1]); // parts that do not account for the total are only rounded
});

test('an invalid amount keeps the saved value in the message and the totals on the saved bills', async () => {
  const { t } = await import('../public/js/i18n.js');
  const { realTotals } = await import('../public/js/views/bill-model.js');
  for (const lang of ['ca', 'en']) {
    setLang(lang);
    assert.match(t('bill.table.realKept', { amount: '90,50 €' }), /90,50 €/);
  }
  setLang('ca');
  assert.match(t('bill.table.realKept', { amount: '90,50 €' }), /^Es manté el valor desat: 90,50 €/);
  setLang('en');
  const rows = [{ key: '2026-01', money: { bill: 80 } }];
  assert.deepEqual(realTotals(rows, { '2026-01': 90.5 }), { real: 90.5, delta: 10.5, n: 1, m: 1 });
});

test('a month inside a Catalan sentence is lowercase and takes the elided preposition', async () => {
  const { fmtMonth } = await import('../public/js/format.js');
  const { ofPeriod } = await import('../public/js/views/energy-model.js');
  const { t } = await import('../public/js/i18n.js');
  setLang('ca');
  const label = (m) => t('bill.table.realFor', { month: ofPeriod(fmtMonth(m, { mid: true })) });
  assert.match(label('2026-04'), /^Factura real d’abril (de |del )2026, en euros$/);
  assert.match(label('2026-05'), /^Factura real de maig (de |del )2026/);
  assert.match(label('2025-10'), /^Factura real d’octubre/);
  assert.match(fmtMonth('2026-01'), /^Gener/, 'a month that starts a line keeps its capital');
  setLang('en');
  assert.match(label('2026-04'), /^Real bill for April 2026/);
});
