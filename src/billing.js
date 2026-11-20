// Bill reconciliation: each confirmed bill against what FusionSolar measured over the same days, plus the
// deterministic advice cards (spec 5.2, 5.3). Pure reads over the Store; nothing is prorated into months.
import { periodMoney } from './tariff.js';
import { localDay } from './collector.js';
import * as aggregate from './aggregate.js';
import { missingMonths, measuredMonths, isDate } from './invoice-schema.js';
import { addDays, addMonths, spanDays, billMonth } from '../public/js/buckets.js';

const P = ['p1', 'p2', 'p3'];
const num = (v) => (v == null ? 0 : Number(v));
const cents = (v) => (v == null ? null : Math.round(v * 100) / 100);
const sum = (list) => list.reduce((s, v) => s + v, 0);
const COVERAGE_MIN = 0.9;
const MIN_BILLS = 3;
const MIN_DATA_DAYS = 90;
const MIN_POWER_DAYS = 30;
const PEAK_SHARE = 0.2; // shortcut: fixed threshold for "a lot of P1", tune when real bills disagree
const taxFactor = (inv) => (1 + num(inv.elec_tax_pct) / 100) * (1 + num(inv.vat_pct) / 100);
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
const billDays = (inv) => inv.days ?? spanDays(inv.period_from, inv.period_to);
// What a bill charges whatever the use, taxes included: power, social bonus and meter rent (no donation, no other lines).
const fixedTaxed = (inv) => ((num(inv.power_eur) + num(inv.social_bonus_eur)) * (1 + num(inv.elec_tax_pct) / 100) + num(inv.meter_rent_eur)) * (1 + num(inv.vat_pct) / 100);

// A tariff.js price object rebuilt from one bill; null when a price the estimate needs is missing.
export function pricesFromInvoice(inv) {
  if (P.some((p) => inv[`price_${p}`] == null) || inv.vat_pct == null) return null;
  const days = billDays(inv);
  const kwh = sum(P.map((p) => num(inv[`kwh_${p}`])));
  return {
    p1: inv.price_p1, p2: inv.price_p2, p3: inv.price_p3,
    adjust: kwh > 0 ? num(inv.adjust_eur) / kwh : 0,
    export: num(inv.surplus_price),
    powerP1: num(inv.power_price_p1), powerP2: num(inv.power_price_p2),
    contractedP1: num(inv.contracted_p1_kw), contractedP2: num(inv.contracted_p2_kw),
    socialDay: num(inv.social_bonus_eur) / days, meterDay: num(inv.meter_rent_eur) / days,
    iee: num(inv.elec_tax_pct) / 100, vat: inv.vat_pct / 100,
  };
}

// One energy cap over the whole bill period (the supplier caps once per bill), then the fixed terms.
function estimate(rows, prices) {
  const m = prices && periodMoney(rows, prices);
  return m ? Math.max(m.bought - m.exportIncome, 0) + m.fixed : null;
}

const kwhVerdict = (billed, measured) => {
  if (billed == null) return 'nodata';
  if (!measured) return billed > 0 ? 'check' : 'ok';
  const d = Math.abs(billed - measured) / measured;
  return d <= 0.05 ? 'ok' : d <= 0.1 ? 'small' : 'check';
};

export function compareInvoice(store, inv, { prices = null } = {}) {
  const dated = isDate(inv.period_from) && isDate(inv.period_to) && inv.period_from <= inv.period_to;
  const days = dated ? billDays(inv) : null;
  const rows = dated ? store.days(inv.period_from, inv.period_to) : [];
  const daysWithData = rows.filter((r) => r.import_kwh != null).length;
  const coverage = days > 0 ? daysWithData / days : 0;
  const real = inv.total_eur ?? null;
  const billedP = P.map((p) => inv[`kwh_${p}`]);
  const billed = { p1: billedP[0], p2: billedP[1], p3: billedP[2], total: billedP.some((v) => v != null) ? sum(billedP.map(num)) : null };
  const surplusBilled = P.some((p) => inv[`surplus_${p}_kwh`] != null) ? sum(P.map((p) => num(inv[`surplus_${p}_kwh`]))) : null;
  // the bill's own zero cap: reported, or computed when the discount is larger than the energy term
  const lostEur = inv.surplus_lost_eur ?? (num(inv.surplus_eur) > num(inv.energy_eur) ? cents(num(inv.surplus_eur) - num(inv.energy_eur)) : 0);
  const out = {
    days, daysWithData, coverage, verdict: 'nodata', kwh: { billed, measured: null }, diffKwh: null,
    surplus: { billed: surplusBilled, measured: null, eur: inv.surplus_eur ?? null, lostEur },
    estimateEnv: null, estimateBill: null, real, diff: null, savings: null, loadKwh: null,
  };
  if (coverage < COVERAGE_MIN) return out;

  const measured = Object.fromEntries(P.map((p) => [p, sum(rows.map((r) => num(r[`import_${p}`])))]));
  measured.total = sum(rows.map((r) => num(r.import_kwh)));
  out.kwh.measured = measured;
  out.surplus.measured = sum(rows.map((r) => num(r.export_kwh)));
  out.loadKwh = sum(rows.map((r) => num(r.load_kwh)));
  out.verdict = kwhVerdict(billed.total, measured.total);
  out.diffKwh = billed.total != null ? cents(billed.total - measured.total) : null;

  const billPrices = pricesFromInvoice(inv);
  out.estimateEnv = cents(estimate(rows, prices));
  out.estimateBill = cents(estimate(rows, billPrices));
  const other = num(inv.other_exempt_eur) + num(inv.other_taxed_eur) * (1 + num(inv.vat_pct) / 100);
  out.diff = {
    prices: out.estimateEnv != null && out.estimateBill != null ? cents(out.estimateBill - out.estimateEnv) : null,
    kwh: real != null && out.estimateBill != null ? cents(real - out.estimateBill - other) : null,
    other: cents(other),
    // the bill against the app's forecast at the configured prices (what Previsió shows) = kwh + prices + other
    total: real != null && out.estimateEnv != null ? cents(real - out.estimateEnv) : null,
  };

  const m = billPrices && periodMoney(rows, billPrices);
  if (m && real != null) {
    const withoutSolar = cents(m.withoutSolar + fixedTaxed(inv));
    const surplusDiscount = cents(num(inv.surplus_eur) * taxFactor(inv));
    // the two parts add up to the saving (withoutSolar - real) exactly; the discount is the bill's line with its taxes
    out.savings = {
      withoutSolar, avoided: cents(withoutSolar - real - surplusDiscount), surplusDiscount, surplusDiscountPrinted: inv.surplus_eur ?? null,
    };
  }
  return out;
}

const invoiceView = (inv, compare) => {
  const fixed = num(inv.power_eur) + num(inv.meter_rent_eur) + num(inv.social_bonus_eur);
  return {
    id: inv.id, month: billMonth(inv.period_from, inv.period_to), period: { from: inv.period_from, to: inv.period_to },
    total: inv.total_eur,
    parts: {
      energy: cents(num(inv.energy_eur)), fixed: cents(fixed), taxes: cents(num(inv.elec_tax_eur) + num(inv.vat_eur)),
      other: cents(num(inv.other_taxed_eur) + num(inv.other_exempt_eur)), surplus: cents(num(inv.surplus_eur)), // surplus: a discount
    },
    kwh: Object.fromEntries(P.map((p) => [p, inv[`kwh_${p}`]])),
    prices: { p1: inv.price_p1, p2: inv.price_p2, p3: inv.price_p3, surplus: inv.surplus_price },
    compare,
  };
};

// Contracted power from the measured daily peaks alone (>= 30 measured days in the year); contracted kW and power prices
// from the latest confirmed bill, else the configured ones. A printed bill maximum above the contracted power means keep.
function powerCard(store, { prices, yearFrom, today, dataDays }) {
  const latest = store.listInvoices({ status: 'confirmed' }).filter((i) => !i.superseded_by).at(-1);
  const fromBill = latest && (latest.contracted_p1_kw != null || latest.contracted_p2_kw != null);
  // shortcut: the configured POWER_* values arrive only with the energy prices (pricesFromEnv); read them alone if a bill-less install without prices needs the card
  if (dataDays < MIN_POWER_DAYS || (!fromBill && !prices)) return null;
  const contracted = fromBill ? [num(latest.contracted_p1_kw), num(latest.contracted_p2_kw)] : [num(prices.contractedP1), num(prices.contractedP2)];
  const price = fromBill ? [num(latest.power_price_p1), num(latest.power_price_p2)] : [num(prices.powerP1), num(prices.powerP2)];
  const tf = fromBill ? taxFactor(latest) : (1 + prices.iee) * (1 + prices.vat);
  const maxes = aggregate.series(store, { from: yearFrom, to: today, bucket: '1d' }).series.imp_kw_max.filter((v) => v != null);
  const c = Math.max(...contracted);
  if (!maxes.length || !(c > 0)) return null;
  const maxKw = Math.max(...maxes);
  const daysOver = maxes.filter((v) => v > c).length;
  const billMax = [latest?.max_demand_p1_kw, latest?.max_demand_p2_kw].filter((v) => v != null);
  const billOver = billMax.some((v) => v > c); // the meter's 15-minute maximum saw more than the 5-minute samples
  const target = Math.ceil((maxKw / 0.8) * 10) / 10;
  const saves = !billOver && daysOver === 0 && maxKw < 0.8 * c;
  return {
    id: 'power', state: billOver || daysOver > 0 ? 'keep' : saves ? 'lower' : 'ok', period: { from: yearFrom, to: today },
    basis: 'measured_peaks', caveat: 'billing.advice.power.caveat',
    numbers: {
      contractedKw: c, maxKw: Math.round(maxKw * 1000) / 1000, daysOver, measuredDays: dataDays,
      billMaxP1Kw: latest?.max_demand_p1_kw ?? null, billMaxP2Kw: latest?.max_demand_p2_kw ?? null,
      suggestedKw: saves ? target : null,
      savingsYear: saves ? cents(sum(contracted.map((k, i) => Math.max(k - target, 0) * price[i])) * tf) : null,
    },
  };
}

function advice(store, { invoices, bills, prices, from, to, today, missing, review }) {
  const data = {
    id: 'data', state: missing.length || review.length || bills.some((b) => b.compare.verdict === 'check') ? 'attention' : 'ok',
    numbers: { missing, review: review.map((r) => r.id), check: bills.filter((b) => b.compare.verdict === 'check').map((b) => b.id) },
    period: { from, to },
  };
  const yearFrom = addDays(addMonths(today, -12), 1);
  const dataDays = store.days(yearFrom, today).filter((r) => r.import_kwh != null).length;
  const power = powerCard(store, { prices, yearFrom, today, dataDays });
  const cards = power ? [power] : [];
  if (bills.length < MIN_BILLS || dataDays < MIN_DATA_DAYS) return [...cards, data];
  const period = { from: yearFrom, to: today };
  const last = invoices[invoices.length - 1];
  const tf = taxFactor(last);

  // prices: configured prices against the last bill's; the .env lines come back as data
  const bp = pricesFromInvoice(last);
  if (bp) {
    const differ = prices && P.some((p) => Math.abs(prices[p] - bp[p]) / bp[p] > 0.02);
    cards.push({
      id: 'prices', state: !prices ? 'unset' : differ ? 'differ' : 'same', period: { from: last.period_from, to: last.period_to },
      numbers: {
        env: prices ? { p1: prices.p1, p2: prices.p2, p3: prices.p3 } : null, bill: { p1: bp.p1, p2: bp.p2, p3: bp.p3 },
        lines: [`PRICE_P1=${bp.p1}`, `PRICE_P2=${bp.p2}`, `PRICE_P3=${bp.p3}`, `PRICE_EXPORT=${bp.export}`,
          `PRICE_ADJUST=${Math.round(bp.adjust * 1e6) / 1e6}`, `PRICE_POWER_P1=${bp.powerP1}`, `PRICE_POWER_P2=${bp.powerP2}`,
          `POWER_P1_KW=${bp.contractedP1}`, `POWER_P2_KW=${bp.contractedP2}`, `TAX_ELECTRICITY_PCT=${num(last.elec_tax_pct)}`,
          `TAX_VAT_PCT=${last.vat_pct}`],
      },
    });
  }

  // peak: share of bought kWh in P1; moving a quarter of it to P3, over a year
  const kp = Object.fromEntries(P.map((p) => [p, sum(bills.map((b) => num(b.kwh[p])))]));
  const kTotal = sum(Object.values(kp));
  const spanBilled = sum(bills.map((b) => spanDays(b.period.from, b.period.to)));
  if (kTotal > 0 && last.price_p1 != null && last.price_p3 != null && spanBilled > 0) {
    const share = kp.p1 / kTotal;
    const moved = (kp.p1 / 4) * (365 / spanBilled);
    cards.push({
      id: 'peak', state: share >= PEAK_SHARE ? 'high' : 'low', period,
      numbers: { share: Math.round(share * 1000) / 1000, p1Kwh: cents(kp.p1), movedKwhYear: cents(moved), savingsYear: cents(moved * (last.price_p1 - last.price_p3) * tf) },
    });
  }

  // surplus: what a surplus kWh is paid against what a bought kWh costs
  const sKwh = sum(bills.map((b) => num(b.compare.surplus.billed)));
  const boughtPrice = kTotal > 0 ? sum(P.map((p) => kp[p] * num(last[`price_${p}`]))) / kTotal : null;
  if (sKwh > 0 && boughtPrice && last.surplus_price > 0) {
    const ratio = boughtPrice / last.surplus_price;
    cards.push({
      id: 'surplus', state: ratio >= 2 ? 'worth' : 'low', period,
      numbers: { surplusKwh: cents(sKwh), ratio: Math.round(ratio * 10) / 10, boughtPrice: Math.round(boughtPrice * 1000) / 1000, surplusPrice: last.surplus_price, lostEur: cents(sum(bills.map((b) => num(b.compare.surplus.lostEur)))) },
    });
  }

  // tariff: no supplier comparison, only the real all-in price per kWh
  if (kTotal > 0) cards.push({ id: 'tariff', state: 'info', period, numbers: { allInPerKwh: Math.round((sum(bills.map((b) => num(b.total))) / kTotal) * 1000) / 1000 } });
  return [...cards, data];
}

// Confirmed, non-superseded bills overlapping [from, to] with their comparison, tiles, breakdown and advice.
export function billingSummary(store, { from, to, prices = null, today = localDay(Date.now()) }) {
  const live = (inv) => !inv.superseded_by;
  const invoices = store.listInvoices({ status: 'confirmed', from, to }).filter(live);
  const bills = invoices.map((inv) => invoiceView(inv, compareInvoice(store, inv, { prices })));
  const total = sum(bills.map((b) => num(b.total)));
  const kwh = sum(bills.map((b) => sum(P.map((p) => num(b.kwh[p])))));
  const compared = bills.filter((b) => b.compare.verdict !== 'nodata');
  const load = sum(compared.map((b) => num(b.compare.loadKwh)));
  const part = (k) => sum(bills.map((b) => b.parts[k]));
  const segments = {
    energy: part('energy') - part('surplus'),
    fixed: sum(invoices.map((i) => num(i.power_eur) + num(i.social_bonus_eur))),
    taxes: part('taxes'),
    other: sum(invoices.map((i) => num(i.meter_rent_eur))) + part('other'),
  };
  const all = Object.values(segments).reduce((s, v) => s + v, 0);
  const fixedEur = sum(invoices.map(fixedTaxed));
  const breakdown = Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, { eur: cents(v), pct: all ? Math.round((v / all) * 1000) / 10 : 0 }]));
  const monthKeys = [from.slice(0, 7), to.slice(0, 7)];
  const inRange = (m) => m >= monthKeys[0] && m <= monthKeys[1];
  const measured = store.measuredDays();
  const missing = missingMonths(store.listInvoices({ status: 'confirmed' }).filter(live), today, measured).filter(inRange);
  const review = store.listInvoices({ status: 'draft', from, to }).filter(live)
    .map((i) => ({ id: i.id, month: i.period_from && i.period_to ? billMonth(i.period_from, i.period_to) : null }));
  return {
    invoices: bills,
    tiles: {
      total: cents(total), average: bills.length ? cents(total / bills.length) : null, pricePerKwh: kwh > 0 ? Math.round((total / kwh) * 1000) / 1000 : null,
      surplusDiscount: cents(part('surplus')), bills: bills.length, months: monthIndex(monthKeys[1]) - monthIndex(monthKeys[0]) + 1,
      // months a bill is expected for: measured months that are billed or already missing (not the current or grace ones)
      measuredMonths: measuredMonths(measured).filter(inRange).filter((m) => missing.includes(m) || invoices.some((i) => i.period_from.slice(0, 7) <= m && m <= i.period_to.slice(0, 7))).length,
    },
    crossTiles: {
      homeCostPerKwh: load > 0 ? Math.round((sum(compared.map((b) => num(b.total))) / load) * 1000) / 1000 : null,
      coveredPct: load > 0 ? Math.round((1 - sum(compared.map((b) => num(b.compare.kwh.measured.total))) / load) * 1000) / 10 : null,
    },
    breakdown, missing, review,
    // what zero use would still cost: power, social bonus and meter rent with their taxes, against the total paid
    fixedPart: { eur: cents(fixedEur), pct: total > 0 ? Math.round((fixedEur / total) * 1000) / 10 : null },
    advice: advice(store, { invoices, bills, prices, from, to, today, missing, review }),
  };
}

export { advice };
