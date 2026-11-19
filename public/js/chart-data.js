// Pure chart helpers (no DOM, so they run under Node): ApexCharts options from a chart spec, CSV, bands, opacity.
// Data layout: kind 'time' series take [ms, y] pairs, kind 'category' series take y values aligned with
// x.categories; y is a number, null (a gap) or [min, max] for range types. All series of a chart share one x grid.
import { t } from './i18n.js';
import { nf, fmtDate, fmtTime } from './format.js';
import { esc } from './ui.js';

export const PARTIAL = 0.9; // coverage below this is drawn faded and flagged in the tooltip
const GAP_MIN_MS = 15 * 60e3;
export const HEIGHTS = { desktop: 340, mobile: 260, strip: 120 };

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
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// RFC 4180: CRLF lines, quotes doubled, header "Label (unit)", dot decimals, empty for null.
export function toCsv(columns, rows) {
  const head = columns.map((c) => (typeof c === 'string' ? c : c.unit ? `${c.label} (${c.unit})` : c.label));
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
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
    return Array.isArray(v) ? `${num(v[0])} – ${num(v[1])} ${esc(spec.unit)}` : v == null ? t('core.unknown') : `${num(v)} ${esc(spec.unit)}`;
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

// palette: { sun, home, grid, battery, p1..p3, ok, warn, alarm, muted, text, ink, hairline, surface, fontFamily, band: { gap, cut, stopped } }
// opts: { mobile, hidden (Set of series keys), zoom (true when drag-zoom is on) }
export function apexOptions(spec, palette, { mobile = false, hidden = new Set(), zoom = false } = {}) {
  const time = spec.kind !== 'category';
  const height = spec.height === 'strip' ? HEIGHTS.strip : spec.height ?? (mobile ? HEIGHTS.mobile : HEIGHTS.desktop);
  const span = time ? (spec.x?.max ?? 0) - (spec.x?.min ?? 0) : 0;
  const series = spec.series.map((s) => ({
    name: s.name,
    type: s.type,
    data: s.data.map((p, i) => (time ? { x: p[0], y: p[1] } : { x: spec.x.categories[i], y: p })),
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
  const text = { fontFamily: palette.fontFamily, colors: palette.text, fontSize: '12px' };
  const options = {
    chart: {
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
    },
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
          type: 'datetime', min: spec.x?.min, max: spec.x?.max, tooltip: { enabled: false },
          axisBorder: { color: palette.hairline }, axisTicks: { color: palette.hairline },
          labels: { style: text, datetimeUTC: false, formatter: (v) => (span <= 2 * 86400e3 ? fmtTime(Number(v)) : fmtDate(Number(v))) },
        }
      : { type: 'category', categories: spec.x?.categories ?? [], tooltip: { enabled: false }, axisBorder: { color: palette.hairline }, axisTicks: { color: palette.hairline }, labels: { style: text } },
    // one y axis only: a second unit gets its own strip, synced through `group`
    yaxis: {
      min: spec.y?.min, max: spec.y?.max, forceNiceScale: true,
      title: { text: spec.unit, style: { ...text, fontWeight: 400 } },
      labels: { style: text, minWidth: 48, maxWidth: 48, formatter: (v) => (v == null ? '' : nf(spec.y?.decimals ?? 1).format(v)) },
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
