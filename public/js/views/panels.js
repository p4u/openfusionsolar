// Panels view: production tiles, production chart, year on year, and per-string, temperature and DC vs AC details.
import { register, t } from '../i18n.js';
import dict from '../i18n/panels.js';
import { esc, icon, ledger, loadBlock, emptyState } from '../ui.js';
import { getSeries, getEnergy, getEvents, getSignals, getSignalHistory } from '../api.js';
import { kw, kwh, nf, fmtDate, fmtDateTime, fmtMonth, dayStart } from '../format.js';
import { parseRange } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { defaultMode, addDays } from '../buckets.js';
import { figure, chart } from '../charts.js';
import { gapBands, eventBands } from '../chart-data.js';
import { BUCKET_MS, clampFrom, seriesBucket, energyBucket } from './battery-model.js';
import { kwhPerKwp, peak, stringPairs, stringPower, yoyMonths, stoppedHours } from './panels-model.js';

register(dict);

const once = (fn) => {
  let p;
  return () => (p ??= fn().catch((err) => {
    p = undefined; // a retry must ask again
    throw err;
  }));
};
const known = (arr) => arr.filter((v) => v != null);
const pairs = (r, arr) => r.t.map((x, i) => [x, arr[i] ?? null]);
const xOf = (r) => ({
  min: r.t[0],
  max: r.t.at(-1) + BUCKET_MS[r.bucket],
  label: (i) => (r.bucket === '1d' ? fmtDate(r.t[i], { weekday: 'short', day: 'numeric', month: 'short' }) : fmtDateTime(r.t[i])),
});
const stamp = (r, i) => (r.bucket === '1d' ? fmtDate(r.t[i]) : fmtDateTime(r.t[i]));
const bucketLabel = (bucket, key) => (bucket === '1d' ? fmtDate(key) : bucket === '1mo' ? fmtMonth(key) : key);
const isTemp = (s) => /[℃°]/.test(s.unit ?? '');

export async function render(root, ctx) {
  const { status, signal } = ctx;
  const rctx = { today: ctx.today, firstDay: status.firstDay };
  const range = parseRange(ctx.params, rctx, '7d');
  const power = range.days <= 7;
  const kept = [];
  const cl = clampFrom(range.from, range.to, status.firstSampleDay);
  const note = cl.clamped && !cl.empty ? `<p class="hint">${esc(t('core.clamped', { date: fmtDate(cl.from) }))}</p>` : '';

  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('panels.title'))}</h1></header>
    <div class="panels-range"></div>
    <section class="band"><h2 class="section-title">${esc(t('panels.tiles.title'))}</h2><div data-block="tiles"></div></section>
    <section class="band"><div class="card" data-block="prod"></div></section>
    <section class="band"><div class="card" data-block="yoy"></div></section>
    <details class="disclosure panels-details"><summary><span>${esc(t('panels.details'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      <div class="panels-detail-list">
        <div class="card" data-block="strings"></div>
        <div class="card" data-block="temp"></div>
        <div class="card" data-block="dcac"></div>
      </div></details>`;
  const q = (name) => root.querySelector(`[data-block="${name}"]`);
  const bar = renderRangeBar(root.querySelector('.panels-range'), { range, ctx: rctx, mode: defaultMode(range.days), onChange: (p) => ctx.setParams(p) });

  const sBucket = power ? seriesBucket(range) : '1d';
  const getS = (bucket) => getSeries({ from: cl.from, to: range.to, bucket }, { signal });
  const detail = once(() => getS(sBucket));
  // the peak needs fine readings: 5m or 15m, or hourly means up to a month
  const peakBucket = range.days <= 2 ? '5m' : range.days <= 7 ? '15m' : range.days <= 31 ? '1h' : null;
  const fine = once(() => (peakBucket === sBucket ? detail() : getS(peakBucket)));
  const eBucket = energyBucket(range);
  const compare = !power && range.cmp !== 'none' ? range.cmp : undefined;
  const energy = once(() => getEnergy({ from: range.from, to: range.to, bucket: eBucket, compare }, { signal }));
  const bestFrom = range.days > 750 ? addDays(range.to, -749) : range.from; // 1d energy buckets are capped at 750
  const daily = once(() => getEnergy({ from: bestFrom, to: range.to, bucket: '1d' }, { signal }));
  const evFrom = range.days > 800 ? addDays(range.to, -799) : range.from;
  const events = once(() => getEvents({ from: evFrom, to: range.to, kinds: 'noProduction' }, { signal }));
  const noDetail = () => emptyState({
    title: t('core.empty.title'),
    body: cl.from > range.to && status.firstSampleDay ? t('panels.noReadingsBefore', { date: fmtDate(status.firstSampleDay) }) : t('panels.noReadings'),
  });

  const draw = (el, { title, caption, csv, spec, columns, rows }) => {
    el.replaceChildren();
    const f = figure(el, { title, csvName: csv });
    f.setCaption(caption);
    f.setTable(columns, rows);
    kept.push(f, chart(f.host, spec));
    return f;
  };

  loadBlock(q('tiles'), 120, async (el) => {
    const [e, d, ev, p] = await Promise.all([energy(), daily(), events(), cl.empty || !peakBucket ? null : fine()]);
    const top = p ? peak(pairs(p, p.series.pv_kw)) : null;
    const best = d.buckets.reduce((a, k) => (k.pv_kwh != null && (a == null || k.pv_kwh > a.pv_kwh) ? k : a), null);
    const perKwp = kwhPerKwp(e.total.pv_kwh, status.station?.capacity);
    const stopped = stoppedHours(ev, dayStart(evFrom), dayStart(addDays(range.to, 1)), Date.now());
    el.innerHTML = ledger([
      { icon: 'sun', label: t('panels.tile.produced'), value: e.total.pv_kwh == null ? null : kwh(e.total.pv_kwh), hint: t('panels.tile.producedHint') },
      { icon: 'zap', label: t('panels.tile.peak'), value: top ? kw(top.kw) : null,
        hint: top ? t(peakBucket === '1h' ? 'panels.tile.peakHourly' : 'panels.tile.peakAt', { when: fmtDateTime(top.ts) }) : t('panels.tile.peakNone') },
      { icon: 'gauge', label: t('panels.tile.kwp'), value: perKwp == null ? null : `${nf(2).format(perKwp)} kWh/kWp`, hint: perKwp == null ? t('panels.tile.kwpNone') : t('panels.tile.kwpHint') },
      { icon: 'calendar', label: t('panels.tile.best'), value: best ? kwh(best.pv_kwh) : null, hint: best ? fmtDate(best.key) : t('panels.tile.bestNone') },
      { icon: 'zap-off', label: t('panels.tile.stopped'), value: t('core.duration.hours', { n: nf(1).format(stopped) }), hint: t('panels.tile.stoppedHint') },
    ]);
    if (evFrom !== range.from) el.insertAdjacentHTML('beforeend', `<p class="hint">${esc(t('core.clamped', { date: fmtDate(evFrom) }))}</p>`);
  });

  loadBlock(q('prod'), 340, async (el) => {
    if (power) {
      if (cl.empty) return void (el.innerHTML = noDetail());
      const [r, ev, e] = await Promise.all([detail(), events(), energy()]);
      if (!known(r.series.pv_kw).length) return void (el.innerHTML = noDetail());
      draw(el, {
        title: t('panels.prod.title'), caption: t('panels.prod.caption', { kwh: kwh(e.total.pv_kwh) }), csv: 'panels-production',
        spec: {
          id: 'panels-production', kind: 'time', unit: 'kW', x: xOf(r), y: { min: 0, decimals: 2 }, coverage: r.coverage, provisional: r.provisional,
          series: [
            { key: 'dc', name: t('panels.prod.dc'), type: 'area', entity: 'sun', data: pairs(r, r.series.pv_kw) },
            { key: 'ac', name: t('panels.prod.ac'), type: 'line', entity: 'p2', data: pairs(r, r.series.inverter_kw) },
          ],
          bands: [...gapBands({ t: r.t, coverage: r.coverage, bucketMs: BUCKET_MS[r.bucket], now: Date.now() }), ...eventBands(ev, r.t[0], r.t.at(-1) + BUCKET_MS[r.bucket])],
        },
        columns: [t('panels.col.time'), { label: t('panels.prod.dc'), unit: 'kW' }, { label: t('panels.prod.ac'), unit: 'kW' }],
        rows: r.t.map((_, i) => [stamp(r, i), r.series.pv_kw[i], r.series.inverter_kw[i]]),
      });
      el.insertAdjacentHTML('beforeend', note);
      return;
    }
    const e = await energy();
    const cats = e.buckets.map((k) => bucketLabel(e.bucket, k.key));
    const cmp = e.compare?.comparable ? e.compare.buckets : null;
    const series = [{ key: 'kwh', name: t('panels.prod.kwh'), type: 'bar', entity: 'sun', data: e.buckets.map((k) => k.pv_kwh) }];
    if (cmp) series.push({ key: 'cmp', name: t('panels.prod.compare'), type: 'line', entity: 'muted', dashed: true, data: e.buckets.map((_, i) => cmp[i]?.pv_kwh ?? null) });
    const f = draw(el, {
      title: t('panels.prod.title'), caption: t('panels.prod.caption', { kwh: kwh(e.total.pv_kwh) }), csv: 'panels-production',
      spec: {
        id: 'panels-production-kwh', kind: 'category', unit: 'kWh', x: { categories: cats }, y: { min: 0, decimals: 1 },
        coverage: e.buckets.map((k) => k.coverage), provisional: e.buckets.map((k) => k.provisional), series,
      },
      columns: [t('panels.col.period'), { label: t('panels.prod.kwh'), unit: 'kWh' }, ...(cmp ? [{ label: t('panels.prod.compare'), unit: 'kWh' }] : [])],
      rows: e.buckets.map((k, i) => [cats[i], k.pv_kwh, ...(cmp ? [cmp[i]?.pv_kwh ?? null] : [])]),
    });
    if (e.compare && !e.compare.comparable) f.setCaption(`${t('panels.prod.caption', { kwh: kwh(e.total.pv_kwh) })} ${({ beforeFirstDay: t('panels.cmp.beforeFirstDay'), lowCoverage: t('panels.cmp.lowCoverage') })[e.compare.reason]}`);
  });

  loadBlock(q('yoy'), 340, async (el) => {
    const year = Number(range.to.slice(0, 4));
    const get = (y) => getEnergy({ from: `${y}-01-01`, to: `${y}-12-31`, bucket: '1mo' }, { signal });
    const [a, b] = await Promise.all([get(year), get(year - 1)]);
    const rows = yoyMonths(a.buckets, b.buckets);
    if (!rows.some((m) => m.thisYear != null || m.lastYear != null)) return void (el.innerHTML = emptyState({ title: t('panels.yoy.title'), body: t('panels.yoy.none') }));
    const cats = rows.map((m) => fmtDate(`${year}-${String(m.month).padStart(2, '0')}-15`, { month: 'short' }));
    draw(el, {
      title: t('panels.yoy.title'), caption: t('panels.yoy.caption', { year, last: year - 1 }), csv: 'panels-year-on-year',
      spec: {
        id: 'panels-yoy', kind: 'category', unit: 'kWh', x: { categories: cats }, y: { min: 0, decimals: 0 },
        series: [
          { key: 'this', name: String(year), type: 'bar', entity: 'sun', data: rows.map((m) => m.thisYear) },
          { key: 'last', name: String(year - 1), type: 'bar', entity: 'muted', data: rows.map((m) => m.lastYear) },
        ],
      },
      columns: [t('panels.col.month'), { label: String(year), unit: 'kWh', decimals: 0 }, { label: String(year - 1), unit: 'kWh', decimals: 0 }],
      rows: rows.map((m, i) => [cats[i], m.thisYear, m.lastYear]),
    });
  });

  // details load when first opened: nothing is drawn inside a closed <details>
  const inverter = once(async () => (await getSignals({ signal })).find((d) => d.type === 'Inverter'));
  const history = (dn, ids) => getSignalHistory({ dn, ids, from: cl.from, to: range.to, bucket: sBucket }, { signal });

  root.querySelector('.panels-details').addEventListener('toggle', (ev) => {
    if (!ev.target.open || ev.target.dataset.loaded) return;
    ev.target.dataset.loaded = '1';

    loadBlock(q('strings'), 240, async (el) => {
      if (cl.empty) return void (el.innerHTML = noDetail());
      const inv = await inverter();
      const strings = inv ? stringPairs(inv.signals) : [];
      if (!strings.length) return void (el.innerHTML = emptyState({ title: t('panels.strings.title'), body: t('panels.strings.none') }));
      // the history call takes at most 6 ids: three strings per request
      const groups = [];
      for (let i = 0; i < strings.length; i += 3) groups.push(strings.slice(i, i + 3));
      const got = await Promise.all(groups.map((g) => history(inv.dn, g.flatMap((s) => [s.voltage, s.current]))));
      el.replaceChildren();
      el.insertAdjacentHTML('afterbegin', `<h3 class="card-title">${esc(t('panels.strings.title'))}</h3><p class="hint">${esc(t('panels.string.caption'))}</p><div class="panels-strings"></div>`);
      const list = el.querySelector('.panels-strings');
      groups.forEach((g, gi) => g.forEach((s) => {
        const [v, a] = [got[gi].signals.find((x) => x.id === s.voltage), got[gi].signals.find((x) => x.id === s.current)];
        const r = { t: got[gi].t, bucket: got[gi].bucket };
        const p = v.avg.map((x, i) => stringPower(x, a.avg[i]));
        const f = figure(list, { title: t('panels.string', { n: s.n }), csvName: `panels-string-${s.n}` });
        f.setTable([t('panels.col.time'), { label: t('panels.col.volt'), unit: 'V', decimals: 1 }, { label: t('panels.col.amp'), unit: 'A', decimals: 2 }, { label: t('panels.col.power'), unit: 'kW', decimals: 3 }],
          r.t.map((_, i) => [stamp(r, i), v.avg[i], a.avg[i], p[i]]));
        kept.push(f);
        for (const [key, unit, name, vals, decimals] of [['v', 'V', t('panels.col.volt'), v.avg, 1], ['a', 'A', t('panels.col.amp'), a.avg, 2], ['kw', 'kW', t('panels.col.power'), p, 3]]) {
          const strip = document.createElement('div');
          f.host.append(strip);
          kept.push(chart(strip, {
            id: `panels-s${s.n}-${key}`, kind: 'time', height: 'strip', unit, group: `panels-s${s.n}`, x: xOf(r), y: { decimals },
            series: [{ key, name, type: 'line', entity: 'sun', data: pairs(r, vals) }],
          }));
        }
      }));
      el.insertAdjacentHTML('beforeend', note);
    });

    loadBlock(q('temp'), 340, async (el) => {
      if (cl.empty) return void (el.innerHTML = noDetail());
      const inv = await inverter();
      const sig = inv?.signals.find(isTemp);
      if (!sig) return void (el.innerHTML = emptyState({ title: t('panels.temp.title'), body: t('panels.temp.none') }));
      const h = await history(inv.dn, [sig.id]);
      const s = h.signals[0];
      const r = { t: h.t, bucket: h.bucket };
      draw(el, {
        title: t('panels.temp.title'), caption: '', csv: 'panels-temperature',
        spec: {
          id: 'panels-temperature', kind: 'time', unit: sig.unit, x: xOf(r), y: { decimals: 1 },
          series: [
            { key: 'band', name: t('panels.temp.band'), type: 'rangeArea', entity: 'sun', data: h.t.map((ms, i) => [ms, s.min[i] == null ? null : [s.min[i], s.max[i]]]) },
            { key: 'mean', name: t('panels.temp.mean'), type: 'line', entity: 'sun', data: pairs(r, s.avg) },
          ],
        },
        columns: [t('panels.col.time'), { label: t('panels.col.temp'), unit: sig.unit, decimals: 1 }, { label: t('panels.col.tempMin'), unit: sig.unit, decimals: 1 }, { label: t('panels.col.tempMax'), unit: sig.unit, decimals: 1 }],
        rows: h.t.map((_, i) => [stamp(r, i), s.avg[i], s.min[i], s.max[i]]),
      });
    });

    loadBlock(q('dcac'), 340, async (el) => {
      if (cl.empty) return void (el.innerHTML = noDetail());
      const r = await detail();
      if (!known(r.series.pv_kw).length) return void (el.innerHTML = noDetail());
      let dc = 0;
      let ac = 0;
      r.t.forEach((_, i) => {
        if (r.series.pv_kw[i] != null && r.series.inverter_kw[i] != null) {
          dc += r.series.pv_kw[i];
          ac += r.series.inverter_kw[i];
        }
      });
      draw(el, {
        title: t('panels.dcac.title'), caption: dc > 0 ? t('panels.dcac.caption', { pct: `${Math.round((ac / dc) * 100)} %` }) : '', csv: 'panels-dc-ac',
        spec: {
          id: 'panels-dcac', kind: 'time', unit: 'kW', x: xOf(r), y: { min: 0, decimals: 2 }, coverage: r.coverage, provisional: r.provisional,
          series: [
            { key: 'dc', name: t('panels.prod.dc'), type: 'line', entity: 'sun', data: pairs(r, r.series.pv_kw) },
            { key: 'ac', name: t('panels.prod.ac'), type: 'line', entity: 'p2', dashed: true, data: pairs(r, r.series.inverter_kw) },
          ],
        },
        columns: [t('panels.col.time'), { label: t('panels.prod.dc'), unit: 'kW' }, { label: t('panels.prod.ac'), unit: 'kW' }],
        rows: r.t.map((_, i) => [stamp(r, i), r.series.pv_kw[i], r.series.inverter_kw[i]]),
      });
      el.insertAdjacentHTML('beforeend', note);
    });
  });

  return () => {
    bar.destroy();
    for (const k of kept) k.destroy();
  };
}
