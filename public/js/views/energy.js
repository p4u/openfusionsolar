// Energy view: range bar, totals with comparison, power or energy chart, battery strip, shares, table and CSV.
import { register, t, locale } from '../i18n.js';
import dict from '../i18n/energy.js';
import { esc, icon, ledger, emptyState, badge, loadBlock, every } from '../ui.js';
import { getSeries, getEnergy, getEvents } from '../api.js';
import { kw, kwh, fmtDate, fmtDateTime, fmtMonth, dayOf, dayStart } from '../format.js';
import { parseRange, rangeParams, customFromZoom } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { figure, chart } from '../charts.js';
import { gapBands, eventBands } from '../chart-data.js';
import {
  addDays, legalSeriesBuckets, legalEnergyBuckets, autoSeriesBucket, autoEnergyBucket, defaultMode,
} from '../buckets.js';
import { shares, deltaText, energyBars, powerAllowed, compareLabel } from './energy-model.js';

register(dict);

const HOUR = 3600e3;
const METRICS = {
  produced: { key: 'pv_kwh', entity: 'sun', sign: 1, name: 'energy.metric.produced' },
  consumed: { key: 'load_kwh', entity: 'home', sign: 1, name: 'energy.metric.consumed' },
  bought: { key: 'import_kwh', entity: 'grid', sign: 1, name: 'energy.metric.bought' },
  sold: { key: 'export_kwh', entity: 'grid', sign: -1, name: 'energy.metric.sold' },
};
const maxOf = (arr) => arr.reduce((a, b) => (b != null && (a == null || b > a) ? b : a), null);
const pairs = (times, arr) => times.map((ms, i) => [ms, arr[i] ?? null]);

export async function render(root, ctx) {
  const { status, params, signal } = ctx;
  const rctx = { today: status.today, firstDay: status.firstDay };
  const range = parseRange(params, rctx);
  const { from, to, days } = range;
  const power = powerAllowed(days);
  const asked = params.get('mode');
  const mode = (asked === 'power' && power) || (asked === 'energy') ? asked : power ? defaultMode(days) : 'energy';
  const seriesBucket = legalSeriesBuckets(days).includes(range.b) ? range.b : autoSeriesBucket(days);
  const energyBucket = legalEnergyBuckets(days).includes(range.b) ? range.b : autoEnergyBucket(days);
  const hourly = mode === 'energy' && days <= 2 && !legalEnergyBuckets(days).includes(range.b);
  const metric = METRICS[params.get('metric')] ? params.get('metric') : 'produced';
  const cmpOn = range.cmp !== 'none';

  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('energy.title'))}</h1>
      <div class="segmented" role="radiogroup" aria-label="${esc(t('energy.mode.label'))}">
        ${['power', 'energy'].map((m) => `<label><input type="radio" name="energy-mode" value="${m}"${m === mode ? ' checked' : ''}${m === 'power' && !power ? ' disabled' : ''}>${esc(t(`energy.mode.${m}`))}</label>`).join('')}
      </div></header>
    ${power ? '' : `<p class="hint">${esc(t('energy.mode.powerOff'))}</p>`}
    <div class="energy-bar"></div>
    <div class="energy-body" aria-live="polite"></div>`;
  const q = (s) => root.querySelector(s);
  const live = [];
  const destroyCharts = () => live.splice(0).forEach((c) => c.destroy());

  const bar = renderRangeBar(q('.energy-bar'), {
    range, ctx, mode, onChange: (p) => ctx.setParams({ ...p, zoomFrom: null }),
  });
  root.addEventListener('change', (e) => {
    if (e.target.name === 'energy-mode') ctx.setParams({ mode: e.target.value, zoomFrom: null });
  });

  const fromMs = dayStart(from);
  const toMs = dayStart(addDays(to, 1));
  // getSeries and getEvents have hard limits (750 buckets, 800 days): clamp before asking
  const seriesFrom = [from, status.firstSampleDay, addDays(to, -749)].filter(Boolean).reduce((a, b) => (b > a ? b : a));
  const clamped = seriesFrom > from;

  async function fetchData() {
    const o = { signal };
    const needSeries = mode === 'power' || hourly;
    const [energy, series, events] = await Promise.all([
      getEnergy({ from, to, bucket: energyBucket, compare: cmpOn ? range.cmp : null }, o),
      needSeries && seriesFrom <= to ? getSeries({ from: seriesFrom, to, bucket: mode === 'power' ? seriesBucket : '1h' }, o) : null,
      needSeries ? getEvents({ from: [from, addDays(to, -799)].reduce((a, b) => (b > a ? b : a)), to }, o).catch(() => []) : [],
    ]);
    return { energy, series, events };
  }

  const zoomValue = () => params.get('zoomFrom')
    ?? new URLSearchParams(Object.entries(rangeParams(range)).filter(([, v]) => v != null)).toString();
  const onZoom = (a, b) => ctx.setParams({ ...customFromZoom(a, b, dayOf), d: null, zoomFrom: zoomValue() });
  const resetZoom = () => {
    const prev = Object.fromEntries(new URLSearchParams(params.get('zoomFrom')));
    ctx.setParams({ r: null, d: null, from: null, to: null, cmp: null, b: null, ...prev, zoomFrom: null });
  };

  function tiles(energy) {
    const tot = energy.total;
    const c = energy.compare;
    const label = c ? compareLabel(c, locale()) : '';
    const cell = (m, name, ic) => {
      const k = METRICS[m].key;
      const delta = c ? deltaText(tot[k], { value: c.total[k], comparable: c.comparable, reason: c.reason, label }) : null;
      return { icon: ic, label: t(name), value: kwh(tot[k]), delta };
    };
    const missing = (tot.daysExpected ?? 0) - (tot.days ?? 0);
    return `<section aria-label="${esc(t('energy.tiles.label'))}">${ledger([
      cell('produced', 'energy.tiles.produced', 'sun'), cell('consumed', 'energy.tiles.consumed', 'house'),
      cell('bought', 'energy.tiles.bought', 'utility-pole'), cell('sold', 'energy.tiles.sold', 'zap'),
    ])}${missing > 0 || tot.provisional ? `<p class="hint energy-note">${tot.provisional ? badge(t('core.badge.provisional'), 'provisional') : ''} ${missing > 0 ? esc(t('energy.incomplete', { n: missing })) : ''}</p>` : ''}</section>`;
  }

  function segmented(title, parts) {
    const known = parts.filter((p) => p.v != null);
    const shown = known.filter((p) => p.v > 0);
    const labels = shown.map((p) => esc(t(p.label, { pct: p.v })));
    return `<section class="card energy-seg-card"><h2 class="card-title">${esc(title)}</h2>${!known.length
      ? `<p class="hint">${esc(t('energy.shares.unknown'))}</p>`
      : `<div class="energy-seg" role="img" aria-label="${labels.join(', ')}">${shown.map((p) => `<span class="energy-seg-${p.entity}" style="flex-grow:${p.v}"></span>`).join('')}</div>
        <div class="energy-seg-labels" aria-hidden="true">${shown.map((p, i) => `<span style="flex-grow:${p.v}">${labels[i]}</span>`).join('')}</div>`}</section>`;
  }

  // buckets for the energy chart: calendar buckets from /api/energy, or hours from /api/series
  function energyModel({ energy, series }) {
    if (hourly) {
      const k = series?.kwh;
      if (!k) return null;
      const step = series.t.length > 1 ? series.t[1] - series.t[0] : HOUR;
      return {
        start: series.t, end: series.t.map((s) => s + step), coverage: series.coverage, provisional: series.provisional,
        label: (i) => fmtDateTime(series.t[i]),
        buckets: series.t.map((_, i) => ({ pv_kwh: k.pv[i], load_kwh: k.load[i], import_kwh: k.imp[i], export_kwh: k.exp[i] })),
      };
    }
    const bs = energy.buckets;
    const labelOf = (b) => (energy.bucket === '1mo' ? fmtMonth(b.key) : energy.bucket === '1y' ? b.key : fmtDate(b.from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
    return {
      start: bs.map((b) => dayStart(b.from)), end: bs.map((b) => dayStart(addDays(b.to, 1))),
      coverage: bs.map((b) => b.coverage), provisional: bs.map((b) => b.provisional), label: (i) => labelOf(bs[i]), buckets: bs,
    };
  }

  function drawEnergy(el, data, figs) {
    const m = energyModel(data);
    if (!m || !m.buckets.length) return false;
    const bars = energyBars(m.buckets);
    const x = m.start.map((s, i) => (s + m.end[i]) / 2);
    const series = [
      { key: 'homeSolar', name: t('energy.series.homeSolar'), type: 'bar', entity: 'sun', data: pairs(x, bars.home_solar) },
      { key: 'bought', name: t('energy.series.bought'), type: 'bar', entity: 'grid', data: pairs(x, bars.bought) },
      { key: 'sold', name: t('energy.series.sold'), type: 'bar', entity: 'grid', below: true, data: pairs(x, bars.sold) },
      { key: 'produced', name: t('energy.series.produced'), type: 'line', entity: 'sun', markers: true, data: pairs(x, bars.produced) },
    ];
    const c = data.energy.compare;
    if (c && !hourly) {
      const mt = METRICS[metric];
      series.push({
        key: 'cmp', name: t('energy.cmp.series', { metric: t(mt.name), label: compareLabel(c, locale()) }), type: 'line', entity: mt.entity, dashed: true,
        data: pairs(x, x.map((_, i) => { const v = c.buckets[i]?.[mt.key]; return v == null ? null : v * mt.sign; })),
      });
    }
    const fig = figure(figs, { title: t('energy.chart.energy'), csvName: `energy-${from}_${to}` });
    fig.setCaption(t('energy.caption.energy', {
      produced: kwh(data.energy.total.pv_kwh, 0), consumed: kwh(data.energy.total.load_kwh, 0),
      bought: kwh(data.energy.total.import_kwh, 0), sold: kwh(data.energy.total.export_kwh, 0),
    }));
    const bands = hourly ? [...gapBands({ t: m.start, coverage: m.coverage, bucketMs: HOUR, now: Date.now() }), ...eventBands(data.events, fromMs, toMs)] : [];
    live.push(chart(fig.host, {
      id: 'energy-bars', kind: 'time', unit: 'kWh', x: { min: m.start[0], max: m.end[m.end.length - 1], label: m.label }, y: { decimals: 1 },
      stacked: true, series, coverage: m.coverage, provisional: m.provisional, bands, onZoom,
    }));
    fig.setTable(
      [{ label: t('energy.col.time') }, ...series.map((s) => ({ label: s.name, unit: 'kWh', decimals: 1 }))],
      m.buckets.map((_, i) => [m.label(i), ...series.map((s) => (s.key === 'sold' && s.data[i][1] != null ? -s.data[i][1] : s.data[i][1]))]),
    );
    return true;
  }

  function drawPower(el, data, figs) {
    const s = data.series;
    if (!s || !s.t.length || s.coverage.every((c) => !c)) return false;
    const k = s.series;
    const step = s.t.length > 1 ? s.t[1] - s.t[0] : 300e3;
    const xmax = s.t[s.t.length - 1] + step;
    const label = (i) => fmtDateTime(s.t[i]);
    const bands = [...gapBands({ t: s.t, coverage: s.coverage, bucketMs: step, now: Date.now() }), ...eventBands(data.events, s.t[0], xmax)];
    const line = (key, name, type, entity, arr, extra = {}) => ({ key, name, type, entity, data: pairs(s.t, arr), ...extra });
    const main = [
      line('pv', t('core.entity.sun'), 'area', 'sun', k.pv_kw),
      line('home', t('core.entity.home'), 'line', 'home', k.load_kw, { width: 2.5 }),
      line('charge', t('core.entity.charging'), 'line', 'battery', k.charge_kw),
      line('discharge', t('core.entity.discharging'), 'line', 'battery', k.discharge_kw, { dashed: true }),
      line('bought', t('energy.series.bought'), 'line', 'grid', k.imp_kw, { hidden: true }),
      line('sold', t('energy.series.sold'), 'line', 'grid', k.exp_kw, { hidden: true, dashed: true }),
    ];
    const fig = figure(figs, { title: t('energy.chart.power'), csvName: `power-${from}_${to}` });
    fig.setCaption(t('energy.caption.power', { pv: kw(maxOf(k.pv_kw)), home: kw(maxOf(k.load_kw)) }));
    live.push(chart(fig.host, {
      id: 'energy-power', kind: 'time', unit: 'kW', x: { min: s.t[0], max: xmax, label }, y: { decimals: 2 },
      series: main, coverage: s.coverage, provisional: s.provisional, bands, group: 'energy', onZoom,
    }));
    fig.setTable(
      [{ label: t('energy.col.time') }, ...main.map((m) => ({ label: m.name, unit: 'kW', decimals: 2 }))],
      s.t.map((_, i) => [label(i), ...main.map((m) => m.data[i][1])]),
    );

    const b = status.battery ?? {};
    const refLines = [
      b.reservePct != null && { y: b.reservePct, label: t('energy.ref.reserve'), entity: 'warn' },
      b.minPct != null && { y: b.minPct, label: t('energy.ref.minimum'), entity: 'muted' },
    ].filter(Boolean);
    const strip = figure(figs, { title: t('energy.chart.soc'), csvName: `soc-${from}_${to}` });
    strip.setCaption(t('energy.caption.soc'));
    live.push(chart(strip.host, {
      id: 'energy-soc', kind: 'time', height: 'strip', unit: '%', x: { min: s.t[0], max: xmax, label }, y: { min: 0, max: 100, decimals: 0 },
      series: [line('soc', t('core.entity.soc'), 'area', 'battery', k.soc)], coverage: s.coverage, provisional: s.provisional, bands, refLines, group: 'energy',
    }));
    strip.setTable([{ label: t('energy.col.time') }, { label: t('core.entity.soc'), unit: '%', decimals: 0 }], s.t.map((_, i) => [label(i), k.soc[i]]));
    return true;
  }

  function draw(el, data) {
    destroyCharts();
    const sh = shares(data.energy.total);
    const zoomed = params.has('zoomFrom');
    const metricSelect = mode === 'energy' && cmpOn && !hourly
      ? `<div class="field range-field"><label for="energy-metric">${esc(t('energy.cmp.metric'))}</label><select id="energy-metric">${Object.keys(METRICS)
        .map((m) => `<option value="${m}"${m === metric ? ' selected' : ''}>${esc(t(METRICS[m].name))}</option>`).join('')}</select></div>`
      : '';
    el.innerHTML = `${tiles(data.energy)}
      <section class="card energy-chart-card">
        <div class="energy-tools">${metricSelect}${zoomed ? `<button type="button" class="pill pill-outline" id="energy-reset">${icon('rotate-ccw', { size: 16 })}${esc(t('energy.zoom.reset'))}</button>` : ''}</div>
        ${mode === 'energy' && cmpOn && hourly ? `<p class="hint">${esc(t('energy.cmp.noHourly'))}</p>` : ''}
        <div class="energy-figs"></div>
        ${clamped && (mode === 'power' || hourly) ? `<p class="hint">${esc(t('core.clamped', { date: fmtDate(seriesFrom, { day: 'numeric', month: 'short', year: 'numeric' }) }))}</p>` : ''}
      </section>
      <div class="grid">
        <div class="span-6">${segmented(t('energy.shares.consumption'), [
    { v: sh.consumption.solar, label: 'energy.shares.fromSolar', entity: 'sun' }, { v: sh.consumption.grid, label: 'energy.shares.fromGrid', entity: 'grid' }])}</div>
        <div class="span-6">${segmented(t('energy.shares.solar'), [
    { v: sh.solar.home, label: 'energy.shares.toHome', entity: 'home' }, { v: sh.solar.sold, label: 'energy.shares.toGrid', entity: 'grid' }])}</div>
      </div>`;
    const figs = el.querySelector('.energy-figs');
    const ok = mode === 'power' ? drawPower(el, data, figs) : drawEnergy(el, data, figs);
    if (!ok) figs.innerHTML = emptyState({ title: t('energy.empty.title'), body: t('energy.empty.body'), action: { label: t('charts.range.30d'), href: '#/energy?r=30d&mode=energy' } });
    el.querySelector('#energy-reset')?.addEventListener('click', resetZoom);
    el.querySelector('#energy-metric')?.addEventListener('change', (e) => ctx.setParams({ metric: e.target.value }));
  }

  const body = q('.energy-body');
  await loadBlock(body, 720, async (el) => draw(el, await fetchData()));
  // ranges that include today refresh quietly (no skeleton) every minute
  if (to >= status.today) {
    every(60e3, async () => {
      try {
        draw(body, await fetchData());
      } catch (err) {
        if (err?.name !== 'AbortError') console.error(err);
      }
    }, signal);
  }
  return () => {
    destroyCharts();
    bar.destroy();
  };
}
