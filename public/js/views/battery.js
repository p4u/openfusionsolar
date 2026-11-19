// Battery view: now card, limits with their source, state of charge, charge and discharge, tiles, voltage.
import { register, t } from '../i18n.js';
import dict from '../i18n/battery.js';
import { esc, icon, ledger, loadBlock, emptyState } from '../ui.js';
import { getSeries, getEnergy, getSignals, getSignalHistory } from '../api.js';
import { kw, kwh, pct, nf, duration, fmtTime, fmtDate, fmtDateTime, fmtMonthShort, isoLocal, dayStart } from '../format.js';
import { parseRange } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { defaultMode } from '../buckets.js';
import { figure, chart } from '../charts.js';
import { gapBands, bucketAxis } from '../chart-data.js';
import { STALE_MS } from './now-model.js';
import { BUCKET_MS, chargeEta, clampFrom, seriesBucket, energyBucket, cycles, roundTrip, daysAtMin, hoursBelow, reserveMarks } from './battery-model.js';

register(dict);

const once = (fn) => {
  let p;
  return () => (p ??= fn().catch((err) => {
    p = undefined; // a retry must ask again
    throw err;
  }));
};
const known = (arr) => arr.filter((v) => v != null);
const pairs = (r, arr, f = (v) => v) => r.t.map((x, i) => [x, arr[i] == null ? null : f(arr[i])]);
const xOf = (r) => ({
  min: r.t[0],
  max: r.t.at(-1) + BUCKET_MS[r.bucket],
  label: (i) => (r.bucket === '1d' ? fmtDate(r.t[i], { weekday: 'short', day: 'numeric', month: 'short' }) : fmtDateTime(r.t[i])),
});
const stamp = (r, i) => (r.bucket === '1d' ? fmtDate(r.t[i]) : fmtDateTime(r.t[i]));
// Energy buckets: full label per bucket kind (tooltips and the table); the axis gets short ones from bucketAxis.
const bucketLabel = (bucket, key) => (bucket === '1d' ? fmtDate(key, { weekday: 'short', day: 'numeric', month: 'short' }) : bucket === '1mo' ? fmtMonthShort(key) : key);

function nowCard(status) {
  const b = status.battery ?? {};
  const rt = status.realtime;
  const soc = rt?.soc ?? null;
  const bat = rt?.battery_kw ?? null;
  const usable = soc != null && b.capacityKwh != null ? (Math.max(soc - (b.minPct ?? 0), 0) / 100) * b.capacityKwh : null;
  const state = bat == null ? '' : bat > 0.01 ? t('battery.now.charging', { kw: kw(bat) }) : bat < -0.01 ? t('battery.now.giving', { kw: kw(-bat) }) : t('battery.now.idle');
  const below = soc != null && b.reservePct != null && soc < b.reservePct ? t('battery.now.belowReserve', { pct: b.reservePct }) : '';
  const at = (v) => Math.min(Math.max(v, 0), 100);
  const mark = (v) => (v == null ? '' : `<i class="battery-mark" style="left:${at(v)}%"></i>`);
  // each mark on the bar is named under it; near an edge the name aligns to that edge
  const marks = [[b.minPct, t('battery.ref.min', { v: b.minPct })], [b.reservePct, t('battery.ref.reserve', { v: b.reservePct })]]
    .filter(([v]) => v != null).sort((x, y) => x[0] - y[0]);
  const close = marks.length === 2 && marks[1][0] - marks[0][0] < 30;
  const names = marks.map(([v, text], i) => `<span class="battery-mark-name${v < 15 ? ' at-start' : v > 85 ? ' at-end' : ''}${i === 1 ? ' second' : ''}" style="left:${at(v)}%">${esc(text)}</span>`).join('');
  // how long the current flow would take to reach its next limit (never "full" when the grid stops before)
  const stale = status.lastSampleTs && Date.now() - status.lastSampleTs > STALE_MS;
  const e = chargeEta(rt, b, stale ? Date.now() - status.lastSampleTs : 0);
  const eta = !e ? '' : t(e.kind === 'min' ? 'battery.now.toMin' : e.kind === 'grid' ? 'battery.now.toCutoff' : e.target >= 100 ? 'battery.now.toFull' : 'battery.now.toEnd',
    { d: duration(e.hours * 3600e3), pct: e.target, kw: kw(bat) });
  const sentence = e?.kind === 'grid' ? eta : `${soc == null ? t('battery.now.unknown') : state}${eta ? ` ${eta}` : ''}`; // one sentence when the grid charges
  return `<div class="battery-now">
    <div class="battery-now-main">
      <span class="tile-label">${icon('battery-medium', { size: 16 })}<span>${esc(t('battery.now.charge'))}</span></span>
      <span class="battery-soc num">${esc(pct(soc))}</span>
      <div class="battery-bar" role="img" aria-label="${esc([`${t('battery.now.charge')}: ${pct(soc)}`, ...marks.map(([, text]) => text)].join(', '))}"><span style="width:${soc ?? 0}%"></span>${mark(b.minPct)}${mark(b.reservePct)}</div>
      ${names ? `<div class="battery-mark-names${close ? ' two-rows' : ''}" aria-hidden="true">${names}</div>` : ''}
    </div>
    <div class="battery-now-text">
      ${stale ? `<p class="hint">${esc(t('battery.now.dataFrom', { time: fmtTime(status.lastSampleTs) }))}</p>` : ''}
      <p>${esc(sentence)}</p>
      ${usable == null ? '' : `<p class="hint">${esc(t('battery.now.usable', { kwh: kwh(usable) }))}</p>`}
      ${below ? `<p class="hint">${esc(below)}</p>` : ''}
    </div>
    <dl class="battery-today" data-block="today"></dl></div>`;
}

function limitsCard(status) {
  const b = status.battery ?? {};
  const s = b.source ?? {};
  const rows = [
    ['battery.limit.capacity', b.capacityKwh, kwh, s.capacityKwh],
    ['battery.limit.minPct', b.minPct, pct, s.minPct],
    ['battery.limit.reserve', b.reservePct, pct, s.reservePct],
    ['battery.limit.cutoff', b.gridChargeCutoffPct, pct, s.gridChargeCutoffPct],
    ['battery.limit.maxCharge', b.maxChargeKw, kw, s.maxChargeKw],
    ['battery.limit.maxDischarge', b.maxDischargeKw, kw, s.maxDischargeKw],
  ];
  const src = { env: t('battery.src.env'), fusionsolar: t('battery.src.fusionsolar') };
  return `<dl class="battery-limits">${rows.map(([key, v, f, from]) => `<div class="battery-limit"><dt>${esc(t(key))}</dt>
    <dd><span class="num">${esc(v == null ? t('core.unknown') : f(v))}</span><span class="hint">${esc(v == null ? t('battery.src.none') : src[from] ?? '')}</span></dd></div>`).join('')}</dl>`;
}

export async function render(root, ctx) {
  const { status, signal } = ctx;
  const rctx = { today: ctx.today, firstDay: status.firstDay };
  const range = parseRange(ctx.params, rctx, '7d');
  const power = range.days <= 7;
  const mode = defaultMode(range.days);
  const b = status.battery ?? {};
  const kept = []; // figures and charts to tear down
  const sinceMs = b.reserveSince ? dayStart(b.reserveSince) : null; // the reserve applies from the day it was set
  const cl = clampFrom(range.from, range.to, status.firstSampleDay);
  const note = cl.clamped && !cl.empty ? `<p class="hint">${esc(t('core.clamped', { date: fmtDate(cl.from) }))}</p>` : '';

  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('battery.title'))}</h1></header>
    <div class="battery-range"></div>
    <div class="grid">
      <section class="card span-5" aria-labelledby="battery-now-h"><h2 class="card-title" id="battery-now-h">${esc(t('battery.now.title'))}</h2>${nowCard(status)}</section>
      <section class="card span-7" aria-labelledby="battery-lim-h"><h2 class="card-title" id="battery-lim-h">${esc(t('battery.limits.title'))}</h2>${limitsCard(status)}</section>
    </div>
    <section class="band"><h2 class="section-title">${esc(t('battery.tiles.title'))}</h2><div data-block="tiles"></div></section>
    <section class="band"><div class="card" data-block="soc"></div></section>
    <section class="band"><div class="card" data-block="flow"></div></section>
    <details class="disclosure battery-details"><summary><span>${esc(t('battery.details'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      <div class="card" data-block="voltage"></div></details>`;
  const q = (name) => root.querySelector(`[data-block="${name}"]`);
  const bar = renderRangeBar(root.querySelector('.battery-range'), { range, ctx: rctx, mode, onChange: (p) => ctx.setParams(p) });

  // today's totals fill the "right now" card
  getEnergy({ from: ctx.today, to: ctx.today, bucket: '1d' }, { signal }).then((d) => {
    const el = root.querySelector('[data-block="today"]');
    const tt = d.total ?? {};
    if (!el || (tt.charge_kwh == null && tt.discharge_kwh == null)) return;
    el.innerHTML = `<div><dt>${esc(t('battery.today.charged'))}</dt><dd class="num">${esc(kwh(tt.charge_kwh))}</dd></div>
      <div><dt>${esc(t('battery.today.given'))}</dt><dd class="num">${esc(kwh(tt.discharge_kwh))}</dd></div>`;
  }).catch(() => {}); // the card reads fine without them

  // shared requests, made once and only when a block needs them
  const sBucket = power ? seriesBucket(range) : '1d';
  const getS = (bucket) => getSeries({ from: cl.from, to: range.to, bucket }, { signal });
  const detail = once(() => getS(sBucket));
  const daily = once(() => (sBucket === '1d' ? detail() : getS('1d')));
  const eBucket = energyBucket(range);
  const energy = once(() => getEnergy({ from: range.from, to: range.to, bucket: eBucket }, { signal }));
  const noDetail = () => emptyState({
    title: t('core.empty.title'),
    body: cl.from > range.to && status.firstSampleDay ? t('battery.noReadingsBefore', { date: fmtDate(status.firstSampleDay) }) : t('battery.noReadings'),
  });

  const draw = (el, { title, caption, csv, spec, columns, rows, iso }) => {
    el.replaceChildren();
    const f = figure(el, { title, csvName: `${csv}-${range.from}_${range.to}` });
    f.setCaption(caption);
    f.setTable(columns, rows, iso);
    kept.push(f, chart(f.host, spec));
    if (note) el.insertAdjacentHTML('beforeend', note);
  };

  loadBlock(q('tiles'), 120, async (el) => {
    const [e, d, fine] = await Promise.all([energy(), cl.empty ? null : daily(), cl.empty || !power ? null : detail()]);
    const cap = b.capacityKwh;
    const cyc = cycles(e.total.discharge_kwh, cap);
    const rtv = roundTrip(e.total.charge_kwh, e.total.discharge_kwh, range.days);
    const socMin = d ? d.series.soc_min : [];
    const atMin = daysAtMin(socMin, b.minPct);
    const bucketMs = BUCKET_MS[sBucket];
    const below = fine && bucketMs <= BUCKET_MS['15m'] ? hoursBelow(fine.series.soc, b.reservePct, bucketMs, fine.t, sinceMs) : null;
    const one = (v, digits) => (v == null ? null : nf(digits).format(v));
    const since = b.reserveSince ? fmtDate(b.reserveSince, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    const belowHint = (v) => {
      if (sinceMs != null && dayStart(range.to) + 86400e3 <= sinceMs) return t('battery.tile.belowBefore', { date: since });
      if (v == null) return t('battery.tile.belowNone');
      return sinceMs != null && dayStart(cl.from) < sinceMs ? t('battery.tile.belowSince', { pct: b.reservePct, date: since }) : t('battery.tile.belowHint', { pct: b.reservePct });
    };
    el.innerHTML = ledger([
      { icon: 'rotate-ccw', label: t('battery.tile.cycles'), value: one(cyc, 2), hint: cyc == null ? t('battery.tile.cyclesNone') : t('battery.tile.cyclesHint') },
      { icon: 'activity', label: t('battery.tile.rt'), value: rtv == null ? null : pct(rtv), hint: rtv == null && range.days < 7 ? t('battery.tile.rtShort') : t('battery.tile.rtHint') },
      { icon: 'battery-warning', label: t('battery.tile.min'), value: atMin == null ? null : String(atMin),
        hint: atMin == null ? t('battery.tile.minNone') : t('battery.tile.minHint', { n: known(socMin).length }) },
      { icon: 'clock', label: t('battery.tile.below'), value: below == null ? null : t('core.duration.hours', { n: nf(1).format(below) }),
        hint: belowHint(below) },
    ]);
  });

  loadBlock(q('soc'), 340, async (el) => {
    if (cl.empty) return void (el.innerHTML = noDetail());
    const r = await detail();
    if (!known(r.series.soc).length) return void (el.innerHTML = noDetail());
    const x = xOf(r);
    const lo = Math.min(...known(power ? r.series.soc : r.series.soc_min));
    const hi = Math.max(...known(power ? r.series.soc : r.series.soc_max));
    const reserve = reserveMarks(b.reservePct, sinceMs, r.t);
    const refLines = [
      reserve.mode === 'all' && { y: b.reservePct, entity: 'warn', label: t('battery.ref.reserve', { v: b.reservePct }) },
      b.minPct != null && { y: b.minPct, entity: 'alarm', label: t('battery.ref.min', { v: b.minPct }) },
      b.gridChargeCutoffPct != null && { y: b.gridChargeCutoffPct, entity: 'muted', label: t('battery.ref.cutoff', { v: b.gridChargeCutoffPct }) },
    ].filter(Boolean);
    const mean = { key: 'soc', name: t('battery.soc.mean'), type: 'line', entity: 'battery', data: pairs(r, r.series.soc) };
    const band = {
      key: 'range', name: t('battery.soc.range'), type: 'rangeBar', entity: 'battery',
      data: r.t.map((ms, i) => [ms, r.series.soc_min[i] == null ? null : [r.series.soc_min[i], r.series.soc_max[i]]]),
    };
    draw(el, {
      title: t('battery.soc.title'), caption: t('battery.soc.caption', { min: pct(lo), max: pct(hi) }), csv: 'battery-soc',
      spec: {
        id: 'battery-soc', kind: 'time', unit: '%', x, y: { min: 0, max: 100, decimals: 0 }, refLines, coverage: r.coverage, provisional: r.provisional,
        series: [...(power ? [mean] : [band, mean]),
          ...(reserve.mode === 'part' ? [{ key: 'reserve', name: t('battery.ref.reserve', { v: b.reservePct }), type: 'line', entity: 'warn', dashed: true, data: reserve.data }] : [])],
        bands: power ? gapBands({ t: r.t, coverage: r.coverage, bucketMs: BUCKET_MS[r.bucket], now: Date.now() }) : [],
      },
      columns: [t('battery.col.time'), { label: t('battery.col.soc'), unit: '%', decimals: 0 }, { label: t('battery.col.socMin'), unit: '%', decimals: 0 }, { label: t('battery.col.socMax'), unit: '%', decimals: 0 }],
      rows: r.t.map((_, i) => [stamp(r, i), r.series.soc[i], r.series.soc_min[i], r.series.soc_max[i]]),
      iso: r.t.map((ms) => isoLocal(ms, r.bucket)),
    });
  });

  loadBlock(q('flow'), 340, async (el) => {
    const e = await energy();
    const caption = t('battery.flow.caption', { charged: kwh(e.total.charge_kwh), discharged: kwh(e.total.discharge_kwh) });
    if (power) {
      if (cl.empty) return void (el.innerHTML = noDetail());
      const r = await detail();
      draw(el, {
        title: t('battery.flow.title'), caption, csv: 'battery-flow',
        spec: {
          id: 'battery-flow', kind: 'time', unit: 'kW', x: xOf(r), y: { decimals: 2 }, coverage: r.coverage, provisional: r.provisional,
          series: [
            { key: 'charge', name: t('battery.flow.charged'), type: 'area', entity: 'battery', data: pairs(r, r.series.charge_kw) },
            { key: 'discharge', name: t('battery.flow.discharged'), type: 'area', entity: 'discharge', dashed: true, below: true, data: pairs(r, r.series.discharge_kw, (v) => -v) },
          ],
          bands: gapBands({ t: r.t, coverage: r.coverage, bucketMs: BUCKET_MS[r.bucket], now: Date.now() }),
        },
        columns: [t('battery.col.time'), { label: t('battery.flow.charged'), unit: 'kW' }, { label: t('battery.flow.discharged'), unit: 'kW' }],
        rows: r.t.map((_, i) => [stamp(r, i), r.series.charge_kw[i], r.series.discharge_kw[i]]),
        iso: r.t.map((ms) => isoLocal(ms, r.bucket)),
      });
      return;
    }
    const cats = e.buckets.map((k) => bucketLabel(e.bucket, k.key));
    const axis = bucketAxis(e.buckets.map((k) => k.key), e.bucket);
    draw(el, {
      title: t('battery.flow.title'), caption, csv: 'battery-flow',
      spec: {
        id: 'battery-flow-kwh', kind: 'category', unit: 'kWh', x: { categories: axis.categories, title: axis.title, label: (i) => cats[i] }, y: { decimals: 1 }, stacked: true,
        coverage: e.buckets.map((k) => k.coverage), provisional: e.buckets.map((k) => k.provisional),
        series: [
          { key: 'charge', name: t('battery.flow.charged'), type: 'bar', entity: 'battery', data: e.buckets.map((k) => k.charge_kwh) },
          { key: 'discharge', name: t('battery.flow.discharged'), type: 'bar', entity: 'discharge', below: true, data: e.buckets.map((k) => (k.discharge_kwh == null ? null : -k.discharge_kwh)) },
        ],
      },
      columns: [t('battery.col.period'), { label: t('battery.flow.charged'), unit: 'kWh' }, { label: t('battery.flow.discharged'), unit: 'kWh' }],
      rows: e.buckets.map((k, i) => [cats[i], k.charge_kwh, k.discharge_kwh]),
      iso: e.buckets.map((k) => k.key),
    });
  });

  // details load when first opened: nothing is drawn inside a closed <details>
  root.querySelector('.battery-details').addEventListener('toggle', (ev) => {
    if (!ev.target.open || ev.target.dataset.loaded) return;
    ev.target.dataset.loaded = '1';
    loadBlock(q('voltage'), 340, async (el) => {
      if (cl.empty) return void (el.innerHTML = noDetail());
      const dev = (await getSignals({ signal })).find((d) => d.type === 'Battery');
      const sig = dev?.signals.find((s) => s.unit === 'V');
      if (!sig) return void (el.innerHTML = emptyState({ title: t('battery.voltage.title'), body: t('battery.voltage.none') }));
      const h = await getSignalHistory({ dn: dev.dn, ids: [sig.id], from: cl.from, to: range.to, bucket: sBucket }, { signal });
      const s = h.signals[0];
      const r = { t: h.t, bucket: h.bucket };
      draw(el, {
        title: t('battery.voltage.title'), caption: '', csv: 'battery-voltage',
        spec: {
          id: 'battery-voltage', kind: 'time', unit: 'V', x: xOf(r), y: { decimals: 1 },
          series: [
            { key: 'band', name: t('battery.voltage.band'), type: 'rangeArea', entity: 'battery', data: h.t.map((ms, i) => [ms, s.min[i] == null ? null : [s.min[i], s.max[i]]]) },
            { key: 'mean', name: t('battery.voltage.mean'), type: 'line', entity: 'battery', data: pairs(r, s.avg) },
          ],
        },
        columns: [t('battery.col.time'), { label: t('battery.col.volt'), unit: 'V', decimals: 1 }, { label: t('battery.col.voltMin'), unit: 'V', decimals: 1 }, { label: t('battery.col.voltMax'), unit: 'V', decimals: 1 }],
        rows: h.t.map((_, i) => [stamp(r, i), s.avg[i], s.min[i], s.max[i]]),
        iso: h.t.map((ms) => isoLocal(ms, h.bucket)),
      });
    });
  });

  return () => {
    bar.destroy();
    for (const k of kept) k.destroy();
  };
}
