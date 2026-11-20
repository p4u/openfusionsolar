// Assistant view model (pure, no DOM): safe text rendering, stored and streamed blocks, error and status texts,
// and the chart model of a server-resolved figure.
import dict from '../i18n/assistant.js';
import { LANGS, register, t } from '../i18n.js';
import { esc } from '../ui.js';
import { bucketAxis } from '../chart-data.js';
import { MAX_BUCKETS } from '../buckets.js';
import { fmtDate, fmtDateTime, fmtMonth, isoLocal } from '../format.js';

register(dict);

export const MAX_TEXT = 4000; // the server's limit (src/assistant.js)
export const MAX_ATTACHMENTS = 3; // upload groups per question (src/assistant.js)

// Codes the chat can answer with: stream `error` events, then the JSON errors before the stream (preflight F22),
// plus `offline` (no answer from the server) and `stopped` (the user pressed Stop).
export const ERROR_CODES = ['internal', 'budget', 'rate_limited', 'busy', 'timeout', 'upstream', 'bad_response', 'too_many_rounds',
  'invalid', 'ai_disabled', 'offline', 'stopped'];

// Status lines while the server works; any other tool reads as "thinking".
export const STATUS_TOOLS = ['get_plant', 'get_energy', 'get_power', 'get_tariff', 'estimate_bill', 'list_invoices', 'get_invoice',
  'compare_invoice', 'get_billing_summary', 'get_incidents', 'show_chart', 'query_data', 'draw_chart', 'read_guide', 'web_search',
  'read_web_page', 'calculate', 'ask_user', 'checking', 'reading_bill', 'uploading', 'thinking'];

// The figure block's closed sets (src/datasets.js KINDS and its x types; a server test compares them, preflight F15).
export const FIGURE_KINDS = ['line', 'bar', 'stacked_bar', 'area', 'scatter', 'donut', 'heatmap'];
export const X_TYPES = ['time', 'day', 'month', 'year', 'bill', 'hour_of_day', 'weekday', 'month_of_year'];
const MAX_SERIES = 8;
const SOURCES = ['measured', 'estimate', 'bills', 'ree'];
const MAX_OPTION = 60;

const say = (lang, key, vars = {}) =>
  String(dict[lang]?.[key] ?? dict.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// The model's text as HTML: everything escaped first, then only paragraphs, **bold** and -/1. lists (a "#" heading
// reads as a bold paragraph). Links, images and HTML stay visible as text.
export function renderSafe(text) {
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const item = /^(?:([-*])|\d{1,3}[.)])\s+(.+)$/.exec(line);
    const head = /^#{1,6}\s+(.+)$/.exec(line);
    if (!line) {
      flushPara();
      flushList();
    } else if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      flushPara();
      if (list?.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(item[2]);
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line}`; // an indented line continues the item
    } else if (head) {
      flushPara();
      flushList();
      out.push(`<p><strong>${esc(head[1].replace(/\*\*/g, ''))}</strong></p>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

const int = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const key = (re) => (v) => (typeof v === 'string' || typeof v === 'number') && re.test(String(v));
const X_VALUE = {
  time: Number.isFinite, day: key(/^\d{4}-\d{2}-\d{2}$/), month: key(/^\d{4}-\d{2}$/), year: key(/^\d{4}$/), bill: key(/^\d{4}-\d{2}(?: \(\d{1,2}\))?$/),
  hour_of_day: int(0, 23), weekday: int(1, 7), month_of_year: int(1, 12),
};

// A figure block the browser can draw, or null: every field the model could have shaped is checked, so a malformed
// block is dropped rather than half drawn.
function figureOf(b) {
  const n = Array.isArray(b.x?.values) ? b.x.values.length : 0;
  const ok = FIGURE_KINDS.includes(b.kind) && typeof b.title === 'string' && X_TYPES.includes(b.x?.type)
    && n > 0 && n <= MAX_BUCKETS && b.x.values.every(X_VALUE[b.x.type])
    && Array.isArray(b.series) && b.series.length > 0 && b.series.length <= MAX_SERIES
    && b.series.every((s) => typeof s?.label === 'string' && Array.isArray(s.values) && s.values.length === n
      && s.values.every((v) => v === null || Number.isFinite(v)));
  if (!ok) return null;
  return {
    kind: b.kind, title: b.title, x: { type: b.x.type, values: b.x.values },
    series: b.series.map((s) => ({ label: s.label, values: s.values })),
    unit: typeof b.unit === 'string' ? b.unit : '',
    source: Array.isArray(b.source) ? b.source.filter((s) => SOURCES.includes(s)) : [],
    notes: typeof b.notes === 'string' ? b.notes : '',
  };
}

const choiceOf = (b) => (Array.isArray(b.options) && b.options.length >= 2 && b.options.length <= 4
  && b.options.every((o) => typeof o === 'string' && o.trim() && o.length <= MAX_OPTION) ? b.options.map((o) => o.trim()) : null);

// Only https links; the host shown is recomputed here, never taken from the block.
function sourcesOf(b) {
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    let u;
    try {
      u = new URL(typeof it?.url === 'string' ? it.url : '');
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    const title = typeof it.title === 'string' && it.title.trim() ? it.title.trim().slice(0, 200) : u.host;
    items.push({ title, url: u.href, host: u.host });
  }
  return items.length ? items : null;
}

// A stored message ({ role, blocks }) or one streamed event wrapped as { role: 'assistant', blocks: [event] } ->
// { role, items }; items: { kind: 'question', text } | { kind: 'text', html } | { kind: 'chart', chart } |
// { kind: 'invoice', id, period, total, status } | { kind: 'figure', figure } | { kind: 'choice', options } |
// { kind: 'sources', items: [{ title, url, host }] }. Unknown and malformed blocks are dropped.
export function blocksToView(message) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const items = [];
  for (const b of message?.blocks ?? []) {
    let v;
    if (b?.type === 'text' && typeof b.text === 'string') {
      items.push(role === 'user' ? { kind: 'question', text: b.text } : { kind: 'text', html: renderSafe(b.text) });
    } else if (b?.type === 'chart' && b.chart && typeof b.chart.type === 'string') {
      items.push({ kind: 'chart', chart: b.chart });
    } else if (b?.type === 'invoice' && Number.isInteger(b.id) && b.id > 0) {
      items.push({ kind: 'invoice', id: b.id, period: b.period ?? {}, total: typeof b.total === 'number' ? b.total : null, status: b.status });
    } else if (b?.type === 'figure' && (v = figureOf(b))) {
      items.push({ kind: 'figure', figure: v });
    } else if (b?.type === 'choice' && (v = choiceOf(b))) {
      items.push({ kind: 'choice', options: v });
    } else if (b?.type === 'sources' && (v = sourcesOf(b))) {
      items.push({ kind: 'sources', items: v });
    }
  }
  return { role, items };
}

// Positions (indexes in messages) of the messages holding a choice that a later user message answered: their
// options render disabled when a conversation is reloaded.
export function answered(messages) {
  const out = new Set();
  let later = false;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') later = true;
    else if (later && messages[i]?.blocks?.some((b) => b?.type === 'choice')) out.add(i);
  }
  return out;
}

// ---------- figure -> chart model (drawModel of chart-presets.js) ----------

// Series take the entity colours in this order (tokens.css), so a figure reads like the app's own charts.
const ENTITIES = ['sun', 'home', 'grid', 'battery', 'sold', 'discharge', 'fixed', 'ac'];
const TYPE = { line: 'line', bar: 'bar', stacked_bar: 'bar', area: 'area', scatter: 'line' };
const DECIMALS = { '€': 2, kWh: 1, kW: 2, '%': 1, '€/kWh': 3 };
const pad2 = (v) => String(v).padStart(2, '0');
const cap = (s) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const weekdayName = (v, weekday) => fmtDate(`2024-01-0${v}`, { weekday }); // 1 January 2024 was a Monday
const monthName = (v, month) => fmtDate(`2026-${pad2(v)}-15`, { month });
const BUCKET = { day: '1d', month: '1mo', year: '1y' };

// x of a figure: short axis categories (category axes), the full label of each row, and its machine-readable key.
function xAxis({ type, values }) {
  const keys = values.map(String);
  if (type === 'time') return { labels: values.map(fmtDateTime), iso: values.map((ms) => isoLocal(ms, '1h')) };
  if (type === 'bill') {
    const months = keys.map((k) => k.slice(0, 7));
    const nth = keys.map((k) => k.slice(7)); // '' or ' (2)': another bill of the same month
    const ax = bucketAxis(months, '1mo');
    return { categories: ax.categories.map((c, i) => c + nth[i]), title: ax.title, labels: months.map((m, i) => fmtMonth(m) + nth[i]), iso: keys };
  }
  if (BUCKET[type]) {
    const label = type === 'day' ? (k) => fmtDate(k, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : type === 'year' ? (k) => k : (k) => fmtMonth(k);
    return { ...bucketAxis(keys, BUCKET[type]), labels: keys.map(label), iso: keys };
  }
  if (type === 'hour_of_day') {
    const categories = values.map((v) => `${pad2(v)} h`);
    return { categories, title: '', labels: categories, iso: values.map(pad2) };
  }
  const [short, long] = type === 'weekday' ? [(v) => weekdayName(v, 'short'), (v) => cap(weekdayName(v, 'long'))]
    : [(v) => monthName(v, 'short'), (v) => cap(monthName(v, 'long'))];
  return { categories: values.map(short), title: '', labels: values.map(long), iso: keys };
}

const slug = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// A figure item (blocksToView) -> { id, title, caption, columns, rows, iso, spec } for drawModel. Pure: the same
// spec shape as the presets, so palette, tooltip, table and CSV are the app's own.
export function figureModel(fig) {
  const { kind, x, unit } = fig;
  const decimals = DECIMALS[unit] ?? 2;
  // a label that already ends with its unit ("Estalvi diari (€)") would read "(€) (€)" in the table header
  const bare = (l) => l.replace(/\s*[([]([^()[\]]*)[)\]]$/, (m, u) => (unit && u.trim() === unit ? '' : m)) || l;
  const ax = xAxis(x);
  const id = `figure-${slug(fig.title) || kind}`;
  // a heatmap is read by shade, so all its rows take one hue
  const series = fig.series.map((s, i) => ({ key: `s${i}`, name: bare(s.label), entity: ENTITIES[kind === 'heatmap' ? 0 : i], values: s.values }));
  const label = (i) => ax.labels[i];
  let spec;
  if (kind === 'donut') {
    const total = (vs) => vs.reduce((a, v) => a + (v ?? 0), 0);
    spec = { kind: 'donut', series: series.map(({ values, ...s }) => ({ ...s, data: [total(values)] })) };
  } else if (kind === 'heatmap') {
    spec = { kind: 'heatmap', x: { categories: ax.categories ?? ax.labels, title: ax.title ?? '', label }, series: series.map(({ values, ...s }) => ({ ...s, data: values })) };
  } else {
    const extra = kind === 'scatter' ? { width: 0, markers: true } : {};
    const time = x.type === 'time';
    const step = x.values.length > 1 ? x.values[1] - x.values[0] : 3600e3;
    spec = {
      kind: time ? 'time' : 'category', stacked: kind === 'stacked_bar',
      x: time ? { min: x.values[0], max: x.values.at(-1) + step, label } : { categories: ax.categories, title: ax.title, label },
      series: series.map(({ values, ...s }) => ({ ...s, type: TYPE[kind], ...extra, data: time ? values.map((v, i) => [x.values[i], v]) : values })),
    };
  }
  return {
    id, title: fig.title,
    caption: [...fig.source.map((s) => t(`assistant.figure.source.${s}`)), fig.notes].filter(Boolean).join(' '),
    columns: [t(`assistant.figure.x.${x.type}`), ...fig.series.map((s) => ({ label: bare(s.label), unit, decimals }))],
    rows: ax.labels.map((l, i) => [l, ...fig.series.map((s) => s.values[i])]),
    iso: ax.iso,
    spec: { id, unit, y: { decimals }, ...spec },
  };
}

// "30 s" / "3 min" for a retry-after in seconds.
const wait = (seconds, lang) => {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0));
  const n = s < 60 ? s : Math.ceil(s / 60);
  return `${new Intl.NumberFormat(LANGS[lang]?.locale ?? 'en').format(n)}\u00a0${s < 60 ? 's' : 'min'}`;
};

// The words for an error code; rate_limited with a wait says how long. Unknown codes read as `internal`.
export function ndjsonError(code, lang, { retryAfter } = {}) {
  const c = ERROR_CODES.includes(code) ? code : 'internal';
  if (c === 'rate_limited' && retryAfter > 0) return say(lang, 'assistant.err.rate_limited_wait', { wait: wait(retryAfter, lang) });
  return say(lang, `assistant.err.${c}`);
}

export const statusKey = (tool) => `assistant.status.${STATUS_TOOLS.includes(tool) ? tool : 'thinking'}`;

// #/assistant?q=...&invoice=ID: the question to prefill (not sent) and the bill it is about.
export function prefill(params) {
  const text = String(params?.get('q') ?? '').trim().slice(0, MAX_TEXT);
  const raw = params?.get('invoice');
  const invoiceId = /^[1-9]\d{0,15}$/.test(raw ?? '') ? Number(raw) : null;
  return { text, invoiceId };
}
