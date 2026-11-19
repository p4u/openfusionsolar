// Bill view: what the bill will be, what the panels saved, how much was bought in each tariff period.
import { register, t } from '../i18n.js';
import dict from '../i18n/bill.js';
import { esc, icon, emptyState, loadBlock, ledger, badge, every } from '../ui.js';
import { getEnergy, getSeries, getSignals, getSignalHistory } from '../api.js';
import { parseRange } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { figure, chart } from '../charts.js';
import { addDays, spanDays, autoSeriesBucket } from '../buckets.js';
import { eur, kwh, kw, nf, fmtDate, fmtDateTime, fmtMonth, dayOf } from '../format.js';
import { monthRows, peakVsContracted, phaseSignals } from './bill-model.js';

register(dict);

const DAY = 86400e3;
const handles = new WeakMap(); // block element -> chart handles to destroy on redraw
const sum = (list) => (list.some((v) => v != null) ? list.reduce((a, v) => a + (v ?? 0), 0) : null);

function reset(el) {
  handles.get(el)?.forEach((h) => h.destroy());
  handles.set(el, []);
  el.replaceChildren();
}

// A figure with caption, table and CSV, plus the chart; destroyed with the block.
function addChart(el, { id, title, caption, columns, rows }, spec) {
  const fig = figure(el, { title, csvName: id });
  fig.setCaption(caption);
  fig.setTable(columns, rows);
  const c = chart(fig.host, { id, ...spec });
  handles.get(el).push({ destroy: () => { c.destroy(); fig.destroy(); } });
}

const empty = (el, body = t('bill.empty')) => {
  reset(el);
  el.innerHTML = emptyState({ title: t('core.empty.title'), body });
};

export async function render(root, ctx) {
  const { status, signal } = ctx;
  const rctx = { today: status.today, firstDay: status.firstDay };
  const range = parseRange(ctx.params, rctx, 'year');
  const priced = Boolean(status.pricesConfigured);
  const monthLabel = (key) => fmtDate(`${key}-01`, { month: 'short', year: '2-digit' });

  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('bill.title'))}</h1></header>
    <div class="bill-range"></div>
    <div class="bill-tiles"></div>
    <div class="grid">
      ${priced ? '<div class="card span-6 bill-monthly"></div>' : ''}
      <div class="card ${priced ? 'span-6' : 'span-12'} bill-period"></div>
    </div>
    <details class="disclosure bill-more"><summary><span>${esc(t('bill.more'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      <div class="bill-more-body">
        <div class="card bill-peak"></div>
        <div class="card bill-phases"></div>
        <div class="card bill-table"></div>
      </div></details>`;
  const q = (s) => root.querySelector(s);
  const bar = renderRangeBar(q('.bill-range'), { range, ctx: rctx, compare: false, onChange: (p) => ctx.setParams(p) });

  let energyP = null;
  const energy = () => (energyP ??= getEnergy({ from: range.from, to: range.to, bucket: '1mo' }, { signal }).catch((e) => {
    energyP = null;
    throw e;
  }));

  // Readings for the detail charts: at most 750 daily buckets, none before the first reading.
  const seriesFrom = () => [range.from, status.firstSampleDay ?? range.from, addDays(range.to, -749)].reduce((a, b) => (b > a ? b : a));
  const clampNote = (el, from) => {
    if (from > range.from) el.insertAdjacentHTML('beforeend', `<p class="hint">${esc(t('core.clamped', { date: fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' }) }))}</p>`);
  };

  async function tiles(el) {
    const { total } = await energy();
    reset(el);
    if (!total.days) return empty(el);
    const m = total.money;
    let list;
    let extra = '';
    if (priced && m) {
      list = [
        { icon: 'euro', label: t('bill.tile.cost'), value: eur(m.energy), title: t('bill.tile.costHint') },
        { icon: 'calendar', label: t('bill.tile.bill'), value: eur(m.bill), title: t('bill.tile.billHint') },
        { icon: 'sun', label: t('bill.tile.savings'), value: eur(m.savings), title: t('bill.tile.savingsHint'), hint: m.savings < 0 ? t('bill.tile.savingsNegative') : null },
        { icon: 'utility-pole', label: t('bill.tile.income'), value: eur(m.exportIncome), title: t('bill.tile.incomeHint') },
      ];
      const p = status.prices;
      const how = t('bill.how', {
        p1: nf(3).format(p.p1), p2: nf(3).format(p.p2), p3: nf(3).format(p.p3), adj: nf(3).format(p.adjust ?? 0),
        iee: nf(2).format((p.iee ?? 0) * 100), vat: nf(0).format((p.vat ?? 0) * 100), exp: nf(2).format(p.export ?? 0),
      });
      extra = `<details class="disclosure bill-explain"><summary><span>${esc(t('bill.explain'))}</span>${icon('chevron-down', { size: 16 })}</summary>
        <ul class="bill-explain-list">${['cost', 'bill', 'savings', 'income'].map((k) => `<li><strong>${esc(t(`bill.tile.${k}`))}.</strong> ${esc(t(`bill.tile.${k}Hint`))}</li>`).join('')}</ul></details>
        <p class="hint">${esc(how)}</p>`;
    } else {
      list = [
        { icon: 'sun', label: t('bill.tile.produced'), value: kwh(total.pv_kwh) },
        { icon: 'house', label: t('bill.tile.consumed'), value: kwh(total.load_kwh) },
        { icon: 'utility-pole', label: t('bill.tile.bought'), value: kwh(total.import_kwh) },
        { icon: 'zap', label: t('bill.tile.sold'), value: kwh(total.export_kwh) },
      ];
      extra = `<p class="hint bill-noprices">${esc(t('bill.noPrices'))}</p>`;
    }
    const missing = total.daysExpected - total.days;
    const warn = missing > 0 ? `<p class="hint bill-incomplete">${esc(t('bill.incomplete', { n: missing, days: total.daysExpected }))}</p>` : '';
    // the badge says what it qualifies: these totals, with the reason beside it
    const prov = total.provisional ? `<p class="hint bill-note">${badge(t('core.badge.provisional'), 'provisional')}<span>${esc(t('bill.provisional'))}</span></p>` : '';
    el.innerHTML = `${ledger(list)}${prov}${warn}${extra}`;
  }

  async function monthly(el) {
    const { buckets, total } = await energy();
    const rows = monthRows(buckets);
    reset(el);
    if (!rows.some((r) => r.money)) return empty(el);
    const col = (f) => rows.map((r) => (r.money ? f(r.money) : null));
    const energyCol = col((m) => m.energy);
    const fixedCol = col((m) => m.fixed);
    const without = col((m) => m.withoutSolar);
    addChart(el, {
      id: 'bill-monthly',
      title: t('bill.monthly.title'),
      caption: t('bill.monthly.caption', { total: eur(total.money?.bill), n: rows.length }),
      columns: [t('bill.table.month'), { label: t('bill.monthly.energy'), unit: '€' }, { label: t('bill.monthly.fixed'), unit: '€' }, { label: t('bill.monthly.without'), unit: '€' }],
      rows: rows.map((r, i) => [r.key, energyCol[i], fixedCol[i], without[i]]),
    }, {
      kind: 'category', unit: '€', stacked: true, y: { min: 0, decimals: 0 },
      x: { categories: rows.map((r) => monthLabel(r.key)) },
      coverage: rows.map((r) => r.coverage), provisional: rows.map((r) => r.provisional),
      series: [
        { key: 'energy', name: t('bill.monthly.energy'), type: 'bar', entity: 'grid', data: energyCol },
        { key: 'fixed', name: t('bill.monthly.fixed'), type: 'bar', entity: 'p3', data: fixedCol },
        { key: 'without', name: t('bill.monthly.without'), type: 'line', entity: 'home', dashed: true, data: without },
      ],
    });
  }

  async function period(el) {
    const { buckets, total } = await energy();
    const rows = monthRows(buckets);
    reset(el);
    if (!rows.some((r) => r.byPeriod.some((v) => v != null))) return empty(el);
    const names = ['p1', 'p2', 'p3'].map((p) => t(`bill.period.${p}`));
    addChart(el, {
      id: 'bill-period',
      title: t('bill.period.title'),
      caption: t('bill.period.caption', { total: kwh(sum(['import_p1', 'import_p2', 'import_p3'].map((k) => total[k]))) }),
      columns: [t('bill.table.month'), ...names.map((n) => ({ label: n, unit: 'kWh' }))],
      rows: rows.map((r) => [r.key, ...r.byPeriod]),
    }, {
      kind: 'category', unit: 'kWh', stacked: true, y: { min: 0, decimals: 0 },
      x: { categories: rows.map((r) => monthLabel(r.key)) },
      coverage: rows.map((r) => r.coverage), provisional: rows.map((r) => r.provisional),
      series: names.map((name, i) => ({ key: `p${i + 1}`, name, type: 'bar', entity: `p${i + 1}`, data: rows.map((r) => r.byPeriod[i]) })),
    });
  }

  async function peak(el) {
    const to = range.to;
    const from = seriesFrom();
    if (from > to) return empty(el);
    const s = await getSeries({ from, to, bucket: '1d' }, { signal });
    reset(el);
    const contracted = status.prices?.contractedP1;
    const res = peakVsContracted(s.t.map((ms, i) => ({ day: dayOf(ms), peak: s.series.imp_kw_max[i] })), contracted);
    if (!res.rows.some((r) => r.peak != null)) return empty(el);
    const point = (pred) => s.t.map((ms, i) => [ms, pred(res.rows[i]) ? res.rows[i].peak : null]);
    addChart(el, {
      id: 'bill-peak',
      title: t('bill.peak.title'),
      caption: res.contracted == null ? t('bill.peak.caption.none')
        : t(res.overCount ? 'bill.peak.caption.over' : 'bill.peak.caption.ok', { kw: kw(res.contracted), n: res.overCount }),
      columns: [t('bill.table.day'), { label: t('bill.peak.title'), unit: 'kW', decimals: 2 }],
      rows: res.rows.map((r) => [r.day, r.peak]),
    }, {
      kind: 'time', unit: 'kW', stacked: true,
      y: { min: 0, max: Math.max(res.max, res.contracted ?? 0) * 1.1 || undefined, decimals: 1 },
      x: { min: s.t[0], max: s.t.at(-1) + DAY, label: (i) => fmtDate(s.t[i]) },
      coverage: s.coverage, provisional: s.provisional,
      refLines: res.contracted == null ? [] : [{ y: res.contracted, label: t('bill.peak.ref', { kw: kw(res.contracted) }), entity: 'alarm' }],
      series: [
        { key: 'within', name: t('bill.peak.within'), type: 'bar', entity: 'grid', data: point((r) => !r.over) },
        { key: 'over', name: t('bill.peak.over'), type: 'bar', entity: 'alarm', data: point((r) => r.over) },
      ],
    });
    clampNote(el, from);
  }

  async function phases(el) {
    const found = phaseSignals(await getSignals({ signal }));
    if (!found) return el.remove();
    const to = range.to;
    const from = seriesFrom();
    if (from > to) return el.remove();
    const h = await getSignalHistory({ dn: found.dn, ids: found.signals.map((s) => s.id), from, to, bucket: autoSeriesBucket(spanDays(from, to)) }, { signal });
    reset(el);
    const lines = found.signals.map((s) => ({ s, avg: h.signals.find((x) => x.id === s.id)?.avg ?? [] }));
    const entities = ['p1', 'home', 'battery'];
    const val = (l, i) => (l.avg[i] == null ? null : l.avg[i] * l.s.scale);
    addChart(el, {
      id: 'bill-phases',
      title: t('bill.phases.title'),
      caption: t('bill.phases.caption'),
      columns: [t('bill.table.time'), ...lines.map((l) => ({ label: l.s.phase, unit: 'kW', decimals: 2 }))],
      rows: h.t.map((ms, i) => [fmtDateTime(ms), ...lines.map((l) => val(l, i))]),
    }, {
      kind: 'time', unit: 'kW', y: { decimals: 2 },
      x: { min: h.t[0], max: h.t.at(-1), label: (i) => (h.bucket === '1d' ? fmtDate(h.t[i]) : fmtDateTime(h.t[i])) },
      series: lines.map((l, k) => ({ key: l.s.phase, name: l.s.phase, type: 'line', entity: entities[k % 3], data: h.t.map((ms, i) => [ms, val(l, i)]) })),
    });
    clampNote(el, from);
  }

  async function table(el) {
    const { buckets } = await energy();
    const rows = monthRows(buckets);
    reset(el);
    if (!rows.length) return empty(el);
    const money = rows.some((r) => r.money);
    const head = [t('bill.table.month'), t('bill.table.bought'), t('bill.table.sold'), ...(money ? ['energy', 'fixed', 'bill', 'savings'].map((k) => t(`bill.table.${k}`)) : [])];
    const num = (s) => `<td class="num">${esc(s)}</td>`;
    const body = rows.map((r) => {
      const flags = [r.provisional ? badge(t('core.badge.provisional'), 'provisional') : '', r.daysExpected > r.days ? badge(t('bill.table.partial'), 'warn') : ''].join(' ');
      return `<tr><th scope="row">${esc(fmtMonth(r.key))} ${flags}</th>${num(kwh(r.bought))}${num(kwh(r.sold))}${money ? [r.money?.energy, r.money?.fixed, r.money?.bill, r.money?.savings].map((v) => num(eur(v))).join('') : ''}</tr>`;
    });
    el.innerHTML = `<h2 class="card-title">${esc(t('bill.table.title'))}</h2><div class="table-scroll"><table class="table">
      <thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`;
  }

  const blocks = [];
  const run = (el, height, fn) => {
    blocks.push({ el, fn });
    return loadBlock(el, height, fn);
  };
  run(q('.bill-tiles'), 120, tiles);
  if (priced) run(q('.bill-monthly'), 360, monthly);
  run(q('.bill-period'), 360, period);
  // the detail blocks load when first opened: no readings are fetched for a section nobody looks at
  const more = q('.bill-more');
  more.addEventListener('toggle', () => {
    if (!more.open || more.dataset.loaded) return;
    more.dataset.loaded = '1';
    run(q('.bill-peak'), 360, peak);
    run(q('.bill-phases'), 360, phases);
    run(q('.bill-table'), 200, table);
  });

  if (range.to === status.today) {
    every(60000, () => {
      energyP = null;
      for (const b of blocks) if (b.el.isConnected) b.fn(b.el).catch(() => {}); // a failed refresh keeps what is on screen
    }, signal);
  }

  return () => {
    bar.destroy();
    for (const b of blocks) handles.get(b.el)?.forEach((h) => h.destroy());
  };
}
