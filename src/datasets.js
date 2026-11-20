// Datasets of one assistant turn: the rows query_data built stay here, the model gets a summary, and
// draw_chart resolves series (plain or derived) into a `figure` block the browser draws without fetching. Pure: the
// caller builds the rows (src/query-data.js) and owns the per-turn registry.
//
// A dataset: { id, args, source: ['measured'|'estimate'|'bills'|'ree'], x: { type, values }, columns: [{ name, unit,
// values, hidden? }] }. x.type: 'time' (epoch ms, 5m/15m/1h), 'day' (YYYY-MM-DD), 'month' (YYYY-MM), 'year' (YYYY),
// 'bill' (one row per bill, its month), 'hour_of_day' (0-23), 'weekday' (1 Monday - 7 Sunday), 'month_of_year' (1-12).
// Hidden columns are the parts a ratio is recomputed from; the model never sees them.

export const MAX_ROWS = 750; // MAX_BUCKETS in public/js/buckets.js
export const MAX_COLUMNS = 8;
export const FULL_ROWS = 60;
export const MAX_SERIES = 8;
export const KINDS = ['line', 'bar', 'stacked_bar', 'area', 'scatter', 'donut', 'heatmap'];
export const OPS = ['ratio', 'difference', 'sum', 'cumulative', 'share_pct'];
export const AGGS = ['sum', 'avg', 'max', 'min'];
// which x a grouping reads (hour_of_day needs hourly data: the caller only builds 'time' x at 1h for it)
export const GROUPS = { hour_of_day: ['time'], weekday: ['day'], month_of_year: ['day', 'month'] };
const SUMMABLE = new Set(['kWh', '€']);
const LIMITS = { title: 80, label: 40, notes: 200 };

// Ratios are recomputed from summed parts (never averaged); null when a part is missing or the divisor is 0.
export const RATIOS = {
  self_sufficiency_pct: { uses: ['load_kwh', 'import_kwh'], f: (r) => (r.load_kwh ? (100 * (r.load_kwh - r.import_kwh)) / r.load_kwh : null) },
  self_consumption_pct: { uses: ['self_use_kwh', 'pv_kwh'], f: (r) => (r.pv_kwh ? (100 * r.self_use_kwh) / r.pv_kwh : null) },
};

export class DataError extends Error {}
const fail = (m) => { throw new DataError(m); };

const pad = (n) => String(n).padStart(2, '0');
// x as the model and the table read it; time is local (the server runs in the plant's time zone)
export function xLabel(type, v) {
  if (type !== 'time') return String(v);
  const d = new Date(v);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const visible = (ds) => ds.columns.filter((c) => !c.hidden);
const column = (ds, name) => visible(ds).find((c) => c.name === name) ?? fail(`dataset ${ds.id} has no column ${name}; columns: ${visible(ds).map((c) => c.name).join(', ')}`);

// One registry per turn: ids d1, d2, ... restart at each turn.
export function createDatasets() {
  const map = new Map();
  return {
    add(ds) {
      if (ds.x.values.length > MAX_ROWS) fail(`too many rows: at most ${MAX_ROWS}, use a coarser bucket or a shorter range`);
      if (visible(ds).length > MAX_COLUMNS) fail(`too many columns: at most ${MAX_COLUMNS}`);
      const id = `d${map.size + 1}`;
      map.set(id, { ...ds, id });
      return map.get(id);
    },
    get: (id) => map.get(id) ?? null,
  };
}

// Fills every ratio column of a dataset from its parts, row by row.
export function withRatios(ds) {
  const byName = Object.fromEntries(ds.columns.map((c) => [c.name, c]));
  const columns = ds.columns.map((c) => {
    const r = RATIOS[c.name];
    if (!r) return c;
    const values = ds.x.values.map((_, i) => {
      const row = Object.fromEntries(r.uses.map((u) => [u, byName[u]?.values[i] ?? null]));
      return r.uses.some((u) => !isNum(row[u])) ? null : r.f(row);
    });
    return { ...c, values };
  });
  return { ...ds, columns };
}

const weekday = (day) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))).getUTCDay() || 7;
const GROUP_KEY = {
  hour_of_day: (v) => new Date(v).getHours(),
  weekday: (v) => weekday(v),
  month_of_year: (v) => Number(String(v).slice(5, 7)),
};
const AGG = {
  sum: (vs) => vs.reduce((a, b) => a + b, 0),
  avg: (vs) => vs.reduce((a, b) => a + b, 0) / vs.length,
  max: (vs) => Math.max(...vs),
  min: (vs) => Math.min(...vs),
};

// group_by over local time: one row per key present, in key order; nulls skipped (avg divides by the values present);
// ratio columns recomputed from the grouped sums of their parts.
export function groupDataset(ds, by, agg) {
  if (!Object.hasOwn(GROUPS, by)) fail(`group_by must be one of ${Object.keys(GROUPS).join(', ')}`);
  if (!AGGS.includes(agg)) fail(`agg must be one of ${AGGS.join(', ')}`);
  if (!GROUPS[by].includes(ds.x.type)) fail(by === 'hour_of_day' ? 'hour_of_day needs bucket 1h' : `${by} needs daily${by === 'month_of_year' ? ' or monthly' : ''} data`);
  const keyOf = ds.x.values.map(GROUP_KEY[by]);
  const keys = [...new Set(keyOf)].sort((a, b) => a - b);
  const pick = (c, k) => c.values.filter((v, i) => keyOf[i] === k && isNum(v));
  const sums = Object.fromEntries(ds.columns.map((c) => [c.name, keys.map((k) => {
    const vs = pick(c, k);
    return vs.length ? AGG.sum(vs) : null;
  })]));
  const columns = ds.columns.map((c) => {
    const r = RATIOS[c.name];
    const values = keys.map((k, j) => {
      if (r) {
        const row = Object.fromEntries(r.uses.map((u) => [u, sums[u]?.[j] ?? null]));
        return r.uses.some((u) => !isNum(row[u])) ? null : r.f(row);
      }
      const vs = pick(c, k);
      return vs.length ? AGG[c.hidden ? 'sum' : agg](vs) : null;
    });
    return { ...c, values };
  });
  return { ...ds, x: { type: by, values: keys }, columns };
}

function stats(xs, values) {
  let min = null, minAt = null, max = null, maxAt = null, sum = 0, n = 0;
  values.forEach((v, i) => {
    if (!isNum(v)) return;
    n++;
    sum += v;
    if (min === null || v < min) [min, minAt] = [v, xs[i]];
    if (max === null || v > max) [max, maxAt] = [v, xs[i]];
  });
  return { min, minAt, max, maxAt, sum: n ? sum : null, mean: n ? sum / n : null, nonNull: n };
}

// What the model gets back from query_data: never more than 60 rows.
export function summarize(ds) {
  const cols = visible(ds);
  const xs = ds.x.values.map((v) => xLabel(ds.x.type, v));
  const rows = xs.map((x, i) => [x, ...cols.map((c) => c.values[i] ?? null)]);
  return {
    id: ds.id, columns: ['x', ...cols.map((c) => c.name)], units: Object.fromEntries(cols.map((c) => [c.name, c.unit])),
    x: ds.x.type, rowCount: rows.length, head: rows.slice(0, 3), tail: rows.length > 3 ? rows.slice(-3) : [],
    stats: Object.fromEntries(cols.map((c) => [c.name, stats(xs, c.values)])),
    ...(rows.length <= FULL_ROWS && { rows }),
  };
}

const plain = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
function text(v, name, required) {
  if (v == null && !required) return null;
  if (typeof v !== 'string' || !plain(v)) fail(`${name} must be a non-empty string`);
  const s = plain(v);
  if (s.length > LIMITS[name]) fail(`${name} is too long: at most ${LIMITS[name]} characters`);
  return s;
}

// One series spec -> { label, unit, values } over the dataset's rows.
function seriesOf(ds, s) {
  if (!s || typeof s !== 'object') fail('each series must be an object');
  const label = text(s.label, 'label', true);
  if (s.op == null) {
    if (typeof s.column !== 'string') fail('a series needs column, or op with columns');
    const c = column(ds, s.column);
    return { label, unit: c.unit, values: c.values };
  }
  if (!OPS.includes(s.op)) fail(`op must be one of ${OPS.join(', ')}`);
  const want = s.op === 'cumulative' ? 1 : 2;
  if (!Array.isArray(s.columns) || s.columns.length !== want) fail(`${s.op} takes ${want === 1 ? 'one column' : 'two columns'} in columns`);
  const [a, b] = s.columns.map((n) => column(ds, n));
  if (s.op === 'cumulative') {
    let run = 0;
    return { label, unit: a.unit, values: a.values.map((v) => (isNum(v) ? (run += v) : null)) };
  }
  const both = (f) => a.values.map((v, i) => (isNum(v) && isNum(b.values[i]) ? f(v, b.values[i]) : null));
  if (s.op === 'difference' || s.op === 'sum') {
    if (a.unit !== b.unit) fail(`${s.op} needs two columns with the same unit (${a.unit}, ${b.unit})`);
    return { label, unit: a.unit, values: both(s.op === 'sum' ? (x, y) => x + y : (x, y) => x - y) };
  }
  if (s.op === 'ratio') return { label, unit: a.unit === b.unit ? '' : `${a.unit}/${b.unit}`, values: both((x, y) => (y === 0 ? null : x / y)) };
  return { label, unit: '%', values: both((x, y) => (y === 0 ? null : (100 * x) / y)) }; // share_pct: a as a percent of b
}

const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 + 0 : null);

// draw_chart: args { kind, title, series: [{ dataset, column, label } | { dataset, op, columns, label }], notes? }.
// checkText(s) returns the figures of s that are not grounded. Returns { block, result }.
export function resolveFigure(args, datasets, { checkText = () => [] } = {}) {
  const a = args && typeof args === 'object' ? args : fail('arguments must be an object');
  for (const k of Object.keys(a)) if (!['kind', 'title', 'series', 'notes'].includes(k)) fail(`unknown argument ${k}`);
  if (!KINDS.includes(a.kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
  const title = text(a.title, 'title', true);
  const notes = text(a.notes, 'notes', false);
  if (!Array.isArray(a.series) || !a.series.length || a.series.length > MAX_SERIES) fail(`series must hold 1 to ${MAX_SERIES} entries`);
  const ids = new Set(a.series.map((s) => s?.dataset));
  if (ids.size !== 1) fail('all series of one chart come from one dataset');
  const [id] = ids;
  const ds = datasets.get(id) ?? fail(`unknown dataset ${id}: call query_data first`);
  const series = a.series.map((s) => seriesOf(ds, s));
  const units = [...new Set(series.map((s) => s.unit))];
  if (units.length > 1) fail(`the series have different units (${units.join(', ')}): draw one chart per unit`);
  const [unit] = units;
  if (a.kind === 'donut') {
    if (series.length < 2) fail('a donut needs at least two series (one slice each)');
    if (!SUMMABLE.has(unit)) fail(`a donut adds each series up, so it needs kWh or € (not ${unit || 'a ratio'})`);
  }
  for (const [name, s] of [['title', title], ['notes', notes], ...series.map((s) => ['label', s.label])]) {
    const bad = s ? checkText(s) : [];
    if (bad.length) fail(`the ${name} has figures that are not in this turn's data: ${bad.join('; ')}`);
  }
  const out = series.map((s) => ({ label: s.label, values: s.values.map(r3) }));
  const block = { type: 'figure', kind: a.kind, title, x: { type: ds.x.type, values: ds.x.values }, series: out, unit, source: ds.source, notes, query: ds.args };
  const result = {
    shown: true,
    series: out.map((s) => {
      const st = stats(ds.x.values, s.values);
      return { label: s.label, min: st.min, max: st.max, sum: st.sum, last: [...s.values].reverse().find(isNum) ?? null };
    }),
  };
  return { block, result };
}
