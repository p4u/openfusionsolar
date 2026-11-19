// Chart factory over the global ApexCharts: a <figure> with caption, table and CSV, and a themed chart.
// Spec: { id, kind: 'time'|'category', height: number|'strip', unit, x: { min, max, categories, label(i) },
// y: { min, max, decimals }, stacked, series: [{ key, name, type: 'line'|'area'|'bar'|'rangeBar'|'rangeArea', entity,
// dashed, width, data, hidden }], coverage, provisional, bands: [{ from, to, kind }], refLines, group, onZoom }.
// Data layout is described in chart-data.js. Range types take ([min, max] | null) values.
import { register, t } from './i18n.js';
import dict from './i18n/charts.js';
import { nf } from './format.js';
import { esc, icon } from './ui.js';
import { apexOptions, toCsv } from './chart-data.js';

register(dict);

const ENTITY_VAR = {
  sun: '--chart-sun', home: '--chart-home', grid: '--chart-grid', battery: '--chart-battery', p1: '--chart-p1', p2: '--chart-p2',
  p3: '--chart-p3', ok: '--status-ok', warn: '--status-warn', alarm: '--status-alarm', muted: '--muted',
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const entityColor = (entity) => css(ENTITY_VAR[entity] ?? '--muted');

export function readPalette() {
  const p = { text: css('--muted'), ink: css('--ink'), hairline: css('--hairline'), surface: css('--surface-card'), fontFamily: css('--font-sans') };
  for (const e of Object.keys(ENTITY_VAR)) p[e] = entityColor(e);
  p.band = { gap: css('--band-gap'), cut: css('--band-cut'), stopped: css('--band-stopped') };
  return p;
}

const storeKey = (id) => `chart:${id}`;
function loadHidden(id) {
  try {
    return new Set(JSON.parse(localStorage.getItem(storeKey(id)) ?? 'null') ?? []);
  } catch {
    return null;
  }
}
function saveHidden(id, set) {
  try {
    localStorage.setItem(storeKey(id), JSON.stringify([...set]));
  } catch { /* storage blocked: the choice holds until reload */ }
}

export function figure(parent, { title, caption = '', csvName = 'data' } = {}) {
  const el = document.createElement('figure');
  el.className = 'chart-figure';
  el.innerHTML = `<figcaption class="chart-head"><span class="chart-title">${esc(title)}</span><span class="chart-caption hint"></span></figcaption>
    <div class="chart-host"></div>
    <div class="chart-extra" hidden>
      <details class="disclosure chart-table"><summary>${icon('table', { size: 16 })}<span>${esc(t('charts.viewTable'))}</span>${icon('chevron-down', { size: 16 })}</summary>
        <div class="table-scroll"></div></details>
      <button type="button" class="pill pill-outline chart-csv">${icon('download', { size: 16 })}${esc(t('charts.downloadCsv'))}</button>
    </div>`;
  parent.append(el);
  const q = (s) => el.querySelector(s);
  let data = null;
  const onCsv = () => {
    const blob = new Blob(['\ufeff', toCsv(data.columns, data.rows)], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${csvName}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  q('.chart-csv').addEventListener('click', onCsv);
  return {
    host: q('.chart-host'),
    setCaption: (text) => { q('.chart-caption').textContent = text ?? ''; },
    // columns: [{ label, unit, decimals }]; rows: arrays of numbers, strings or null
    setTable(columns, rows) {
      data = { columns, rows };
      const cols = columns.map((c) => (typeof c === 'string' ? { label: c } : c));
      const show = (v, c) => (v == null ? t('core.unknown') : typeof v === 'number' ? nf(c.decimals ?? 2).format(v) : String(v));
      q('.table-scroll').innerHTML = `<table class="table"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c.unit ? `${c.label} (${c.unit})` : c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<${i ? 'td' : 'th scope="row"'}${typeof v === 'number' ? ' class="num"' : ''}>${esc(show(v, cols[i]))}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table>`;
      q('.chart-extra').hidden = false;
    },
    destroy: () => el.remove(),
  };
}

const KEY_KINDS = ['gap', 'cut', 'stopped'];

export function chart(host, initial) {
  let spec = initial;
  let apex = null;
  let key = null;
  const mobile = () => matchMedia('(max-width: 639px)').matches;
  const hidden = loadHidden(spec.id) ?? new Set(spec.series.filter((s) => s.hidden).map((s) => s.key));
  const zoomOn = () => typeof spec.onZoom === 'function' && matchMedia('(pointer: fine)').matches;

  const build = () => {
    const o = apexOptions(spec, readPalette(), { mobile: mobile(), hidden, zoom: zoomOn() });
    o.chart.events = {
      mounted: (c) => spec.series.forEach((s) => hidden.has(s.key) && c.hideSeries(s.name)),
      // fires before Apex flips the series, so the saved state is the flipped one
      legendClick: (_c, i) => {
        const k = spec.series[i].key;
        if (!hidden.delete(k)) hidden.add(k);
        saveHidden(spec.id, hidden);
      },
      // the view decides what a zoom means (usually a custom range); the chart itself keeps its extent
      beforeZoom: (c, { xaxis }) => {
        spec.onZoom?.(xaxis.min, xaxis.max);
        return { xaxis: { min: c.w.globals.initialMinX ?? c.w.globals.minX, max: c.w.globals.initialMaxX ?? c.w.globals.maxX } };
      },
    };
    return o;
  };

  const drawKey = () => {
    key?.remove();
    key = null;
    const kinds = new Set((spec.bands ?? []).map((b) => b.kind).filter((k) => KEY_KINDS.includes(k)));
    const partial = (spec.coverage ?? []).some((c) => c != null && c < 0.9 && c > 0);
    if (!kinds.size && !partial) return;
    key = document.createElement('ul');
    key.className = 'chart-key';
    key.innerHTML = KEY_KINDS.filter((k) => kinds.has(k)).map((k) => `<li><span class="chart-swatch chart-swatch-${k}"></span>${esc(t(`charts.key.${k}`))}</li>`).join('')
      + (partial ? `<li><span class="chart-swatch chart-swatch-partial"></span>${esc(t('charts.key.partial'))}</li>` : '');
    host.after(key);
  };

  const restyle = () => apex?.updateOptions(build(), false, false);
  document.addEventListener('themechange', restyle);
  document.addEventListener('langchange', restyle);

  apex = new ApexCharts(host, build());
  apex.render();
  drawKey();

  return {
    update(next) {
      spec = next;
      apex.updateOptions(build(), false, false);
      drawKey();
    },
    destroy() {
      document.removeEventListener('themechange', restyle);
      document.removeEventListener('langchange', restyle);
      apex.destroy();
      key?.remove();
    },
  };
}
