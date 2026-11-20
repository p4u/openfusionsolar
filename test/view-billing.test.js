process.env.TZ = 'Europe/Madrid';
// Billing summary helpers under Node: status sentence, share bar, reconciliation rows, advice text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang, t } from '../public/js/i18n.js';
import { statusSentence, breakdownSegments, reconRows, adviceView, savingsSplit, fixedShare, adviceNote } from '../public/js/views/billing-model.js';
import { bill, summaryOf } from './fixtures/billing-summary.js';

test('status sentence counts bills and names the reconciling one', () => {
  const s = summaryOf([bill(1, '2026-09', 'small'), bill(2, '2026-10', 'ok')]);
  s.tiles.bills = 11;
  setLang('ca');
  assert.equal(statusSentence(s, 'ca'), 'Tens 11 de 12 factures de l’últim any. La d’octubre quadra amb el que hem mesurat.');
  setLang('en');
  assert.equal(statusSentence(s, 'en'), 'You have 11 of 12 bills from the last year. The October bill matches what we measured.');
  s.tiles.months = 3;
  assert.match(statusSentence(s, 'en'), /^You have 11 of 3 bills in this period\./);
  assert.equal(statusSentence(summaryOf([]), 'en'), null);
  setLang('ca');
  assert.match(statusSentence(summaryOf([bill(1, '2026-03', 'check')]), 'ca'), /La de març no quadra/);
});

test('no comparison is shown as cannot compare with the missing days', () => {
  setLang('en');
  const s = summaryOf([bill(1, '2026-10', 'nodata')]);
  assert.match(statusSentence(s, 'en'), /The October bill cannot be compared: 12 days of measurements missing\./);
  const [row] = reconRows(s.invoices);
  assert.equal(row.verdict, 'nodata');
  assert.equal(row.missingDays, 12);
  assert.equal(row.measured, null); // never a made-up difference
  assert.equal(row.diffPct, null);
  assert.equal(row.reason, null);
});

test('breakdown segments add up to 100', () => {
  const sum = (segs) => segs.reduce((a, x) => a + x.pct, 0);
  assert.equal(sum(breakdownSegments(summaryOf([bill(1, '2026-10')]))), 100);
  const odd = summaryOf([], { breakdown: { energy: { eur: 10 }, fixed: { eur: 10 }, taxes: { eur: 10 }, other: { eur: 0 } } });
  assert.equal(sum(breakdownSegments(odd)), 100); // thirds
  const negative = summaryOf([], { breakdown: { energy: { eur: -3 }, fixed: { eur: 6 }, taxes: { eur: 2 }, other: { eur: 0 } } });
  const segs = breakdownSegments(negative);
  assert.equal(sum(segs), 100);
  assert.equal(segs[0].pct, 0); // a part below zero counts as none
  assert.deepEqual(breakdownSegments(summaryOf([], { breakdown: { energy: { eur: 0 }, fixed: { eur: 0 }, taxes: { eur: 0 }, other: { eur: 0 } } })), []);
});

test('reconciliation rows say which cause explains the euro gap', () => {
  const a = bill(1, '2026-09');
  a.compare.diff = { prices: 3, kwh: 1, other: 0 };
  const b = bill(2, '2026-10');
  b.compare.diff = { prices: 0.1, kwh: 0.2, other: 1.59 };
  const c = bill(3, '2026-11');
  c.compare.diff = { prices: null, kwh: null, other: 0 };
  const rows = reconRows([a, b, c]);
  assert.deepEqual(rows.map((r) => r.month), ['2026-11', '2026-10', '2026-09']); // newest first
  assert.deepEqual(rows.map((r) => r.reason), ['noEstimate', 'other', 'prices']);
  assert.equal(rows[2].reasonEur, 3);
});

test('advice cards come as plain text, the prices lines as data and the savings split adds up', () => {
  setLang('en');
  const prices = adviceView({ id: 'prices', state: 'differ', period: { from: '2026-09-01', to: '2026-09-28' },
    numbers: { env: { p1: 0.2, p2: 0.1, p3: 0.1 }, bill: { p1: 0.249, p2: 0.169, p3: 0.15 }, lines: ['PRICE_P1=0.249'] } });
  assert.deepEqual(prices.lines, ['PRICE_P1=0.249']);
  assert.match(prices.text, /configuration file/);
  assert.doesNotMatch(prices.text, /PRICE_|\.env/);
  const power = adviceView({ id: 'power', state: 'lower', period: { from: '2025-11-20', to: '2026-11-19' }, numbers: { contractedKw: 4.4, maxKw: 2.5, daysOver: 0, suggestedKw: 3.2, savingsYear: 30 } });
  assert.match(power.text, /lower it to 3\.20.kW/);
  assert.match(power.caveat, /power cut/);
  const data = adviceView({ id: 'data', state: 'attention', period: { from: '2025-11-20', to: '2026-11-19' }, numbers: { missing: ['2026-05'], review: [4], check: [] } });
  assert.match(data.text, /Months with no bill/);
  assert.match(data.text, /1 bill waiting for review\./);
  assert.match(adviceView({ id: 'data', state: 'attention', period: { from: '2025-11-20', to: '2026-11-19' }, numbers: { missing: [], review: [4, 5], check: [6] } }).text,
    /^2 bills waiting for review\. 1 bill does not match/);
  const split = savingsSplit([bill(1, '2026-09'), bill(2, '2026-10', 'nodata')]);
  assert.equal(split.bills, 1);
  assert.equal(Math.round((split.avoided + split.surplus + split.other) * 100) / 100, split.saved);
  assert.equal(split.printed, null); // the server did not send the printed discount
});

test('the savings split adds up with no remainder and keeps the printed discount', () => {
  const a = bill(1, '2026-10');
  a.compare.savings = { withoutSolar: 125.39, avoided: 65.32, surplusDiscount: 0.92, surplusDiscountPrinted: 0.72 };
  const split = savingsSplit([a]);
  assert.deepEqual(split, { bills: 1, saved: 66.24, avoided: 65.32, surplus: 0.92, other: 0, printed: 0.72 });
});

test('reconciliation rows say of what and which way the gap goes', () => {
  setLang('en');
  const bills = [1, 2, 3, 4].map((id) => bill(id, `2026-0${id}`));
  [{ prices: 0, kwh: 3.34, other: 0 }, { prices: 0, kwh: -2, other: 0 }, { prices: 1, kwh: 0, other: 0 }, { prices: -1, kwh: 0, other: 0 }]
    .forEach((d, i) => { bills[i].compare.diff = d; });
  const keys = Object.fromEntries(reconRows(bills).map((r) => [r.id, r.reasonKey]));
  assert.deepEqual(keys, { 1: 'billing.recon.kwhMore', 2: 'billing.recon.kwhLess', 3: 'billing.recon.pricesMore', 4: 'billing.recon.pricesLess' });
  assert.match(t(keys[1], { eur: '3,34 €' }), /charges more than we measured, 3,34 € against you/);
});

test('the fixed share is power, social bonus and meter rent over the total, never the donation', () => {
  const a = bill(1, '2026-10');
  a.total = 59.15;
  a.parts = { energy: 31.59, fixed: 14.45, taxes: 10, other: 2.31, surplus: 0.72 }; // other: a voluntary donation
  assert.equal(fixedShare([a]), 24);
  assert.equal(fixedShare([]), null);
  assert.equal(fixedShare([{ ...a, total: 0 }]), null);
});

test('advice with one bill keeps the power card and says the others need more data', () => {
  assert.equal(adviceNote([{ id: 'data' }]), 'billing.advice.notEnough');
  assert.equal(adviceNote([{ id: 'power' }, { id: 'data' }]), 'billing.advice.notEnoughOthers');
  assert.equal(adviceNote([{ id: 'power' }, { id: 'peak' }, { id: 'data' }]), null);
  setLang('en');
  const period = { from: '2025-11-20', to: '2026-11-19' };
  const keep = adviceView({ id: 'power', state: 'keep', period, basis: 'measured_peaks', caveat: 'billing.advice.power.nope',
    numbers: { contractedKw: 4.4, maxKw: 3.9, daysOver: 0, billMaxP1Kw: 4.952, billMaxP2Kw: 1.2 } });
  assert.match(keep.text, /maximum demand of 4\.95.kW, above the 4\.40.kW contracted/);
  assert.match(keep.caveat, /power cut/); // an unknown caveat key falls back to the usual one
  const ok = adviceView({ id: 'power', state: 'ok', period, numbers: { contractedKw: 4.4, maxKw: 3.9, daysOver: 0, billMaxP1Kw: 3.1 } });
  assert.match(ok.text, /The maximum demand on the bill was 3\.10.kW\./);
});

test('a gap without the bill prices to split it shows only its total', () => {
  const inv = { id: 1, month: '2026-10', period: { from: '2026-10-01', to: '2026-10-31' }, total: 59.15,
    compare: { verdict: 'ok', days: 31, daysWithData: 31, kwh: { billed: { total: 150 }, measured: { total: 150 } }, diff: { total: 4.95, kwh: null, prices: null, other: 1.59 } } };
  const [row] = reconRows([inv]);
  assert.deepEqual(row.gap, { total: 4.95 });
});
