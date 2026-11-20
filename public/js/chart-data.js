// Pure chart helpers (no DOM, so they run under Node): ApexCharts options from a chart spec, CSV, bands, opacity.
// Data layout: kind 'time' series take [ms, y] pairs, kind 'category' series take y values aligned with
// x.categories; y is a number, null (a gap) or [min, max] for range types. All series of a chart share one x grid.
import { t } from './i18n.js';
import { nf, nfAxis, fmtDate, fmtTime, fmtMonthShort, dayOf, dayStart } from './format.js';
import { esc } from './ui.js';
import { addMonths } from './buckets.js';

export const PARTIAL = 0.9; // coverage below this is drawn faded and flagged in the tooltip
const GAP_MIN_MS = 15 * 60e3;
// mobile: a one-row legend and the x labels leave a plot of about 200 px
export const HEIGHTS = { desktop: 340, mobile: 280, strip: 160 };
const DAY_MS = 86400e3;

const HOUR_MS = 3600e3;
// Tick units of a time axis: span ceilings (with an hour of slack for DST days), unit length and the steps tried.
const UNITS = [
  { unit: 'hour', upTo: 2 * DAY_MS + 2 * HOUR_MS, ms: HOUR_MS, steps: [1, 2, 3, 4, 6, 12] },
  { unit: 'day', upTo: 45 * DAY_MS + 2 * HOUR_MS, ms: DAY_MS, steps: [1, 2, 3, 5, 7] },
  { unit: 'month', upTo: 731 * DAY_MS + 2 * HOUR_MS, ms: 30.436875 * DAY_MS, steps: [1, 2, 3, 6] },
  { unit: 'year', upTo: Infinity, ms: 365.2425 * DAY_MS, steps: [1, 2, 5, 10, 20] },
];
const unitOf = (span) => UNITS.find((u) => span <= u.upTo);

// The one tick strategy of every time axis. ApexCharts spaces ticks evenly from x.min to x.max (a custom label
// formatter turns its calendar scale off), so the tick count is chosen to land each tick on a unit boundary:
// whole hours up to 2 days, days up to 45 days, months up to 2 years, then years. A month or year axis is widened
// to whole months or years (a part of a month cannot hold even monthly ticks). The step is the smallest that divides
// the span into at most maxTicks ticks; when none does, one tick per unit and the overlapping labels hide.
// Returns { unit, tickAmount, min, max }: min and max are the axis extent to draw.
export function timeAxis(min, max, { mobile = false } = {}) {
  const u = unitOf(max - min);
  if (u.unit === 'month' || u.unit === 'year') {
    const cut = u.unit === 'month' ? 7 : 4;
    const start = (ms) => dayStart(`${dayOf(ms).slice(0, cut)}${u.unit === 'month' ? '-01' : '-01-01'}`);
    const next = (ms) => dayStart(addMonths(`${dayOf(ms).slice(0, 7)}-01`, u.unit === 'month' ? 1 : 12 - Number(dayOf(ms).slice(5, 7)) + 1));
    min = start(min);
    if (start(max) !== max) max = next(max);
  }
  const count = Math.max(1, Math.round((max - min) / u.ms));
  // a phone day reads "19 nov., 06:00, 12:00, 18:00": four hour labels never touch on a 300 px plot
  const maxTicks = mobile ? (u.unit === 'hour' ? 4 : 6) : 12;
  const step = u.steps.find((s) => count % s === 0 && count / s <= maxTicks && count / s >= Math.min(4, count)) ?? 1;
  return { unit: u.unit, tickAmount: count / step, min, max };
}

const dayMonth = (ms) => fmtDate(ms, { day: 'numeric', month: 'short' }).replace(/ de | d’/, ' '); // "13 nov.", not "13 de nov."

// Tick label: the unit boundary nearest the tick (a DST day moves an even tick by an hour), always ascending.
// Hours show the date on day boundaries; days show day and month; months their year; years the year.
export function timeTick(ms, span) {
  const { unit } = unitOf(span);
  if (unit === 'hour') {
    const h = Math.round(ms / HOUR_MS) * HOUR_MS;
    return dayStart(dayOf(h)) === h ? dayMonth(h) : fmtTime(h);
  }
  if (unit === 'day') return dayMonth(dayStart(dayOf(ms + 12 * HOUR_MS)));
  if (unit === 'month') return fmtMonthShort(dayOf(ms + 15 * DAY_MS).slice(0, 7));
  return dayOf(ms + 15 * DAY_MS).slice(0, 4);
}

// Category axis of calendar buckets (keys 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'): one short label per bar, never trimmed.
// Days read "10", "11" with the month in the axis title; months "gen.", "febr." with the year in the title, or on
// the first bar and each January when the range spans years; years read as themselves.
export function bucketAxis(keys, bucket) {
  if (!keys.length) return { categories: [], title: '' };
  const years = [...new Set(keys.map((k) => k.slice(0, 4)))];
  const monthName = (ym, opts) => fmtDate(`${ym}-15`, opts);
  if (bucket === '1d') {
    const months = [...new Set(keys.map((k) => k.slice(0, 7)))];
    const short = (ym) => monthName(ym, { month: 'short' });
    const title = months.length === 1 ? monthName(months[0], { month: 'long', year: 'numeric' })
      : `${short(months[0])}${years.length > 1 ? ` ${years[0]}` : ''} – ${short(months.at(-1))} ${years.at(-1)}`;
    return { categories: keys.map((k) => String(Number(k.slice(8, 10)))), title };
  }
  if (bucket === '1mo') {
    const short = (k) => monthName(k, { month: 'short' });
    if (years.length === 1) return { categories: keys.map(short), title: years[0] };
    return { categories: keys.map((k, i) => (i === 0 || k.endsWith('-01') ? `${short(k)} ${k.slice(0, 4)}` : short(k))), title: `${years[0]} – ${years.at(-1)}` };
  }
  return { categories: keys.slice(), title: '' };
}

// A y axis never narrower than its labels can tell apart: a nearly flat signal (-1.000 to -0.997 kW shown with 2
// decimals) would get ticks that all read "-1", and the overlapping ones hide. An unstacked chart whose data spans less
// than a tenth of its size (or four label steps) is widened around it; a fixed end stays where it is.
// Returns { min, max }: undefined leaves that end to ApexCharts.
export function yExtent(spec) {
  const { min, max } = spec.y ?? {};
  if (spec.stacked || (min != null && max != null)) return { min, max };
  const time = spec.kind !== 'category';
  const vals = spec.series.flatMap((s) => s.data.flatMap((p) => { const v = time ? p?.[1] : p; return Array.isArray(v) ? v : [v]; }))
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { min, max };
  const lo = Math.min(min ?? Infinity, ...vals);
  const hi = Math.max(max ?? -Infinity, ...vals);
  const need = Math.max(Math.abs(lo + hi) / 20, 4 * 10 ** -(spec.y?.decimals ?? 1));
  if (hi - lo >= need) return { min, max };
  if (min != null) return { min, max: min + need };
  if (max != null) return { min: max - need, max };
  return { min: (lo + hi - need) / 2, max: (lo + hi + need) / 2 };
}

// A bar label that carries its year ("gen. 2026") is drawn on two lines (ApexCharts takes an array), so it is no
// wider than its neighbours and the year at each change is never the label hidden for overlapping.
export const twoLines = (c) => { const m = /^(.+) (\d{4})$/.exec(c ?? ''); return m ? [m[1], m[2]] : c; };

// Accessible name of a chart, in the app language: what it shows and where the numbers are.
export function chartLabel(spec) {
  return t('charts.a11y.chart', { names: spec.series.map((s) => s.name).join(', ') });
}

// ApexCharts fills {name} and {state} itself, so they must survive our own placeholder pass.
export const legendItemTemplate = () => t('charts.a11y.legendItem', { name: '{name}', state: '{state}' });

export const opacityFor = (coverage) => (coverage == null || coverage >= PARTIAL ? 1 : coverage <= 0 ? null : 0.45);

// Runs of buckets with no readings; short runs and the most recent 15 minutes are not shown (data may still arrive).
export function gapBands({ t: times, coverage, bucketMs, now }) {
  const out = [];
  const limit = now - GAP_MIN_MS;
  let start = null;
  const close = (end) => {
    const to = Math.min(end, limit);
    if (start != null && to - start >= GAP_MIN_MS) out.push({ from: start, to, kind: 'gap' });
    start = null;
  };
  times.forEach((ms, i) => {
    if (coverage[i] === 0) start ??= ms;
    else if (start != null) close(ms);
  });
  if (start != null) close(times[times.length - 1] + bucketMs);
  return out;
}

const EVENT_KIND = { gridCut: 'cut', noProduction: 'stopped' };
export function eventBands(events, from, to) {
  return events.filter((e) => EVENT_KIND[e.kind]).map((e) => ({ from: Math.max(e.start, from), to: Math.min(e.end ?? to, to), kind: EVENT_KIND[e.kind] }))
    .filter((b) => b.to > b.from);
}

const cell = (v) => {
  if (v == null) return '';
  // a text cell a spreadsheet would read as a formula (labels come from the assistant) gets a leading apostrophe
  const s = typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// numbers keep at most 3 decimals: no float noise like 168.63999999999993
const round3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 + 0 : v);

// RFC 4180: CRLF lines, quotes doubled, header "Label (unit)", dot decimals, empty for null.
export function toCsv(columns, rows) {
  const head = columns.map((c) => (typeof c === 'string' ? c : c.unit ? `${c.label} (${c.unit})` : c.label));
  return [head, ...rows.map((r) => r.map(round3))].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const yOf = (point) => (Array.isArray(point) ? point[1] : point);

// Fill opacity as drawn: areas and ranges are washes so the lines over them stay readable.
const FILL = { area: 0.25, rangeArea: 0.25, rangeBar: 0.3 };
const fillOf = (s) => FILL[s.type] ?? 1;

// A series that lives below zero (sold, discharged): flagged by the view or every non-zero value negative.
export function isBelow(spec, s) {
  if (s.below) return true;
  const ys = s.data.map((p) => (spec.kind === 'category' ? p : p?.[1])).filter((v) => typeof v === 'number' && v !== 0);
  return ys.length > 0 && ys.every((v) => v < 0);
}

// Legend key drawn like its series (18 px box), so identity never rests on colour alone: a block for bars, above or
// below a baseline when the chart diverges; a wash with its edge for areas; a stroke, dashed and dotted as drawn, for lines.
export function legendKey(s, { colour, text, surface, diverging = false, below = false }) {
  const c = esc(colour);
  const dash = s.dashed ? ' stroke-dasharray="5 3"' : '';
  let body;
  if (s.type === 'bar') {
    body = !diverging ? `<rect x="3" y="3" width="12" height="12" rx="2" fill="${c}"/>`
      : `<rect x="4" y="${below ? 9 : 1}" width="10" height="8" fill="${c}"/><line x1="1" y1="9" x2="17" y2="9" stroke="${esc(text)}" stroke-width="1.5"/>`;
  } else if (s.type === 'rangeBar') {
    body = `<rect x="5" y="1" width="8" height="16" rx="2" fill="${c}" fill-opacity="${FILL.rangeBar}"/>`;
  } else if (s.type === 'rangeArea') {
    body = `<rect x="1" y="4" width="16" height="10" fill="${c}" fill-opacity="${FILL.rangeArea}"/>`;
  } else if (s.type === 'area') {
    const edge = below ? 13 : 5;
    body = `<rect x="1" y="5" width="16" height="8" fill="${c}" fill-opacity="${FILL.area}"/><line x1="1" y1="${edge}" x2="17" y2="${edge}" stroke="${c}" stroke-width="2"${dash}/>`;
  } else {
    body = `<line x1="1" y1="9" x2="17" y2="9" stroke="${c}" stroke-width="2.5"${dash}/>`
      + (s.markers ? `<circle cx="9" cy="9" r="3.5" fill="${c}" stroke="${esc(surface)}" stroke-width="1.5"/>` : '');
  }
  return `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">${body}</svg>`;
}
const at = (s, i) => s.data[i];

// Shared tooltip: header, every visible series with its unit, then data-quality notes.
export function tooltipHtml(spec, i, hidden = new Set(), palette = {}) {
  const num = (v) => nf(spec.y?.decimals ?? 1).format(v);
  const show = (p) => {
    if (p == null) return t('core.unknown');
    const v = spec.kind === 'time' ? p[1] : p;
    // the series name carries the direction (sold, discharged), so values below zero read as amounts
    return Array.isArray(v) ? `${num(v[0])} – ${num(v[1])} ${esc(spec.unit)}` : v == null ? t('core.unknown') : `${num(Math.abs(v))} ${esc(spec.unit)}`;
  };
  const head = spec.x?.label ? spec.x.label(i) : spec.kind === 'category' ? spec.x.categories[i] : '';
  const rows = spec.series.filter((s) => !hidden.has(s.key)).map((s) => {
    const colour = palette[s.entity] ?? 'currentColor';
    return `<div class="chart-tip-row"><span class="chart-tip-dot" style="background:${esc(colour)}"></span><span class="chart-tip-name">${esc(s.name)}</span><span class="chart-tip-value num">${show(at(s, i))}</span></div>`;
  }).join('');
  const cov = spec.coverage?.[i];
  const notes = [];
  if (cov === 0) notes.push(t('charts.noReadings'));
  else if (cov != null && cov < PARTIAL) notes.push(t('charts.partial', { pct: Math.round(cov * 100) }));
  if (Array.isArray(spec.provisional) ? spec.provisional[i] : spec.provisional) notes.push(t('charts.provisional'));
  return `<div class="chart-tip"><div class="chart-tip-head">${esc(head)}</div>${rows}${notes.map((n) => `<div class="chart-tip-note">${esc(n)}</div>`).join('')}</div>`;
}

// Donut slice tooltip: its name, amount and share of the whole.
export function sliceTipHtml(spec, i, palette = {}) {
  const s = spec.series[i];
  if (!s) return '';
  const v = s.data[0];
  const total = spec.series.reduce((a, x) => a + (x.data[0] ?? 0), 0);
  const share = total > 0 && v != null ? ` (${nf(0).format((100 * v) / total)}\u00a0%)` : '';
  const value = v == null ? t('core.unknown') : `${nf(spec.y?.decimals ?? 1).format(v)} ${esc(spec.unit)}${share}`;
  return `<div class="chart-tip"><div class="chart-tip-row"><span class="chart-tip-dot" style="background:${esc(palette[s.entity] ?? 'currentColor')}"></span><span class="chart-tip-name">${esc(s.name)}</span><span class="chart-tip-value num">${value}</span></div></div>`;
}

// Donut (one slice per series, data [total]) and heatmap (one row per series over x.categories). Both draw their
// tooltip with esc(): ApexCharts' default tooltip inserts series names as HTML.
function roundOptions(spec, palette, chart, text, hidden) {
  const legendMarkers = { size: 8, strokeWidth: 1, customHTML: spec.series.map((s) => { const html = legendKey({ type: 'bar' }, { colour: palette[s.entity] ?? palette.muted }); return () => html; }) };
  const common = { dataLabels: { enabled: false }, stroke: { width: spec.kind === 'donut' ? 2 : 1, colors: [palette.surface] } };
  if (spec.kind === 'donut') {
    return {
      ...common, chart: { ...chart, type: 'donut' },
      series: spec.series.map((s) => s.data[0] ?? 0), labels: spec.series.map((s) => s.name),
      colors: spec.series.map((s) => palette[s.entity] ?? palette.muted),
      legend: { show: true, position: 'top', horizontalAlign: 'left', fontFamily: palette.fontFamily, labels: { colors: palette.text }, markers: legendMarkers },
      plotOptions: { pie: { donut: { size: '62%', labels: { show: false } } } },
      tooltip: { custom: ({ seriesIndex }) => sliceTipHtml(spec, seriesIndex, palette) },
    };
  }
  const cats = spec.x?.categories ?? [];
  return {
    ...common, chart: { ...chart, type: 'heatmap' },
    series: spec.series.map((s) => ({ name: s.name, data: s.data.map((v, i) => ({ x: cats[i], y: v })) })),
    colors: [palette[spec.series[0]?.entity] ?? palette.muted],
    legend: { show: false },
    plotOptions: { heatmap: { enableShades: true, shadeIntensity: 0.85, radius: 0 } },
    grid: { borderColor: palette.hairline, padding: { left: 8, right: 8 } },
    xaxis: {
      type: 'category', categories: cats, tooltip: { enabled: false }, axisBorder: { color: palette.hairline }, axisTicks: { color: palette.hairline },
      labels: { style: text, rotate: 0, rotateAlways: false, hideOverlappingLabels: true, trim: false },
      title: { text: spec.x?.title ?? '', style: { ...text, fontWeight: 400 } },
    },
    yaxis: { labels: { style: text } },
    tooltip: { shared: false, intersect: true, custom: ({ dataPointIndex }) => tooltipHtml(spec, dataPointIndex, hidden, palette) },
  };
}

// palette: { sun, home, grid, battery, p1..p3, ok, warn, alarm, muted, text, ink, hairline, surface, fontFamily, band: { gap, cut, stopped } }
// opts: { mobile, hidden (Set of series keys), zoom (true when drag-zoom is on) }
// spec.kind 'time' | 'category' draw a mixed chart; 'donut' and 'heatmap' draw those ApexCharts types.
export function apexOptions(spec, palette, { mobile = false, hidden = new Set(), zoom = false } = {}) {
  const time = spec.kind !== 'category';
  const height = spec.height === 'strip' ? HEIGHTS.strip : spec.height ?? (mobile ? HEIGHTS.mobile : HEIGHTS.desktop);
  const text = { fontFamily: palette.fontFamily, colors: palette.text, fontSize: '12px' };
  const chart = {
    id: spec.id,
    type: 'line', // mixed chart: each series carries its own type
    height,
    stacked: !!spec.stacked,
    animations: { enabled: false },
    toolbar: { show: false },
    zoom: { enabled: zoom, type: 'x' },
    background: 'transparent',
    foreColor: palette.text,
    fontFamily: palette.fontFamily,
    parentHeightOffset: 0,
    // ApexCharts' own screen-reader texts (legend items) in the app language
    locales: [{ name: 'app', options: { a11y: {
      legendItem: legendItemTemplate(), visible: t('charts.a11y.visible'), hidden: t('charts.a11y.hidden'),
    } } }],
    defaultLocale: 'app',
    // the chart's own name: ApexCharts would announce "line chart with 6 data series" in English
    accessibility: { description: chartLabel(spec) },
  };
  if (spec.kind === 'donut' || spec.kind === 'heatmap') return roundOptions(spec, palette, { ...chart, stacked: false, zoom: { enabled: false } }, text, hidden);
  const span = time ? (spec.x?.max ?? 0) - (spec.x?.min ?? 0) : 0;
  const axis = time && spec.x?.min != null && spec.x?.max != null ? timeAxis(spec.x.min, spec.x.max, { mobile }) : null;
  const cats = (spec.x?.categories ?? []).map(twoLines);
  const series = spec.series.map((s) => ({
    name: s.name,
    type: s.type,
    data: s.data.map((p, i) => (time ? { x: p[0], y: p[1] } : { x: cats[i], y: p })),
  }));
  const colors = spec.series.map((s) => {
    const base = palette[s.entity] ?? palette.muted;
    return s.type === 'bar'
      ? ({ dataPointIndex }) => rgba(base, opacityFor(spec.coverage?.[dataPointIndex]) ?? 0)
      : base;
  });
  const diverging = spec.series.some((s) => isBelow(spec, s));
  const keys = spec.series.map((s) => {
    const html = legendKey(s, { colour: palette[s.entity] ?? palette.muted, text: palette.text, surface: palette.surface, diverging, below: isBelow(spec, s) });
    return () => html;
  });
  const bands = (spec.bands ?? []).map((b) => ({ x: b.from, x2: b.to, fillColor: palette.band[b.kind], opacity: 1, borderColor: 'transparent' }));
  const options = {
    chart,
    series,
    colors,
    stroke: { width: spec.series.map((s) => (s.type === 'bar' ? 0 : s.width ?? 2)), curve: 'straight', dashArray: spec.series.map((s) => (s.dashed ? 5 : 0)) },
    fill: { type: 'solid', opacity: spec.series.map(fillOf) },
    markers: { size: spec.series.map((s) => (s.markers ? 4 : 0)), strokeColors: palette.surface, strokeWidth: 1.5 },
    dataLabels: { enabled: false },
    // a lone range bar per day reads as a light whisker, not a solid column
    plotOptions: { bar: { columnWidth: spec.series.some((s) => s.type === 'bar') ? '80%' : '40%', borderRadius: 0 } },
    grid: { borderColor: palette.hairline, strokeDashArray: 0, padding: { left: 8, right: 8 } },
    legend: { show: spec.series.length > 1, position: 'top', horizontalAlign: 'left', fontFamily: palette.fontFamily, labels: { colors: palette.text }, markers: { size: 8, strokeWidth: 1, customHTML: keys } },
    xaxis: time
      ? {
          type: 'datetime', min: axis?.min ?? spec.x?.min, max: axis?.max ?? spec.x?.max, tickAmount: axis?.tickAmount, tooltip: { enabled: false },
          axisBorder: { color: palette.hairline }, axisTicks: { color: palette.hairline },
          labels: { style: text, datetimeUTC: false, rotate: 0, hideOverlappingLabels: true, formatter: (v) => timeTick(Number(v), span) },
        }
      : {
          // short labels, one per bar: overlapping ones hide, none is cut with an ellipsis
          type: 'category', categories: cats, tooltip: { enabled: false }, axisBorder: { color: palette.hairline }, axisTicks: { color: palette.hairline },
          labels: { style: text, rotate: 0, rotateAlways: false, hideOverlappingLabels: true, trim: false },
          title: { text: spec.x?.title ?? '', style: { ...text, fontWeight: 400 } },
        },
    // one y axis only: a second unit gets its own strip, synced through `group`
    yaxis: {
      // a phone plot of about 200 px reads four steps; the desktop keeps ApexCharts' own count
      ...yExtent(spec), forceNiceScale: true, ...(mobile && { tickAmount: 4 }),
      title: { text: spec.unit, style: { ...text, fontWeight: 400 } },
      labels: { style: text, minWidth: 48, maxWidth: 48, formatter: (v) => (v == null ? '' : nfAxis(spec.y?.decimals ?? 1).format(v)) },
    },
    tooltip: {
      shared: true,
      intersect: false,
      custom: ({ dataPointIndex }) => tooltipHtml(spec, dataPointIndex, hidden, palette),
    },
    annotations: {
      xaxis: bands,
      yaxis: (spec.refLines ?? []).map((r) => ({
        y: r.y, borderColor: palette[r.entity] ?? palette.muted, strokeDashArray: 4,
        label: { text: r.label, position: 'left', textAnchor: 'start', borderWidth: 0, style: { color: palette.ink, background: palette.surface, fontFamily: palette.fontFamily } },
      })),
    },
  };
  if (spec.group) options.chart.group = spec.group;
  return options;
}
