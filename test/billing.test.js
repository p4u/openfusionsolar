process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/db.js';
import { normalise, toRow } from '../src/invoice-schema.js';
import { periodMoney } from '../src/tariff.js';
import { pricesFromInvoice, compareInvoice, billingSummary } from '../src/billing.js';
import { startTestServer } from './helpers.js';

const { row: bill, readings } = toRow(normalise(JSON.parse(readFileSync(new URL('./fixtures/bills/sample-v1.json', import.meta.url)))));
const ENV = { p1: 0.249, p2: 0.169, p3: 0.15, export: 0.03, adjust: 0.029, powerP1: 29.934, powerP2: 2.955, contractedP1: 4.4, contractedP2: 4.4,
  socialDay: 0.024839, meterDay: 0.044839, iee: 0.0511269, vat: 0.21 };
const TODAY = '2026-11-19';
// the day `i` days after the first of month `m` (1-12) of year `y`
const day = (y, m, i) => new Date(Date.UTC(y, m - 1, 1 + i)).toISOString().slice(0, 10);

// October 2026 with the billed kWh spread evenly over `n` days, scaled by `k`
function fill(store, n, k = 1) {
  for (let i = 0; i < n; i++) {
    const [p1, p2, p3] = [25.704, 29.651, 103.725].map((v) => (v * k) / 31);
    store.saveDaily(day(2026, 10, i), {
      import_p1: p1, import_p2: p2, import_p3: p3, import_kwh: p1 + p2 + p3, export_kwh: 24 / 31,
      load_p1: p1 + 0.5, load_p2: p2 + 0.5, load_p3: p3 + 1, load_kwh: p1 + p2 + p3 + 2, pv_kwh: 5,
    });
  }
}
const confirmed = (store, over = {}) => store.insertInvoice({ ...bill, status: 'confirmed', ...over }, [], readings);
const setup = (k = 1) => {
  const store = new Store(':memory:');
  fill(store, 31, k);
  return store;
};

test('prices from the sample bill rebuild its energy and fixed terms within a cent', () => {
  const p = pricesFromInvoice(bill);
  const rows = Array.from({ length: 31 }, (_, i) => ({ day: day(2026, 10, i), import_p1: 25.704 / 31, import_p2: 29.651 / 31, import_p3: 103.725 / 31, load_p1: 0 }));
  const m = periodMoney(rows, { ...p, iee: 0, vat: 0, socialDay: 0, meterDay: 0, powerP1: 0, powerP2: 0 });
  assert.ok(Math.abs(m.bought - 31.59) < 0.01, `${m.bought}`); // 26.97 + adjust 4.62
  const fixed = periodMoney(rows, p).fixed;
  assert.ok(Math.abs(fixed - ((12.29 + 0.77) * 1.0511269 + 1.39) * 1.21) < 0.01, `${fixed}`);
  assert.equal(pricesFromInvoice({ ...bill, price_p2: null }), null);
  assert.equal(pricesFromInvoice({ ...bill, kwh_p1: null, kwh_p2: null, kwh_p3: null }).adjust, 0);
});

test('kwh verdicts at 4, 7 and 12 percent', () => {
  const store = setup();
  for (const [k, verdict] of [[1.04, 'ok'], [1.07, 'small'], [1.12, 'check']]) {
    // measured stays put; the bill says k times as much
    const inv = { ...bill, kwh_p1: bill.kwh_p1 * k, kwh_p2: bill.kwh_p2 * k, kwh_p3: bill.kwh_p3 * k };
    const c = compareInvoice(store, inv, { prices: ENV });
    assert.equal(c.verdict, verdict, String(k));
    assert.ok(Math.abs(c.diffKwh - 159.08 * (k - 1)) < 0.011, `${c.diffKwh}`); // billed - measured, in kWh
    assert.equal(c.coverage, 1);
  }
});

test('measured import 0 with billed kwh is a check', () => {
  const store = new Store(':memory:');
  fill(store, 31, 0);
  assert.equal(compareInvoice(store, bill).verdict, 'check');
});

test('fewer than 90 percent of days with data cannot compare', () => {
  const store = new Store(':memory:');
  fill(store, 27); // 27 of 31 = 87 %
  const c = compareInvoice(store, bill, { prices: ENV });
  assert.equal(c.verdict, 'nodata');
  assert.equal(c.diff, null);
  assert.equal(c.kwh.measured, null);
  assert.equal(c.daysWithData, 27);
  fill(store, 28);
  assert.notEqual(compareInvoice(store, bill, { prices: ENV }).verdict, 'nodata'); // 28 of 31 = 90 %
});

test('the gap splits into price change and kwh difference, and the donation is other', () => {
  const store = setup();
  const same = compareInvoice(store, bill, { prices: pricesFromInvoice(bill) });
  assert.equal(same.diff.prices, 0);
  const dear = compareInvoice(store, bill, { prices: { ...ENV, p1: ENV.p1 * 1.1, p2: ENV.p2 * 1.1, p3: ENV.p3 * 1.1 } });
  assert.ok(dear.diff.prices < 0, 'the bill prices sit below an env 10 % higher');
  const cheap = compareInvoice(store, bill, { prices: { ...ENV, p1: 0.2, p2: 0.12, p3: 0.1 } });
  assert.ok(cheap.diff.prices > 0);
  assert.equal(same.diff.other, 1.59);
  assert.ok(Math.abs(same.diff.kwh - (59.15 - same.estimateBill - 1.59)) < 0.011);
  // the whole gap against the app's forecast is its three parts
  for (const c of [same, dear, cheap]) assert.ok(Math.abs(c.diff.total - (c.diff.kwh + c.diff.prices + c.diff.other)) < 0.021);
  assert.ok(Math.abs(same.diff.total - (59.15 - same.estimateEnv)) < 0.011);
  assert.ok(Math.abs(same.estimateBill - 57.56) < 1, `${same.estimateBill}`); // the bill without the donation
});

test('a bill without a period or with 0 days cannot compare and does not throw', () => {
  const store = setup();
  for (const inv of [{ ...bill, period_from: null, period_to: null, days: null }, { ...bill, days: 0 }, { ...bill, period_from: '2026-10-31', period_to: '2026-10-01' }]) {
    const c = compareInvoice(store, inv, { prices: ENV });
    assert.equal(c.verdict, 'nodata');
    assert.equal(c.coverage, 0);
    assert.equal(c.savings, null);
  }
});

test('without configured prices the comparison still returns kwh and the bill-price estimate', () => {
  const c = compareInvoice(setup(), bill, { prices: null });
  assert.equal(c.estimateEnv, null);
  assert.ok(c.estimateBill > 0);
  assert.equal(c.diff.prices, null);
  assert.ok(c.diff.kwh != null);
  assert.ok(c.kwh.measured.total > 0);
  const s = compareInvoice(setup(), { ...bill, price_p1: null }, { prices: null });
  assert.equal(s.estimateBill, null);
  assert.equal(s.diff.kwh, null);
  assert.equal(s.savings, null);
});

test('a bill over two months is capped once', () => {
  const store = new Store(':memory:');
  // 20 surplus days in September, then 10 buying days in October
  for (let i = 10; i < 30; i++) store.saveDaily(day(2026, 9, i), { import_p1: 0, import_p2: 0, import_p3: 0, import_kwh: 0, export_kwh: 10, load_p1: 0, load_kwh: 0 });
  for (let i = 0; i < 10; i++) store.saveDaily(day(2026, 10, i), { import_p1: 0, import_p2: 0, import_p3: 1, import_kwh: 1, export_kwh: 0, load_p1: 0, load_kwh: 1 });
  const p = { ...ENV, adjust: 0, iee: 0, vat: 0, powerP1: 0, powerP2: 0, socialDay: 0, meterDay: 0 };
  const inv = { ...bill, period_from: '2026-09-11', period_to: '2026-10-10', days: 30, kwh_p1: 0, kwh_p2: 0, kwh_p3: 10, adjust_eur: 0,
    social_bonus_eur: 0, meter_rent_eur: 0, power_eur: 0, elec_tax_pct: 0, vat_pct: 0, other_exempt_eur: 0 };
  // surplus 200 kWh x 0.03 = 6 against 10 kWh x 0.15 = 1.5: one cap gives 0, a cap per month would give 1.5
  assert.equal(compareInvoice(store, inv, { prices: p }).estimateEnv, 0);
});

test('savings separate avoided purchases from the surplus discount', () => {
  const store = setup();
  const s = compareInvoice(store, bill, { prices: ENV }).savings;
  assert.ok(s.avoided > 0 && s.surplusDiscount > 0);
  assert.ok(Math.abs(s.surplusDiscount - 0.72 * 1.0511269 * 1.21) < 0.011);
  // the two parts add up to the saving to the cent, with no unexplained remainder
  assert.equal(Math.round((s.avoided + s.surplusDiscount) * 100), Math.round((s.withoutSolar - bill.total_eur) * 100));
  assert.equal(s.surplusDiscountPrinted, 0.72);
  assert.equal('other' in s, false);
  assert.equal(compareInvoice(store, bill).surplus.lostEur, 0);
  assert.equal(compareInvoice(store, { ...bill, surplus_lost_eur: 3.1 }).surplus.lostEur, 3.1);
  assert.equal(compareInvoice(store, { ...bill, surplus_lost_eur: null, surplus_eur: 40 }).surplus.lostEur, 8.41);
});

test('superseded and draft bills are left out', () => {
  const store = setup();
  const keep = confirmed(store);
  confirmed(store, { invoice_number: 'X2', superseded_by: keep });
  confirmed(store, { invoice_number: 'X3', status: 'draft' });
  const s = billingSummary(store, { from: '2026-10-01', to: '2026-10-31', today: TODAY });
  assert.deepEqual(s.invoices.map((i) => i.id), [keep]);
  assert.equal(s.review.length, 1);
  assert.equal(s.tiles.bills, 1);
  const b = s.invoices[0];
  assert.ok(Math.abs(b.parts.energy - b.parts.surplus + b.parts.fixed + b.parts.taxes + b.parts.other - 59.15) < 0.011);
  assert.ok(Math.abs(Object.values(s.breakdown).reduce((t, v) => t + v.eur, 0) - 59.15) < 0.011);
});

test('bills are labelled by the month holding most of their days', () => {
  const store = setup();
  const keep = confirmed(store);
  const late = confirmed(store, { invoice_number: 'X4', period_from: '2026-09-15', period_to: '2026-10-14', days: 30 });
  const m = billingSummary(store, { from: '2026-09-01', to: '2026-10-31', today: TODAY }).invoices;
  assert.equal(m.find((i) => i.id === late).month, '2026-09'); // 16 days in September, 14 in October
  assert.equal(m.find((i) => i.id === keep).month, '2026-10');
});

// a year of daily data and three bills; 5-minute samples give the daily peak (`over` days above the contracted power)
function year({ peakKw = 3, over = 0 } = {}) {
  const store = new Store(':memory:');
  for (let i = 0; i < 365; i++) {
    store.saveDaily(day(2025, 11, i), { import_p1: 1, import_p2: 1, import_p3: 3, import_kwh: 5, export_kwh: 3, load_p1: 1, load_kwh: 5 });
  }
  for (let i = 0; i < 3; i++) {
    confirmed(store, { invoice_number: `N${i}`, period_from: `2026-0${8 + i}-01`, period_to: `2026-0${8 + i}-30`, days: 30, max_demand_p1_kw: null, max_demand_p2_kw: null });
  }
  for (let d = 0; d < 20; d++) store.saveSample(Date.UTC(2026, 3, 1, 12) - d * 86400e3, { grid_kw: d < over ? 6 : peakKw, load_kw: 1 });
  return store;
}
const card = (s, id) => s.advice.find((c) => c.id === id);
const sum2 = (store, over = {}) => billingSummary(store, { from: '2025-11-20', to: TODAY, prices: ENV, today: TODAY, ...over });

test('each advice rule turns on and off', () => {
  const low = sum2(year({ peakKw: 3 }));
  assert.equal(card(low, 'power').state, 'lower'); // 3 kW is 68 % of 4.4
  assert.equal(card(low, 'power').numbers.suggestedKw, 3.8);
  assert.ok(card(low, 'power').numbers.savingsYear > 0);
  assert.equal(card(sum2(year({ peakKw: 4 })), 'power').state, 'ok'); // 91 %
  const over = card(sum2(year({ peakKw: 3, over: 2 })), 'power');
  assert.equal(over.state, 'keep');
  assert.equal(over.numbers.daysOver, 2);
  assert.equal(over.numbers.savingsYear, null);

  assert.equal(card(low, 'prices').state, 'same');
  assert.equal(card(sum2(year(), { prices: { ...ENV, p1: 0.3 } }), 'prices').state, 'differ');
  assert.equal(card(sum2(year(), { prices: { ...ENV, p1: 0.249 * 1.019 } }), 'prices').state, 'same'); // within 2 %
  assert.equal(card(sum2(year(), { prices: null }), 'prices').state, 'unset');
  assert.ok(card(low, 'prices').numbers.lines.includes('PRICE_P1=0.249'));

  assert.equal(card(low, 'peak').state, 'low'); // 16 % in P1
  const peaky = year();
  for (const id of [1, 2, 3]) peaky.updateInvoice(id, { kwh_p1: 80 });
  assert.equal(card(sum2(peaky), 'peak').state, 'high');

  assert.equal(card(low, 'surplus').state, 'worth'); // 0.17 / 0.03
  assert.ok(card(low, 'tariff').numbers.allInPerKwh > 0);

  const gap = year();
  gap.db.prepare("delete from daily where day < '2026-08-01'").run(); // measured only where the three bills are (92 days)
  assert.equal(card(sum2(gap), 'data').state, 'ok');
  gap.updateInvoice(2, { period_from: '2026-09-05' });
  gap.insertInvoice({ ...bill, status: 'draft', invoice_number: 'D', period_from: '2026-05-01', period_to: '2026-05-31' });
  const data = card(sum2(gap), 'data');
  assert.equal(data.state, 'attention');
  assert.equal(data.numbers.review.length, 1);
});

test('no advice with fewer than 3 bills or 90 days of data', () => {
  const store = year();
  store.db.prepare('delete from invoices where id = 3').run();
  assert.deepEqual(sum2(store).advice.map((c) => c.id), ['power', 'data'], 'only the power card, which needs measured days alone');
  const few = new Store(':memory:');
  fill(few, 31);
  for (let i = 0; i < 3; i++) confirmed(few, { invoice_number: `F${i}` });
  const s = billingSummary(few, { from: '2026-10-01', to: '2026-10-31', today: TODAY, prices: ENV });
  assert.deepEqual(s.advice.map((c) => c.id), ['data']); // 31 days of data
});

test('api returns 400 for bad ranges and 401 without a session', async () => {
  const store = setup();
  const id = confirmed(store);
  const t = await startTestServer({ store, config: { prices: ENV } });
  try {
    assert.equal((await t.request('/api/billing?from=2026-10-31&to=2026-10-01')).status, 400);
    assert.equal((await t.request('/api/billing?from=1900-01-01&to=2026-10-01')).status, 400);
    assert.equal((await t.request('/api/billing?from=x&to=2026-10-01')).status, 400);
    const ok = await t.request('/api/billing?from=2026-10-01&to=2026-10-31');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.invoices.length, 1);
    assert.ok(!JSON.stringify(body).includes('ES0031'), 'no CUPS in the response');
    const one = await t.request(`/api/billing/invoice?id=${id}`);
    assert.equal((await one.json()).verdict, 'ok');
    assert.equal((await t.request('/api/billing/invoice?id=999')).status, 404);
    assert.equal((await t.request('/api/billing/invoice?id=abc')).status, 404);
    assert.equal((await fetch(`${t.base}/api/billing?from=2026-10-01&to=2026-10-31`)).status, 401);
  } finally {
    await t.close();
  }
});

test('the fixed part is power, social bonus and meter rent with taxes, never the donation', () => {
  const store = setup();
  confirmed(store);
  const s = billingSummary(store, { from: '2026-10-01', to: '2026-10-31', today: TODAY });
  assert.deepEqual(s.fixedPart, { eur: 18.29, pct: 30.9 }); // ((12.29 + 0.77) x 1.0511269 + 1.39) x 1.21 of 59.15
  const none = billingSummary(store, { from: '2025-10-01', to: '2025-10-31', today: TODAY });
  assert.deepEqual(none.fixedPart, { eur: 0, pct: null });
});

test('the power card needs only measured days: one bill and 40 days', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 40; i++) store.saveDaily(day(2026, 9, i), { import_p1: 1, import_p2: 1, import_p3: 3, import_kwh: 5, export_kwh: 3, load_p1: 1, load_kwh: 5 });
  for (let d = 0; d < 20; d++) store.saveSample(Date.UTC(2026, 9, 1, 12) + d * 86400e3, { grid_kw: 3, load_kw: 1 });
  const id = confirmed(store, { max_demand_p1_kw: null, max_demand_p2_kw: null });
  const run = (prices = ENV) => card(billingSummary(store, { from: '2026-10-01', to: '2026-10-31', today: TODAY, prices }), 'power');
  const s = billingSummary(store, { from: '2026-10-01', to: '2026-10-31', today: TODAY, prices: ENV });
  assert.deepEqual(s.advice.map((c) => c.id), ['power', 'data']);
  const p = run();
  assert.equal(p.state, 'lower');
  assert.equal(p.basis, 'measured_peaks');
  assert.equal(p.caveat, 'billing.advice.power.caveat');
  assert.deepEqual([p.numbers.contractedKw, p.numbers.maxKw, p.numbers.measuredDays, p.numbers.suggestedKw], [4.4, 3, 40, 3.8]);
  assert.ok(p.numbers.savingsYear > 0);

  // the sample bill printed 4.952 kW against 4.4 contracted: keep, whatever the 5-minute samples say
  store.updateInvoice(id, { max_demand_p1_kw: 4.952, max_demand_p2_kw: 3.572 });
  const keep = run();
  assert.equal(keep.state, 'keep');
  assert.deepEqual([keep.numbers.billMaxP1Kw, keep.numbers.daysOver, keep.numbers.suggestedKw, keep.numbers.savingsYear], [4.952, 0, null, null]);
  // each printed maximum against its own period: 5 kW in P1 is over a 4.4 kW P1 even with a larger P2
  store.updateInvoice(id, { contracted_p1_kw: 4.4, contracted_p2_kw: 6.9, max_demand_p1_kw: 5, max_demand_p2_kw: 3 });
  assert.equal(run().state, 'keep');
  store.updateInvoice(id, { contracted_p1_kw: 4.4, contracted_p2_kw: 4.4 });

  // no bill: contracted power and power prices from the configuration; none configured, no card
  store.deleteInvoice(id);
  const env = run({ ...ENV, contractedP1: 5.5, contractedP2: 5.5 });
  assert.deepEqual([env.state, env.numbers.contractedKw, env.numbers.billMaxP1Kw], ['lower', 5.5, null]);
  assert.equal(run(null), undefined);

  // under 30 measured days, no card
  const few = new Store(':memory:');
  for (let i = 0; i < 29; i++) few.saveDaily(day(2026, 9, i), { import_p1: 1, import_p2: 1, import_p3: 3, import_kwh: 5, load_kwh: 5 });
  few.saveSample(Date.UTC(2026, 9, 1, 12), { grid_kw: 3, load_kw: 1 });
  assert.equal(card(billingSummary(few, { from: '2026-10-01', to: '2026-10-31', today: TODAY, prices: ENV }), 'power'), undefined);
});

test('missing months need measured days and agree with the data card', () => {
  const store = setup(); // October measured, no bill
  for (let i = 0; i < 10; i++) store.saveDaily(day(2026, 8, i), { import_kwh: 1 }); // August: 10 days, never missing
  const s = billingSummary(store, { from: '2026-01-01', to: TODAY, today: '2026-12-20' });
  assert.deepEqual(s.missing, ['2026-10']);
  assert.deepEqual(card(s, 'data').numbers.missing, s.missing);
  assert.deepEqual([s.tiles.months, s.tiles.measuredMonths], [11, 1]);
  assert.deepEqual(billingSummary(store, { from: '2026-01-01', to: TODAY, today: TODAY }).missing, [], 'within 45 days of its end');
  confirmed(store);
  assert.deepEqual(billingSummary(store, { from: '2026-01-01', to: TODAY, today: '2026-12-20' }).missing, []);
  // a bill for a month without measurements still counts: never "1 of 0"
  const bare = new Store(':memory:');
  confirmed(bare);
  const t = billingSummary(bare, { from: '2026-01-01', to: TODAY, today: '2026-12-20' }).tiles;
  assert.deepEqual([t.bills, t.measuredMonths], [1, 1]);
});
