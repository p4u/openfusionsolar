// Billing summary: what the bills say, crossed with what the installation measured, and advice with its working shown.
import { register, t, getLang } from '../i18n.js';
import dict from '../i18n/billing.js';
import { esc, icon, emptyState, loadBlock, ledger, badge, statusLine, moneyTabs } from '../ui.js';
import { getBilling } from '../api.js';
import { parseRange } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { addDays, addMonths } from '../buckets.js';
import { eur, kwh, nf, pct, fmtDate, fmtMonth, fmtMonthShort } from '../format.js';
import { presetModel, drawModel } from '../chart-presets.js';
import { shareLabels } from './energy-model.js';
import { statusSentence, breakdownSegments, adviceView, reconRows, savingsSplit, fixedShare, adviceNote } from './billing-model.js';
import { render as renderForecast } from './bill.js';

register(dict);

const SEG_KEYS = ['energy', 'fixed', 'taxes', 'other'];
const STATE = { ok: 'ok', small: 'info', check: 'warn', nodata: 'waiting' };
const VERDICT_BADGE = { ok: 'ok', small: 'warn', check: 'alarm', nodata: '' };
const ask = (question, invoice) => `#/assistant?q=${encodeURIComponent(question)}${invoice ? `&invoice=${invoice}` : ''}`;
const askLink = (href) => `<a class="link billing-ask" href="${esc(href)}">${icon('message-circle', { size: 16 })}<span>${esc(t('billing.advice.ask'))}</span></a>`;

export async function render(root, ctx) {
  const { status, signal } = ctx;
  const rctx = { today: status.today, firstDay: status.firstDay };
  // no range in the address: the last 12 months, not the calendar year
  const range = ctx.params.has('r') ? parseRange(ctx.params, rctx, 'year')
    : parseRange({ r: 'custom', from: addDays(addMonths(status.today, -12), 1), to: status.today }, rctx);
  const aiOn = Boolean(status.ai?.enabled);
  let drawn = [];
  let forecast = null;

  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('billing.title'))}</h1></header>
    ${moneyTabs('billing', ctx.params)}
    <div class="billing-range"></div>
    <div class="billing-body"></div>`;
  const bar = renderRangeBar(root.querySelector('.billing-range'), { range, ctx: rctx, compare: false, onChange: (p) => ctx.setParams(p) });

  const clear = () => {
    drawn.forEach((h) => h.destroy());
    drawn = [];
    forecast?.();
    forecast = null;
  };

  function segmented(summary) {
    const segs = breakdownSegments(summary);
    if (!segs.length) return '';
    const shown = shareLabels(segs.map((s) => ({ ...s, v: s.pct, label: `billing.seg.${s.key}` })));
    const labels = shown.map((p) => esc(t(p.label, { pct: p.v })));
    const aside = shown.map((p, i) => (p.inline ? '' : `<span><i class="billing-seg-key billing-seg-${p.entity}"></i>${labels[i]}</span>`)).join('');
    const fixed = summary.fixedPart?.pct ?? fixedShare(summary.invoices); // server: taxed fixed part over the taxed total
    return `<section class="card billing-seg-card"><h2 class="card-title">${esc(t('billing.seg.title'))}</h2>
      <div class="billing-seg" role="img" aria-label="${labels.join(', ')}">${shown.map((p) => `<span class="billing-seg-${p.entity}" style="flex-grow:${p.v}"></span>`).join('')}</div>
      <div class="billing-seg-labels" aria-hidden="true">${shown.map((p, i) => `<span style="flex-grow:${p.v}">${p.inline ? labels[i] : ''}</span>`).join('')}</div>
      ${aside ? `<p class="billing-seg-aside" aria-hidden="true">${aside}</p>` : ''}
      ${fixed == null ? '' : `<p class="hint">${esc(t('billing.seg.zero', { pct: nf(0).format(fixed) }))}</p>`}
      <details class="disclosure"><summary><span>${esc(t('billing.seg.explain'))}</span>${icon('chevron-down', { size: 16 })}</summary>
        <ul class="billing-explain">${SEG_KEYS.map((k) => `<li>${esc(t(`billing.seg.${k}Text`))}</li>`).join('')}</ul></details></section>`;
  }

  function recon(summary) {
    const rows = reconRows(summary.invoices);
    const reason = (r) => (r.reasonKey == null ? '' : t(r.reasonKey, { eur: eur(Math.abs(r.reasonEur ?? 0)) }));
    const signed = (v) => `${v > 0 ? '+' : ''}${eur(v)}`;
    const gap = (r) => (!r.gap || Math.abs(r.gap.total) < 0.01 ? '' : t(`billing.recon.gap${r.gap.total > 0 ? 'More' : 'Less'}${r.gap.kwh == null ? 'Total' : ''}`, {
      eur: eur(Math.abs(r.gap.total)), kwh: signed(r.gap.kwh ?? 0), prices: signed(r.gap.prices ?? 0), other: signed(r.gap.other ?? 0) }));
    const td = (label, html, cls = '') => `<td${cls ? ` class="${cls}"` : ''} data-label="${esc(label)}">${html}</td>`;
    const body = rows.map((r) => `<tr>
      <th scope="row"><span>${esc(fmtMonth(r.month))}</span><span class="hint">${esc(`${fmtDate(r.period.from)} - ${fmtDate(r.period.to)}`)}</span></th>
      ${td(t('billing.recon.verdict'), badge(r.verdict === 'nodata' ? t('billing.verdict.nodataDays', { days: t(r.missingDays === 1 ? 'billing.days.one' : 'billing.days.other', { n: r.missingDays }) }) : t(`billing.verdict.${r.verdict}`), VERDICT_BADGE[r.verdict]))}
      ${td(t('billing.recon.billedKwh'), esc(kwh(r.billed)), 'num')}
      ${td(t('billing.recon.measuredKwh'), esc(kwh(r.measured)), 'num')}
      ${td(t('billing.recon.why'), esc([gap(r), reason(r)].filter(Boolean).join(' ')))}
      ${aiOn ? td('', askLink(ask(t('billing.ask.bill', { month: fmtMonth(r.month, { mid: true }) }), r.id))) : ''}</tr>`).join('');
    return `<section class="card billing-recon-card"><h2 class="card-title">${esc(t('billing.recon.title'))}</h2>
      <div class="table-scroll"><table class="table billing-recon"><caption class="sr-only">${esc(t('billing.recon.title'))}</caption>
      <thead><tr><th scope="col">${esc(t('billing.col.bill'))}</th><th scope="col">${esc(t('billing.recon.verdict'))}</th><th scope="col" class="num">${esc(t('billing.recon.billedKwh'))}</th><th scope="col" class="num">${esc(t('billing.recon.measuredKwh'))}</th><th scope="col">${esc(t('billing.recon.why'))}</th>${aiOn ? '<th scope="col"><span class="sr-only">' + esc(t('billing.advice.ask')) + '</span></th>' : ''}</tr></thead>
      <tbody>${body}</tbody></table></div>
      <p class="hint">${esc(t('billing.recon.caveat'))}</p></section>`;
  }

  function advice(summary) {
    const cards = summary.advice.map(adviceView);
    const note = adviceNote(summary.advice);
    const card = (a) => `<article class="card billing-advice billing-advice-${esc(a.state)}">
      <h3 class="card-title">${esc(a.title)}</h3>
      <p class="billing-advice-text">${esc(a.text)}</p>
      ${a.lines ? `<p class="hint">${esc(t('billing.advice.prices.copy'))}</p><pre class="billing-lines" tabindex="0">${esc(a.lines.join('\n'))}</pre>` : ''}
      <details class="disclosure"><summary><span>${esc(t('billing.advice.how'))}</span>${icon('chevron-down', { size: 16 })}</summary>
        <p>${esc(a.how)}</p><p class="hint">${esc(t('billing.advice.period', { from: fmtDate(a.period.from, { day: 'numeric', month: 'short', year: 'numeric' }), to: fmtDate(a.period.to, { day: 'numeric', month: 'short', year: 'numeric' }) }))}</p></details>
      <p class="hint"><strong>${esc(t('billing.advice.caveat'))}.</strong> ${esc(a.caveat)}</p>
      ${aiOn ? askLink(ask(t('billing.ask.q', { title: a.title }))) : ''}</article>`;
    return `<section class="billing-advice-block"><h2 class="section-title">${esc(t('billing.advice.title'))}</h2>
      ${note ? `<p class="hint">${esc(t(note))}</p>` : ''}
      <div class="billing-advice-grid">${cards.map(card).join('')}</div></section>`;
  }

  function tiles(summary) {
    const { tiles: tl, crossTiles: x } = summary;
    const top = ledger([
      { icon: 'euro', label: t('billing.tile.total'), value: eur(tl.total), title: t('billing.tile.totalHint') },
      ...(tl.bills > 1 ? [{ icon: 'calendar', label: t('billing.tile.average'), value: eur(tl.average) }] : []), // one bill: the average is the total
      { icon: 'utility-pole', label: t('billing.tile.price'), value: tl.pricePerKwh == null ? null : `${nf(3).format(tl.pricePerKwh)} €/kWh`, title: t('billing.tile.priceHint'), hint: t('billing.tile.priceNote') },
      { icon: 'zap', label: t('billing.tile.surplus'), value: eur(tl.surplusDiscount), title: t('billing.tile.surplusHint') },
      { icon: 'calendar', label: t('billing.tile.bills'), value: t('billing.tile.billsValue', { n: tl.bills, m: tl.months }) },
    ]);
    const cross = ledger([
      { icon: 'house', label: t('billing.tile.homeCost'), value: x.homeCostPerKwh == null ? null : `${nf(3).format(x.homeCostPerKwh)} €/kWh`, title: t('billing.tile.homeCostHint') },
      { icon: 'sun', label: t('billing.tile.covered'), value: pct(x.coveredPct), title: t('billing.tile.coveredHint') },
    ]);
    return `${top}${cross}`;
  }

  function draw(el, summary) {
    clear();
    if (!summary.invoices.length) {
      el.innerHTML = `${emptyState({ title: t('billing.empty.title'), body: t('billing.empty.body'), action: { label: t('billing.empty.action'), href: '#/invoices' } })}
        <section class="billing-forecast"></section>`;
      return renderForecast(el.querySelector('.billing-forecast'), ctx, { embedded: true, range }).then((cleanup) => { forecast = cleanup ?? null; });
    }
    const last = [...summary.invoices].sort((a, b) => (a.period.to < b.period.to ? -1 : 1)).at(-1);
    const details = [
      summary.missing.length ? t('billing.missing', { list: summary.missing.map(fmtMonthShort).join(', ') }) : '',
      summary.review.length ? t(summary.review.length === 1 ? 'billing.reviewOne' : 'billing.review', { n: summary.review.length }) : '',
    ].filter(Boolean);
    const split = savingsSplit(summary.invoices);
    el.innerHTML = `${statusLine({ state: STATE[last.compare.verdict] ?? 'info', title: statusSentence(summary, getLang()), details })}
      ${tiles(summary)}
      ${segmented(summary)}
      <div class="billing-figs"></div>
      ${recon(summary)}
      ${advice(summary)}`;
    // charts of the bills alone, then the bills crossed with what the installation measured
    const figs = el.querySelector('.billing-figs');
    for (const id of ['bill_breakdown', 'bill_by_period', 'price_per_kwh', 'bill_real_vs_estimate', 'bill_kwh_vs_measured', 'savings', 'bill_surplus']) {
      const model = presetModel(id, summary);
      if (model) {
        const card = Object.assign(document.createElement('section'), { className: 'card billing-fig' });
        figs.append(card);
        const h = drawModel(card, model);
        drawn.push({ destroy: () => { h.destroy(); card.remove(); } });
        if (id === 'savings' && split.bills) {
          card.insertAdjacentHTML('beforeend', `<details class="disclosure billing-split"><summary><span>${esc(t('billing.savings.explain'))}</span>${icon('chevron-down', { size: 16 })}</summary>
          <p>${esc(t(split.printed == null ? 'billing.savings.text' : 'billing.savings.textPrinted', { saved: eur(split.saved), avoided: eur(split.avoided), surplus: eur(split.surplus), printed: eur(split.printed) }))}</p></details>`);
        }
      }
    }
    return null;
  }

  const body = root.querySelector('.billing-body');
  await loadBlock(body, 420, async (el) => draw(el, await getBilling({ from: range.from, to: range.to }, { signal })));

  return () => {
    bar.destroy();
    clear();
  };
}
