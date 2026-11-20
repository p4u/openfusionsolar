// The pre-change assistant model: `git show 820c31d:public/js/views/assistant-model.js` with its import paths fixed (spec 5 rollback test).
// Assistant view model (pure, no DOM): safe text rendering, stored and streamed blocks, error and status texts.
import dict from '../../public/js/i18n/assistant.js';
import { LANGS } from '../../public/js/i18n.js';
import { esc } from '../../public/js/ui.js';

export const MAX_TEXT = 4000; // the server's limit (src/assistant.js)
export const MAX_ATTACHMENTS = 3; // upload groups per question (src/assistant.js)

// Codes the chat can answer with: stream `error` events, then the JSON errors before the stream (preflight F22),
// plus `offline` (no answer from the server) and `stopped` (the user pressed Stop).
export const ERROR_CODES = ['internal', 'budget', 'rate_limited', 'timeout', 'upstream', 'bad_response', 'too_many_rounds',
  'invalid', 'ai_disabled', 'offline', 'stopped'];

// Status lines while the server works; any other tool reads as "thinking".
export const STATUS_TOOLS = ['get_plant', 'get_energy', 'get_power', 'get_tariff', 'estimate_bill', 'list_invoices', 'get_invoice',
  'compare_invoice', 'get_billing_summary', 'get_incidents', 'show_chart', 'reading_bill', 'uploading', 'thinking'];

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

// A stored message ({ role, blocks }) or one streamed event wrapped as { role: 'assistant', blocks: [event] } ->
// { role, items }; items: { kind: 'question', text } | { kind: 'text', html } | { kind: 'chart', chart } |
// { kind: 'invoice', id, period, total, status }. Unknown blocks are dropped.
export function blocksToView(message) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const items = [];
  for (const b of message?.blocks ?? []) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      items.push(role === 'user' ? { kind: 'question', text: b.text } : { kind: 'text', html: renderSafe(b.text) });
    } else if (b?.type === 'chart' && b.chart && typeof b.chart.type === 'string') {
      items.push({ kind: 'chart', chart: b.chart });
    } else if (b?.type === 'invoice' && Number.isInteger(b.id) && b.id > 0) {
      items.push({ kind: 'invoice', id: b.id, period: b.period ?? {}, total: typeof b.total === 'number' ? b.total : null, status: b.status });
    }
  }
  return { role, items };
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
