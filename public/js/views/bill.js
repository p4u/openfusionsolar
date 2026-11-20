// Bill view: what the bill will be, what the panels saved, how much was bought in each tariff period.
import { register, t, locale } from '../i18n.js';
import dict from '../i18n/bill.js';
import { esc, icon, emptyState, loadBlock, ledger, badge, every, moneyTabs } from '../ui.js';
import { getEnergy, getSeries, getSignals, getBills, getBilling, putBill, ApiError } from '../api.js';
import { parseRange } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { figure, chart } from '../charts.js';
import { addDays } from '../buckets.js';
import { bucketAxis } from '../chart-data.js';
import { eur, kwh, kw, nf, fmtDate, fmtMonth, dayOf } from '../format.js';
import { monthRows, peakVsContracted, monthTotals, parseAmount, billDelta, realTotals, periodParts, confirmedMonths, realCellModel } from './bill-model.js';
import { phaseLink } from './signals-model.js';
import { deltaText, compareLabel, ofPeriod } from './energy-model.js';

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
function addChart(el, { id, title, caption, columns, rows, iso, csv }, spec) {
  const fig = figure(el, { title, csvName: csv ?? id });
  fig.setCaption(caption);
  fig.setTable(columns, rows, iso);
  const c = chart(fig.host, { id, ...spec });
  handles.get(el).push({ destroy: () => { c.destroy(); fig.destroy(); } });
}

const empty = (el, body = t('bill.empty')) => {
  reset(el);
  el.innerHTML = emptyState({ title: t('core.empty.title'), body });
};

// embedded: inside Facturació (its range bar and tabs are above, and it hands over its range), so an h2 and no tabs or range bar.
export async function render(root, ctx, { embedded = false, range: given = null } = {}) {
  const { status, signal } = ctx;
  const rctx = { today: status.today, firstDay: status.firstDay };
  const range = given ?? parseRange(ctx.params, rctx, 'year');
  const priced = Boolean(status.pricesConfigured);
  const monthLabel = (key) => fmtMonth(key);
  const monthAxis = (rows) => { const a = bucketAxis(rows.map((r) => r.key), '1mo'); return { categories: a.categories, title: a.title, label: (i) => monthLabel(rows[i].key) }; };
  const csvName = (id) => `${id}-${range.from}_${range.to}`;
  const cmp = range.cmp !== 'none' ? range.cmp : undefined;

  root.innerHTML = `<header class="view-head">${embedded ? `<h2 class="section-title">${esc(t('bill.title'))}</h2>` : `<h1 class="view-title">${esc(t('bill.title'))}</h1>`}</header>
    ${embedded ? '' : `${moneyTabs('bill', ctx.params)}<div class="bill-range"></div>`}
    <div class="bill-tiles"></div>
    <div class="grid">
      ${priced ? '<div class="card span-6 bill-monthly"></div>' : ''}
      <div class="card ${priced ? 'span-6' : 'span-12'} bill-period"></div>
    </div>
    <div class="card bill-table"></div>
    <details class="disclosure bill-more"><summary><span>${esc(t('bill.more'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      <div class="bill-more-body">
        <div class="card bill-peak"></div>
        <p class="bill-phases" hidden></p>
      </div></details>`;
  const q = (s) => root.querySelector(s);
  const bar = embedded ? null : renderRangeBar(q('.bill-range'), { range, ctx: rctx, onChange: (p) => ctx.setParams(p) });

  let energyP = null;
  const energy = () => (energyP ??= getEnergy({ from: range.from, to: range.to, bucket: '1mo', compare: cmp }, { signal }).catch((e) => {
    energyP = null;
    throw e;
  }));

  // Readings for the detail charts: at most 750 daily buckets, none before the first reading.
  const seriesFrom = () => [range.from, status.firstSampleDay ?? range.from, addDays(range.to, -749)].reduce((a, b) => (b > a ? b : a));
  const clampNote = (el, from) => {
    if (from > range.from) el.insertAdjacentHTML('beforeend', `<p class="hint">${esc(t('core.clamped', { date: fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' }) }))}</p>`);
  };

  async function tiles(el) {
    const { total, compare: c } = await energy();
    reset(el);
    if (!total.days) return empty(el);
    const m = total.money;
    // comparison with the chosen period, as on Energy: a delta per tile or the reason it is not comparable
    const label = c ? compareLabel(c, locale()) : '';
    const vs = (cur, prev) => (c ? deltaText(cur, { value: prev, comparable: c.comparable, reason: c.reason, label }) : null);
    const cm = c?.total?.money;
    let list;
    let extra = '';
    if (priced && m) {
      list = [
        { icon: 'euro', label: t('bill.tile.cost'), value: eur(m.energy), title: t('bill.tile.costHint'), delta: vs(m.energy, cm?.energy) },
        { icon: 'calendar', label: t('bill.tile.bill'), value: eur(m.bill), title: t('bill.tile.billHint'), delta: vs(m.bill, cm?.bill) },
        { icon: 'sun', label: t('bill.tile.savings'), value: eur(m.savings), title: t('bill.tile.savingsHint'), delta: vs(m.savings, cm?.savings), hint: m.savings < 0 ? t('bill.tile.savingsNegative') : null },
        { icon: 'utility-pole', label: t('bill.tile.income'), value: eur(m.exportIncome), title: t('bill.tile.incomeHint'), delta: vs(m.exportIncome, cm?.exportIncome) },
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
        { icon: 'sun', label: t('bill.tile.produced'), value: kwh(total.pv_kwh), delta: vs(total.pv_kwh, c?.total.pv_kwh) },
        { icon: 'house', label: t('bill.tile.consumed'), value: kwh(total.load_kwh), delta: vs(total.load_kwh, c?.total.load_kwh) },
        { icon: 'utility-pole', label: t('bill.tile.bought'), value: kwh(total.import_kwh), delta: vs(total.import_kwh, c?.total.import_kwh) },
        { icon: 'zap', label: t('bill.tile.sold'), value: kwh(total.export_kwh), delta: vs(total.export_kwh, c?.total.export_kwh) },
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
      rows: rows.map((r, i) => [monthLabel(r.key), energyCol[i], fixedCol[i], without[i]]),
      iso: rows.map((r) => r.key), csv: csvName('bill-monthly'),
    }, {
      kind: 'category', unit: '€', stacked: true, y: { min: 0, decimals: 0 },
      x: monthAxis(rows),
      coverage: rows.map((r) => r.coverage), provisional: rows.map((r) => r.provisional),
      series: [
        { key: 'energy', name: t('bill.monthly.energy'), type: 'bar', entity: 'grid', data: energyCol },
        { key: 'fixed', name: t('bill.monthly.fixed'), type: 'bar', entity: 'fixed', data: fixedCol },
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
      rows: rows.map((r) => [monthLabel(r.key), ...r.byPeriod]),
      iso: rows.map((r) => r.key), csv: csvName('bill-period'),
    }, {
      kind: 'category', unit: 'kWh', stacked: true, y: { min: 0, decimals: 0 },
      x: monthAxis(rows),
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
      rows: res.rows.map((r) => [fmtDate(r.day), r.peak]),
      iso: res.rows.map((r) => r.day), csv: csvName('bill-peak'),
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

  // the phase powers live in Technical data: a link, not a second copy of the chart
  async function phases(el) {
    const href = phaseLink(await getSignals({ signal }));
    if (!href) return;
    el.innerHTML = `<a class="link" href="${esc(href)}">${esc(t('bill.phases.link'))}</a>`;
    el.hidden = false;
  }

  async function table(el) {
    // the minute refresh never redraws under someone typing an amount
    if (el.contains(document.activeElement) && document.activeElement.matches('.bill-real')) return;
    // months covered by a confirmed bill show its total as a link; a failed lookup leaves every month as an input
    const [{ buckets }, bills, billing] = await Promise.all([energy(), getBills({ signal }).catch(() => ({})),
      getBilling({ from: range.from, to: range.to }, { signal }).catch(() => null)]);
    const linked = confirmedMonths(billing?.invoices);
    const all = () => ({ ...bills, ...Object.fromEntries(Object.entries(linked).map(([k, v]) => [k, v.total])) });
    const rows = monthRows(buckets);
    reset(el);
    if (!rows.length) return empty(el);
    const money = rows.some((r) => r.money);
    // cls: 'bill-opt' leaves the phone card, 'bill-wide' shows from 1200 px only (both stay in the chart tables)
    const cols = [
      { key: 'bought', label: t('bill.table.bought'), cell: (r) => kwh(r.bought) },
      { key: 'periods', label: t('bill.table.periods'), cls: 'bill-opt bill-nowrap', cell: (r) => periodParts(r.byPeriod, r.bought).map((v) => (v == null ? t('core.unknown') : nf(0).format(v))).join(' / ') },
      { key: 'sold', label: t('bill.table.sold'), cls: 'bill-opt', cell: (r) => kwh(r.sold) },
      ...(money ? [
        { key: 'energy', label: t('bill.table.energy'), cls: 'bill-opt bill-wide', cell: (r) => eur(r.money?.energy) },
        { key: 'fixed', label: t('bill.table.fixed'), cls: 'bill-opt bill-wide', cell: (r) => eur(r.money?.fixed) },
        { key: 'bill', label: t('bill.table.bill'), cell: (r) => eur(r.money?.bill) },
        { key: 'savings', label: t('bill.table.savings'), cls: 'bill-opt', cell: (r) => eur(r.money?.savings) },
      ] : []),
    ];
    const realLabel = t('bill.table.real');
    const diffLabel = t('bill.table.diff');
    const span = 1 + cols.length + 1 + (money ? 1 : 0);
    const td = (label, html, cls = '') => `<td class="num${cls ? ` ${cls}` : ''}" data-label="${esc(label)}">${html}</td>`;
    const cells = (r) => cols.map((c) => td(c.label, esc(c.cell(r)), c.cls)).join('');
    const signed = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${eur(v)}`);
    const realCell = (r) => {
      const cell = realCellModel(r.key, linked, bills);
      if (cell.kind === 'link') return td(realLabel, `<a class="link" href="#/invoices?id=${cell.id}">${esc(eur(cell.total))}</a>`);
      const v = cell.value;
      const id = `bill-real-${r.key}`;
      const month = ofPeriod(fmtMonth(r.key, { mid: true }));
      return td(realLabel, `<input id="${id}" class="input bill-real" type="text" inputmode="decimal" autocomplete="off" data-month="${esc(r.key)}"
        value="${v == null ? '' : esc(nf(2).format(v))}" aria-label="${esc(t('bill.table.realFor', { month }))}" aria-describedby="${id}-msg">`);
    };
    const diffCell = (r) => (money ? td(diffLabel, esc(signed(billDelta(all()[r.key], r.money?.bill))), 'bill-diff') : '');
    // the message of a month spans its whole row, under it, so it never squeezes into the narrow input cell
    const msgRow = (r) => `<tr class="bill-msg-row" hidden><td colspan="${span}"><span id="bill-real-${esc(r.key)}-msg" class="bill-real-msg"></span></td></tr>`;
    const body = rows.map((r) => {
      const flags = [r.provisional ? badge(t('core.badge.provisional'), 'provisional') : '', r.daysExpected > r.days ? badge(t('bill.table.partial'), 'warn') : ''].join(' ').trim();
      return `<tr data-month="${esc(r.key)}"><th scope="row"><span>${esc(fmtMonth(r.key))}</span>${flags ? `<span class="bill-flags">${flags}</span>` : ''}</th>${cells(r)}${realCell(r)}${diffCell(r)}</tr>${msgRow(r)}`;
    });
    // real-bill totals over the months that have one: "3 of 11 months"
    const footReal = () => {
      const rt = realTotals(rows, all());
      const count = rt.n && rt.n < rt.m ? `<span class="hint bill-real-count">${esc(t('bill.table.realCount', { n: rt.n, m: rt.m }))}</span>` : '';
      return `${td(realLabel, `${rt.real == null ? '' : esc(eur(rt.real))}${count}`, 'bill-foot-real')}${money ? td(diffLabel, esc(signed(rt.delta)), 'bill-foot-diff') : ''}`;
    };
    const tot = monthTotals(rows);
    el.innerHTML = `<h2 class="card-title">${esc(t('bill.table.title'))}</h2><p class="hint">${esc(t('bill.table.realHint'))}</p><div class="table-scroll"><table class="table bill-months"><caption class="sr-only">${esc(t('bill.table.title'))}</caption>
      <thead><tr><th scope="col">${esc(t('bill.table.month'))}</th>${cols.map((c) => `<th scope="col" class="num${c.cls ? ` ${c.cls}` : ''}">${esc(c.label)}</th>`).join('')}<th scope="col" class="num">${esc(realLabel)}</th>${money ? `<th scope="col" class="num">${esc(diffLabel)}</th>` : ''}</tr></thead>
      <tbody>${body.join('')}</tbody>
      <tfoot><tr><th scope="row">${esc(t('bill.table.total'))}</th>${cells(tot)}${footReal()}</tr></tfoot></table></div>
      <p class="sr-only bill-live" role="status"></p>`;
    const live = el.querySelector('.bill-live');
    const say = (input, text, error = false) => {
      const msg = el.querySelector(`#${input.id}-msg`);
      msg.textContent = text;
      msg.classList.toggle('bill-real-error', error);
      msg.closest('tr').hidden = !text;
      live.textContent = text;
    };
    const kept = (month) => (bills[month] == null ? '' : ` ${t('bill.table.realKept', { amount: eur(bills[month]) })}`);
    const setDiff = (input, v) => {
      const diff = input.closest('tr').querySelector('.bill-diff');
      if (diff) diff.textContent = signed(v);
    };
    // saved when the field is left; checked here first so a wrong amount never reaches the server
    el.onchange = async (e) => {
      const input = e.target.closest('.bill-real');
      if (!input) return;
      const month = input.dataset.month;
      const r = rows.find((x) => x.key === month);
      const parsed = parseAmount(input.value);
      if (parsed.error) {
        input.setAttribute('aria-invalid', 'true');
        say(input, `${t(`bill.table.realError.${parsed.error}`)}${kept(month)}`, true); // the row keeps the saved value and its difference, like the totals
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      say(input, t('bill.table.realSaving'));
      try {
        const saved = await putBill(month, parsed.value, { signal });
        Object.keys(bills).forEach((k) => delete bills[k]);
        Object.assign(bills, saved);
        input.value = bills[month] == null ? '' : nf(2).format(bills[month]);
        say(input, t('bill.table.realSaved'));
        setDiff(input, billDelta(bills[month], r?.money?.bill));
        const foot = el.querySelector('tfoot tr');
        foot.querySelectorAll('.bill-foot-real, .bill-foot-diff').forEach((c) => c.remove());
        foot.insertAdjacentHTML('beforeend', footReal());
      } catch (err) {
        if (err?.name === 'AbortError') return;
        input.setAttribute('aria-invalid', 'true');
        say(input, `${t(err instanceof ApiError && err.status === 400 ? 'bill.table.realError.format' : 'bill.table.realError.save')}${kept(month)}`, true);
      }
    };
  }

  const blocks = [];
  const run = (el, height, fn) => {
    blocks.push({ el, fn });
    return loadBlock(el, height, fn);
  };
  run(q('.bill-tiles'), 120, tiles);
  if (priced) run(q('.bill-monthly'), 360, monthly);
  run(q('.bill-period'), 360, period);
  run(q('.bill-table'), 200, table);
  // the detail blocks load when first opened: no readings are fetched for a section nobody looks at
  const more = q('.bill-more');
  more.addEventListener('toggle', () => {
    if (!more.open || more.dataset.loaded) return;
    more.dataset.loaded = '1';
    run(q('.bill-peak'), 360, peak);
    phases(q('.bill-phases')).catch(() => {}); // only a link: nothing to show when it fails
  });

  if (range.to === status.today) {
    every(60000, () => {
      energyP = null;
      for (const b of blocks) if (b.el.isConnected) b.fn(b.el).catch(() => {}); // a failed refresh keeps what is on screen
    }, signal);
  }

  return () => {
    bar?.destroy();
    for (const b of blocks) handles.get(b.el)?.forEach((h) => h.destroy());
  };
}
