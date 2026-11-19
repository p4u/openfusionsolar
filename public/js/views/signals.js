// Technical data view: pick a device and up to 6 signals, see one chart per unit (mean line, min/max band), a table and CSV.
import { register, t } from '../i18n.js';
import dict from '../i18n/signals.js';
import { esc, loadBlock, emptyState } from '../ui.js';
import { getSignals, getSignalHistory } from '../api.js';
import { fmtDate, fmtDateTime } from '../format.js';
import { parseRange } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { figure, chart } from '../charts.js';
import { gapBands } from '../chart-data.js';
import { BUCKET_MS, clampFrom, seriesBucket } from './battery-model.js';
import { MAX_SIGNALS, groupByUnit, parseIds, toggleId } from './signals-model.js';

register(dict);

const ENTITIES = ['sun', 'home', 'grid', 'battery', 'p2', 'p3'];

export async function render(root, ctx) {
  const { status, signal } = ctx;
  const rctx = { today: ctx.today, firstDay: status.firstDay };
  const range = parseRange(ctx.params, rctx, 'today');
  const kept = [];
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('signals.title'))}</h1></header>
    <p class="hint">${esc(t('signals.lead', { max: MAX_SIGNALS }))}</p>
    <div class="signals-range"></div>
    <div class="card" data-block="pick"></div>
    <div data-block="charts"></div>`;
  const q = (name) => root.querySelector(`[data-block="${name}"]`);
  const bar = renderRangeBar(root.querySelector('.signals-range'), { range, ctx: rctx, mode: 'power', compare: false, onChange: (p) => ctx.setParams(p) });

  const devices = (await getSignals({ signal })).filter((d) => d.signals.length);
  if (!devices.length) {
    q('pick').innerHTML = emptyState({ title: t('signals.noDevices'), body: t('signals.noDevicesBody') });
    return () => bar.destroy();
  }
  const dev = devices.find((d) => d.dn === ctx.params.get('dn')) ?? devices[0];
  let ids = parseIds(ctx.params.get('ids'), dev.signals.map((s) => s.id));

  const pick = q('pick');
  const checklist = (filter = '') => dev.signals.filter((s) => `${s.name} ${s.unit ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
    .map((s) => `<label class="signals-item"><input type="checkbox" value="${s.id}"${ids.includes(s.id) ? ' checked' : ''}${!ids.includes(s.id) && ids.length >= MAX_SIGNALS ? ' disabled' : ''}>
      <span>${esc(s.name)}${s.unit ? ` <span class="hint">(${esc(s.unit)})</span>` : ''}</span></label>`).join('') || `<p class="hint">${esc(t('signals.noMatch'))}</p>`;
  pick.innerHTML = `<div class="field signals-device"><label for="signals-dev">${esc(t('signals.device'))}</label>
      <select id="signals-dev">${devices.map((d) => `<option value="${esc(d.dn)}"${d === dev ? ' selected' : ''}>${esc(d.name ?? d.type)}</option>`).join('')}</select></div>
    <div class="field"><label for="signals-filter">${esc(t('signals.filter'))}</label><input id="signals-filter" type="search" autocomplete="off"></div>
    <fieldset class="signals-list"><legend class="field-label">${esc(t('signals.pick', { max: MAX_SIGNALS }))}</legend>
      <p class="hint" data-counter role="status"></p><div class="signals-items">${checklist()}</div></fieldset>`;
  const counter = () => { pick.querySelector('[data-counter]').textContent = t('signals.counter', { n: ids.length, max: MAX_SIGNALS }); };
  counter();
  const sync = () => ctx.setParams({ dn: dev.dn, ids: ids.length ? ids.join(',') : null });
  pick.addEventListener('change', (e) => {
    if (e.target.id === 'signals-dev') ctx.setParams({ dn: e.target.value, ids: null });
    else if (e.target.type === 'checkbox') {
      ids = toggleId(ids, Number(e.target.value));
      sync();
    }
  });
  pick.addEventListener('input', (e) => {
    if (e.target.id === 'signals-filter') pick.querySelector('.signals-items').innerHTML = checklist(e.target.value);
  });

  const cl = clampFrom(range.from, range.to, status.firstSampleDay);
  const bucket = seriesBucket(range);
  const chartsEl = q('charts');
  if (!ids.length) chartsEl.innerHTML = emptyState({ title: t('signals.choose'), body: t('signals.chooseBody') });
  else {
    chartsEl.className = 'card signals-charts';
    loadBlock(chartsEl, 340, async (el) => {
      if (cl.empty) return void (el.innerHTML = emptyState({ title: t('core.empty.title'), body: t('signals.noReadings') }));
      const h = await getSignalHistory({ dn: dev.dn, ids, from: cl.from, to: range.to, bucket }, { signal });
      const known = h.signals.filter((s) => s.avg.some((v) => v != null));
      if (!known.length) return void (el.innerHTML = emptyState({ title: t('core.empty.title'), body: t('signals.noReadings') }));
      el.replaceChildren();
      const stamp = (i) => (h.bucket === '1d' ? fmtDate(h.t[i]) : fmtDateTime(h.t[i]));
      const x = { min: h.t[0], max: h.t.at(-1) + BUCKET_MS[h.bucket], label: (i) => (h.bucket === '1d' ? fmtDate(h.t[i], { weekday: 'short', day: 'numeric', month: 'short' }) : fmtDateTime(h.t[i])) };
      const bands = gapBands({ t: h.t, coverage: h.t.map((_, i) => (known.some((s) => s.avg[i] != null) ? 1 : 0)), bucketMs: BUCKET_MS[h.bucket], now: Date.now() });
      for (const { unit, signals } of groupByUnit(known)) {
        const f = figure(el, { title: unit || t('signals.noUnit'), csvName: `signals-${unit || 'no-unit'}` });
        f.setCaption(t('signals.caption'));
        f.setTable([t('signals.col.time'), ...signals.flatMap((s) => [
          { label: t('signals.col.avg', { name: s.name }), unit, decimals: 3 }, { label: t('signals.col.min', { name: s.name }), unit, decimals: 3 }, { label: t('signals.col.max', { name: s.name }), unit, decimals: 3 }])],
        h.t.map((_, i) => [stamp(i), ...signals.flatMap((s) => [s.avg[i], s.min[i], s.max[i]])]));
        const series = signals.flatMap((s) => {
          const entity = ENTITIES[ids.indexOf(s.id) % ENTITIES.length];
          return [
            { key: `b${s.id}`, name: t('signals.band', { name: s.name }), type: 'rangeArea', entity, data: h.t.map((ms, i) => [ms, s.min[i] == null ? null : [s.min[i], s.max[i]]]) },
            { key: `m${s.id}`, name: s.name, type: 'line', entity, data: h.t.map((ms, i) => [ms, s.avg[i]]) },
          ];
        });
        kept.push(f, chart(f.host, { id: `signals-${unit || 'none'}`, kind: 'time', unit, group: 'signals', x, y: { decimals: 2 }, series, bands }));
      }
    });
  }

  return () => {
    bar.destroy();
    for (const k of kept) k.destroy();
  };
}
