// Chart presets shared by the billing summary and the assistant: a type plus a period in, a figure with its table out.
// Every spec has one y axis and one unit. presetModel/billModel are pure (data in, spec out) so Node can test them;
// renderPreset fetches through api.js and draws. The list is final: task 9 compares it with the server's.
import { register, t } from './i18n.js';
import billing from './i18n/billing.js';
import bill from './i18n/bill.js';
import battery from './i18n/battery.js';
import { esc, icon, emptyState, loadBlock } from './ui.js';
import { getEnergy, getSeries, getBilling, getBillingInvoice } from './api.js';
import { figure, chart } from './charts.js';
import { bucketAxis } from './chart-data.js';
import { legalSeriesBuckets, legalEnergyBuckets, autoSeriesBucket, autoEnergyBucket, spanDays } from './buckets.js';
import { eur, kwh, fmtDate, fmtDateTime, fmtMonth, isoLocal } from './format.js';
import { energyBars } from './views/energy-model.js';
import { notComparedList } from './views/billing-model.js';

register(billing);
register(bill);
register(battery);

export const PRESET_TYPES = ['energy_bars', 'power_lines', 'battery_soc', 'import_by_period', 'bill_breakdown',
  'bill_real_vs_estimate', 'bill_kwh_vs_measured', 'price_per_kwh', 'savings'];

const POWER = ['power_lines', 'battery_soc'];
const ENERGY = ['energy_bars', 'import_by_period'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const sum = (list) => list.reduce((a, v) => a + (v ?? 0), 0);
const round2 = (v) => Math.round(v * 100) / 100;
const P = ['p1', 'p2', 'p3'];
const pairs = (ts, arr) => ts.map((ms, i) => [ms, arr[i] ?? null]);

// null when the request can be drawn, else the key of the message that says why not (the same rule the server applies)
export function presetCheck(type, { from, to, bucket, invoiceId } = {}) {
  if (!PRESET_TYPES.includes(type)) return 'billing.preset.unknown';
  if (invoiceId != null && type === 'bill_kwh_vs_measured') return Number.isInteger(invoiceId) ? null : 'billing.preset.unknown';
  if (!DAY_RE.test(from ?? '') || !DAY_RE.test(to ?? '') || from > to) return 'billing.preset.unknown';
  const n = spanDays(from, to);
  if (POWER.includes(type)) {
    if (n > 7) return 'billing.preset.range';
    if (bucket && !legalSeriesBuckets(n).includes(bucket)) return 'billing.preset.bucket';
  }
  if (ENERGY.includes(type) && bucket && !legalEnergyBuckets(n).includes(bucket)) return 'billing.preset.bucket';
  return null;
}

// ---- spec builders: each returns { id, title, caption, columns, rows, iso, spec } or null when there is nothing to draw

function energyModel(data, id) {
  const bs = data?.buckets ?? [];
  if (!bs.length) return null;
  const axis = bucketAxis(bs.map((b) => b.key), data.bucket);
  const label = (i) => (data.bucket === '1mo' ? fmtMonth(bs[i].key) : data.bucket === '1y' ? bs[i].key : fmtDate(bs[i].from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
  const x = { categories: axis.categories, title: axis.title, label };
  const base = { kind: 'category', unit: 'kWh', stacked: true, y: { min: 0, decimals: 0 }, x, coverage: bs.map((b) => b.coverage), provisional: bs.map((b) => b.provisional) };
  if (id === 'import_by_period') {
    const names = P.map((p) => t(`bill.period.${p}`));
    const cols = P.map((p) => bs.map((b) => b[`import_${p}`] ?? null));
    if (!cols.some((c) => c.some(num))) return null;
    return {
      id, title: t('bill.period.title'), caption: t('bill.period.caption', { total: kwh(sum(data.total ? P.map((p) => data.total[`import_${p}`]) : [])) }),
      columns: [t('bill.table.month'), ...names.map((label) => ({ label, unit: 'kWh', decimals: 1 }))],
      rows: bs.map((_, i) => [label(i), ...cols.map((c) => c[i])]), iso: bs.map((b) => b.key),
      spec: { id, ...base, y: { min: 0, decimals: 0 }, series: names.map((name, i) => ({ key: P[i], name, type: 'bar', entity: P[i], data: cols[i] })) },
    };
  }
  const bars = energyBars(bs);
  const series = [
    { key: 'homeSolar', name: t('energy.series.homeSolar'), type: 'bar', entity: 'sun', data: bars.home_solar },
    { key: 'bought', name: t('energy.series.bought'), type: 'bar', entity: 'grid', data: bars.bought },
    { key: 'sold', name: t('energy.series.sold'), type: 'bar', entity: 'sold', below: true, data: bars.sold },
    { key: 'produced', name: t('energy.series.produced'), type: 'line', entity: 'sun', markers: true, data: bars.produced },
  ];
  return {
    id, title: t('energy.chart.energy'), caption: '',
    columns: [t('bill.table.month'), ...series.map((s) => ({ label: s.name, unit: 'kWh', decimals: 1 }))],
    rows: bs.map((_, i) => [label(i), ...series.map((s) => (s.key === 'sold' && s.data[i] != null ? -s.data[i] : s.data[i]))]), iso: bs.map((b) => b.key),
    spec: { id, ...base, y: { decimals: 1 }, series },
  };
}

function powerModel(data, id) {
  if (!data?.t?.length || data.coverage.every((c) => !c)) return null;
  const k = data.series;
  const step = data.t.length > 1 ? data.t[1] - data.t[0] : 300e3;
  const x = { min: data.t[0], max: data.t.at(-1) + step, label: (i) => fmtDateTime(data.t[i]) };
  const iso = data.t.map((ms) => isoLocal(ms, data.bucket));
  const base = { kind: 'time', x, coverage: data.coverage, provisional: data.provisional };
  if (id === 'battery_soc') {
    const series = [{ key: 'soc', name: t('core.entity.soc'), type: 'area', entity: 'battery', data: pairs(data.t, k.soc) }];
    return {
      id, title: t('battery.soc.title'), caption: '', iso,
      columns: [t('energy.col.time'), { label: t('core.entity.soc'), unit: '%', decimals: 0 }], rows: data.t.map((_, i) => [x.label(i), k.soc[i] ?? null]),
      spec: { id, ...base, unit: '%', y: { min: 0, max: 100, decimals: 0 }, series },
    };
  }
  const line = (key, name, type, entity, arr, extra = {}) => ({ key, name, type, entity, data: pairs(data.t, arr), ...extra });
  const series = [
    line('pv', t('core.entity.sun'), 'area', 'sun', k.pv_kw),
    line('home', t('core.entity.home'), 'line', 'home', k.load_kw, { width: 2.5 }),
    line('bought', t('energy.series.bought'), 'line', 'grid', k.imp_kw),
    line('sold', t('energy.series.sold'), 'line', 'sold', k.exp_kw, { dashed: true }),
  ];
  return {
    id, title: t('energy.chart.power'), caption: '', iso,
    columns: [t('energy.col.time'), ...series.map((s) => ({ label: s.name, unit: 'kW', decimals: 2 }))],
    rows: data.t.map((_, i) => [x.label(i), ...series.map((s) => s.data[i][1])]),
    spec: { id, ...base, unit: 'kW', stacked: false, y: { decimals: 2 }, series },
  };
}

// Bill charts: one bar per bill, labelled by the month holding most of its days. bills: /api/billing invoices.
function billModel(bills, id) {
  if (!bills.length) return null;
  const sorted = [...bills].sort((a, b) => (a.period.from < b.period.from ? -1 : 1));
  const axis = bucketAxis(sorted.map((b) => b.month), '1mo');
  const label = (i) => fmtMonth(sorted[i].month);
  const x = { categories: axis.categories, title: axis.title, label };
  const col = (f) => sorted.map(f);
  const rows = (...fs) => sorted.map((b, i) => [label(i), ...fs.map((f) => f(b))]);
  const c = (b) => b.compare;
  const cols = (...defs) => [t('billing.col.bill'), ...defs.map(([key, unit, decimals = 2]) => ({ label: t(key), unit, decimals }))];
  const bar = (key, name, entity, data, extra = {}) => ({ key, name, type: 'bar', entity, data, ...extra });
  const base = { id, kind: 'category', x, unit: '€', y: { min: 0, decimals: 0 } };
  const notCompared = notComparedList(sorted.map((b) => ({ ...b, label: fmtMonth(b.month) })));
  const model = (title, caption, columns, rowsOut, spec) => ({ id, title, caption, columns, rows: rowsOut, iso: sorted.map((b) => b.month), spec: { ...base, ...spec } });

  if (id === 'bill_breakdown') {
    const taxes = col((b) => round2(b.parts.taxes + b.parts.other));
    return model(t('billing.chart.breakdown'), t('billing.chart.breakdownCaption', { total: eur(sum(sorted.map((b) => b.total))), n: sorted.length }),
      cols(['billing.col.energy', '€'], ['billing.col.fixed', '€'], ['billing.col.taxes', '€'], ['billing.col.surplus', '€'], ['billing.col.total', '€']),
      rows((b) => b.parts.energy, (b) => b.parts.fixed, (b) => round2(b.parts.taxes + b.parts.other), (b) => b.parts.surplus, (b) => b.total),
      { stacked: true, y: { decimals: 0 }, series: [
        bar('energy', t('billing.s.energy'), 'grid', col((b) => b.parts.energy)),
        bar('fixed', t('billing.s.fixed'), 'fixed', col((b) => b.parts.fixed)),
        bar('taxes', t('billing.s.taxes'), 'muted', taxes),
        bar('surplus', t('billing.s.surplus'), 'sold', col((b) => (b.parts.surplus ? -b.parts.surplus : 0)), { below: true }),
      ] });
  }
  if (id === 'bill_by_period') {
    const data = P.map((p) => col((b) => b.kwh[p] ?? null));
    if (!data.some((d) => d.some(num))) return null;
    return model(t('billing.chart.period'), t('billing.chart.periodCaption', { total: kwh(sum(data.flat())) }),
      cols(...P.map((p) => [`bill.period.${p}`, 'kWh', 1])), rows(...P.map((p) => (b) => b.kwh[p] ?? null)),
      { unit: 'kWh', stacked: true, series: P.map((p, i) => bar(p, t(`bill.period.${p}`), p, data[i])) });
  }
  if (id === 'price_per_kwh') {
    const line = (key, name, entity, data, extra = {}) => ({ key, name, type: 'line', entity, markers: true, data, ...extra });
    const surplus = col((b) => b.prices.surplus ?? null);
    return model(t('billing.chart.price'), t('billing.chart.priceCaption'),
      cols(...P.map((p) => [`bill.period.${p}`, '€/kWh', 3]), ['billing.s.surplusPrice', '€/kWh', 3]),
      rows(...P.map((p) => (b) => b.prices[p] ?? null), (b) => b.prices.surplus ?? null),
      { unit: '€/kWh', stacked: false, y: { decimals: 3 }, series: [
        ...P.map((p) => line(p, t(`bill.period.${p}`), p, col((b) => b.prices[p] ?? null))),
        line('surplus', t('billing.s.surplusPrice'), 'sold', surplus, { dashed: true }),
      ] });
  }
  if (id === 'bill_real_vs_estimate') {
    const est = col((b) => c(b).estimateEnv);
    const diff = (b) => (num(c(b).estimateEnv) && num(b.total) ? round2(b.total - c(b).estimateEnv) : null);
    const diffPct = (b) => (num(diff(b)) && c(b).estimateEnv > 0 ? Math.round((diff(b) / c(b).estimateEnv) * 1000) / 10 : null);
    return model(t('billing.chart.real'), est.some(num) ? t('billing.chart.realCaption') : t('billing.chart.realNoPrices'),
      cols(['billing.col.real', '€'], ['billing.col.forecast', '€'], ['billing.col.diff', '€'], ['billing.col.diffPct', '%', 1]),
      rows((b) => b.total, (b) => c(b).estimateEnv, diff, diffPct),
      { stacked: false, series: [
        bar('real', t('billing.s.real'), 'grid', col((b) => b.total)),
        { key: 'forecast', name: t('billing.s.forecast'), type: 'line', entity: 'home', dashed: true, markers: true, data: est },
      ] });
  }
  if (id === 'bill_kwh_vs_measured') {
    const m = (b, p) => c(b).kwh.measured?.[p] ?? null;
    return model(t('billing.chart.kwh'), [t('billing.chart.kwhCaption'), notCompared].filter(Boolean).join(' '),
      [t('billing.col.bill'), ...[t('billing.s.billed'), t('billing.s.measured'), ...P.flatMap((p) => [`${t(`bill.period.${p}`)}: ${t('billing.s.billed')}`, `${t(`bill.period.${p}`)}: ${t('billing.s.measured')}`]),
        `${t('billing.s.exported')}: ${t('billing.s.billed')}`, `${t('billing.s.exported')}: ${t('billing.s.measured')}`].map((label) => ({ label, unit: 'kWh', decimals: 1 }))],
      rows((b) => c(b).kwh.billed.total, (b) => m(b, 'total'), ...P.flatMap((p) => [(b) => c(b).kwh.billed[p], (b) => m(b, p)]), (b) => c(b).surplus.billed, (b) => c(b).surplus.measured),
      { unit: 'kWh', stacked: false, series: [
        bar('billed', t('billing.s.billed'), 'grid', col((b) => c(b).kwh.billed.total)),
        bar('measured', t('billing.s.measured'), 'ac', col((b) => m(b, 'total'))),
      ] });
  }
  if (id === 'savings') {
    const without = col((b) => c(b).savings?.withoutSolar ?? null);
    const s = (b) => c(b).savings;
    return model(t('billing.chart.savings'), [t('billing.chart.savingsCaption'), notCompared].filter(Boolean).join(' '),
      cols(['billing.col.without', '€'], ['billing.col.paid', '€'], ['billing.col.avoided', '€'], ['billing.col.surplus', '€'], ['billing.col.other', '€']),
      rows((b) => s(b)?.withoutSolar ?? null, (b) => b.total, (b) => s(b)?.avoided ?? null, (b) => s(b)?.surplusDiscount ?? null, (b) => s(b)?.other ?? null),
      { stacked: false, series: [
        bar('without', t('billing.s.without'), 'home', without),
        bar('paid', t('billing.s.paid'), 'grid', col((b) => b.total)),
      ] });
  }
  if (id === 'bill_surplus') {
    const lost = sum(sorted.map((b) => c(b).surplus.lostEur));
    return model(t('billing.chart.surplus'), [t('billing.chart.surplusCaption'), lost > 0 ? t('billing.chart.surplusLost', { eur: eur(lost) }) : '', notCompared].filter(Boolean).join(' '),
      cols(['billing.col.exported', 'kWh', 1], ['billing.col.compensated', 'kWh', 1], ['billing.col.compensatedEur', '€'], ['billing.col.lostEur', '€']),
      rows((b) => c(b).surplus.measured, (b) => c(b).surplus.billed, (b) => c(b).surplus.eur, (b) => c(b).surplus.lostEur),
      { unit: 'kWh', stacked: false, series: [
        bar('exported', t('billing.s.exported'), 'sun', col((b) => c(b).surplus.measured)),
        bar('compensated', t('billing.s.compensated'), 'sold', col((b) => c(b).surplus.billed)),
      ] });
  }
  return null;
}

// One bill: billed against measured per period (the chat shows it next to an extracted bill).
function invoiceKwhModel(compare) {
  const id = 'bill_kwh_vs_measured';
  const billed = P.map((p) => compare.kwh.billed[p] ?? null);
  const measured = P.map((p) => compare.kwh.measured?.[p] ?? null);
  const names = P.map((p) => t(`bill.period.${p}`));
  const missing = Math.max(compare.days - compare.daysWithData, 0);
  return {
    id, title: t('billing.chart.kwhOne'), iso: P,
    caption: compare.kwh.measured ? t('billing.chart.kwhCaption') : t('billing.verdict.nodataDays', { days: t(missing === 1 ? 'billing.days.one' : 'billing.days.other', { n: missing }) }),
    columns: [t('billing.col.bill'), { label: t('billing.col.billed'), unit: 'kWh', decimals: 1 }, { label: t('billing.col.measured'), unit: 'kWh', decimals: 1 }],
    rows: names.map((n, i) => [n, billed[i], measured[i]]),
    spec: {
      id, kind: 'category', unit: 'kWh', stacked: false, y: { min: 0, decimals: 0 }, x: { categories: names, title: '', label: (i) => names[i] },
      series: [
        { key: 'billed', name: t('billing.s.billed'), type: 'bar', entity: 'grid', data: billed },
        { key: 'measured', name: t('billing.s.measured'), type: 'bar', entity: 'ac', data: measured },
      ],
    },
  };
}

const BILL_TYPES = ['bill_breakdown', 'bill_by_period', 'price_per_kwh', 'bill_real_vs_estimate', 'bill_kwh_vs_measured', 'savings', 'bill_surplus'];

// Model of one chart from already fetched data: `data` is the /api/energy answer, the /api/series answer, the
// /api/billing summary or, for one bill, the /api/billing/invoice answer. Null when there is nothing to draw.
export function presetModel(type, data, { invoice = false } = {}) {
  if (ENERGY.includes(type)) return energyModel(data, type);
  if (POWER.includes(type)) return powerModel(data, type);
  if (type === 'bill_kwh_vs_measured' && invoice) return data?.kwh ? invoiceKwhModel(data) : null;
  return BILL_TYPES.includes(type) ? billModel(data?.invoices ?? [], type) : null;
}

// Draws a model as a figure with caption, table and CSV, and its chart; returns { destroy }.
export function drawModel(parent, model) {
  const fig = figure(parent, { title: model.title, csvName: model.id });
  fig.setCaption(model.caption);
  fig.setTable(model.columns, model.rows, model.iso);
  const c = chart(fig.host, model.spec);
  return { destroy: () => { c.destroy(); fig.destroy(); } };
}

const failure = (key) => `<div class="error" role="alert">${icon('circle-alert', { size: 24 })}<div class="error-text"><p class="error-title">${esc(t(key))}</p></div></div>`;

export function renderPreset(parent, { type, from, to, bucket, invoiceId } = {}, { signal } = {}) {
  const host = document.createElement('div');
  host.className = 'billing-preset';
  parent.append(host);
  let handle = null;
  const bad = presetCheck(type, { from, to, bucket, invoiceId });
  if (bad) host.innerHTML = failure(bad);
  else {
    const n = from && to ? spanDays(from, to) : 0;
    const one = invoiceId != null && type === 'bill_kwh_vs_measured';
    loadBlock(host, 340, async (el) => {
      let data;
      if (ENERGY.includes(type)) data = await getEnergy({ from, to, bucket: bucket ?? autoEnergyBucket(n) }, { signal });
      else if (POWER.includes(type)) data = await getSeries({ from, to, bucket: bucket ?? autoSeriesBucket(n) }, { signal });
      else if (one) data = (await getBillingInvoice(invoiceId, { signal }));
      else data = await getBilling({ from, to }, { signal });
      const model = presetModel(type, data, { invoice: one });
      el.replaceChildren();
      if (!model) el.innerHTML = emptyState({ title: t('core.empty.title'), body: t('billing.preset.nodata') });
      else handle = drawModel(el, model);
    });
  }
  return { destroy: () => { handle?.destroy(); host.remove(); } };
}
