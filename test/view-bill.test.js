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

test('the money sentence names the .env keys in both languages', () => {
  for (const lang of ['en', 'ca']) {
    setLang(lang);
    assert.ok(billDict[lang]['bill.noPrices'].includes('PRICE_P1') && billDict[lang]['bill.noPrices'].includes('PRICE_P3'), lang);
  }
});
