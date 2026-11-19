import { test } from 'node:test';
import assert from 'node:assert/strict';
import { period, dayMoney, periodMoney } from '../src/tariff.js';

const at = (y, m, d, h) => new Date(y, m - 1, d, h, 30).getTime();

test('2.0TD periods on a weekday, weekend and holiday', () => {
  // Wednesday 2026-11-18
  assert.equal(period(at(2026, 11, 18, 3)), 'p3');
  assert.equal(period(at(2026, 11, 18, 9)), 'p2');
  assert.equal(period(at(2026, 11, 18, 11)), 'p1');
  assert.equal(period(at(2026, 11, 18, 15)), 'p2');
  assert.equal(period(at(2026, 11, 18, 19)), 'p1');
  assert.equal(period(at(2026, 11, 18, 23)), 'p2');
  assert.equal(period(at(2026, 11, 21, 19)), 'p3'); // Saturday
  assert.equal(period(at(2026, 12, 8, 19)), 'p3'); // Tuesday, national holiday
});

test('money without taxes or fixed terms', () => {
  const p = { p1: 0.25, p2: 0.17, p3: 0.15, export: 0.03, adjust: 0, powerP1: 0, powerP2: 0, contractedP1: 0, contractedP2: 0, socialDay: 0, meterDay: 0, iee: 0, vat: 0 };
  const day = { import_p1: 0, import_p2: 1, import_p3: 2, load_p1: 2, load_p2: 2, load_p3: 2, export_kwh: 10 };
  const m = dayMoney(day, p);
  assert.equal(+m.bought.toFixed(3), 0.47);
  assert.equal(+m.energy.toFixed(3), 0.17);
  assert.equal(+m.withoutSolar.toFixed(3), 1.14);
  assert.equal(+m.savings.toFixed(3), 0.97);
  assert.equal(m.fixed, 0);
  assert.equal(dayMoney({}, p), null);
  assert.equal(dayMoney(day, null), null);
});

test('fixed term matches the October 2026 Som Energia bill', () => {
  const p = { p1: 0, p2: 0, p3: 0, export: 0, adjust: 0, powerP1: 29.934, powerP2: 2.955, contractedP1: 4.4, contractedP2: 4.4,
    socialDay: 0.024688, meterDay: 0.044712, iee: 0.0511269, vat: 0.21 };
  // bill: power 12.29 + social 0.77 + IEE on them + meter 1.39, all with 21% VAT, over 31 days
  const month = dayMoney({ import_p1: 0 }, p).fixed * 31;
  const expected = ((12.29 + 0.77) * 1.0511269 + 1.39) * 1.21;
  assert.ok(Math.abs(month - expected) < 0.05, `${month} vs ${expected}`);
});

test('periodMoney caps the energy term at zero per calendar month', () => {
  const p = { p1: 1, p2: 1, p3: 1, export: 1, adjust: 0, powerP1: 0, powerP2: 0, contractedP1: 0, contractedP2: 0, socialDay: 0, meterDay: 0, iee: 0, vat: 0 };
  const days = [
    { day: '2026-09-01', import_p1: 0, load_p1: 0, export_kwh: 5 }, // net -5
    { day: '2026-10-01', import_p1: 3, load_p1: 3, export_kwh: 0 }, // net +3
  ];
  const m = periodMoney(days, p);
  assert.equal(m.energy, 3);
  assert.equal(m.bill, 3);
  assert.equal(m.savings, m.withoutSolar - 3);
  assert.equal(periodMoney(days, null), null);
});
