// Pure helpers of the Settings view.
import { t, LANGS } from '../i18n.js';
import dict from '../i18n/settings.js';

const LIMITS = { minutes: [5, 1440], soc: [1, 100], maxSeverity: [1, 4], margin: [0, 50], overPct: [0, 100] };
export const MAX_RECIPIENTS = 20;

// The inputs inside a rule's sentence, one per param, in the order the sentence template uses them.
export const ruleSentenceParts = (rule) =>
  Object.keys(rule.params ?? {}).map((name) => (name === 'time'
    ? { name, type: 'time', path: `rules.${rule.id}.params.time` }
    : { name, type: 'number', min: LIMITS[name]?.[0], max: LIMITS[name]?.[1], path: `rules.${rule.id}.params.${name}` }));

// The rule's sentence in the current language with its {placeholders} kept (t() alone fills missing vars with '').
export const ruleTemplate = (rule) =>
  t(`settings.rule.${rule.id}`, Object.fromEntries(Object.keys(rule.params ?? {}).map((k) => [k, `{${k}}`])));

// "Tell me when no data arrives for {minutes} minutes" -> [{ text }, { input: 'minutes' }, { text }]
export function splitSentence(template) {
  return String(template).split(/\{(\w+)\}/).map((s, i) => (i % 2 ? { input: s } : { text: s })).filter((p) => p.input || p.text);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);

// Text typed or pasted into "Add": addresses split by commas, semicolons or spaces (<a@b.c> unwrapped).
// Returns { add, invalid, already, full }: what to add (at most up to `max` in total) and what was refused.
export function parseAddresses(text, existing = [], max = MAX_RECIPIENTS) {
  const out = { add: [], invalid: [], already: [], full: [] };
  const seen = new Set(existing.map((e) => e.toLowerCase()));
  for (const raw of String(text).split(/[\s,;]+/).filter(Boolean)) {
    const s = raw.replace(/^<(.*)>$/, '$1');
    if (!isEmail(s)) out.invalid.push(raw);
    else if (seen.has(s.toLowerCase())) out.already.push(s);
    else if (existing.length + out.add.length >= max) out.full.push(s);
    else {
      seen.add(s.toLowerCase());
      out.add.push(s);
    }
  }
  return out;
}

// The server's own checks (alerts.js validateConfig), run before saving so a wrong value never leaves the page.
// Returns { path: message } in the server's words (errorText translates them); empty when everything is valid.
export function validateAlerts(cfg) {
  const fields = {};
  const int = (path, v, [min, max]) => {
    if (!(Number.isInteger(v) && v >= min && v <= max)) fields[path] = `integer from ${min} to ${max}`;
  };
  const time = (path, v) => {
    if (!(typeof v === 'string' && HHMM.test(v))) fields[path] = 'HH:MM';
  };
  if ((cfg.recipients ?? []).length > MAX_RECIPIENTS) fields.recipients = `up to ${MAX_RECIPIENTS} email addresses`;
  const seen = new Set();
  (cfg.recipients ?? []).forEach((r, i) => {
    const email = typeof r === 'string' ? r : r?.email;
    if (!isEmail(email)) fields[`recipients.${i}`] = 'invalid email address';
    else if (seen.has(email.toLowerCase())) fields[`recipients.${i}`] = 'duplicate email address';
    seen.add(String(email).toLowerCase());
    if (typeof r === 'object' && r?.lang != null && !['ca', 'en'].includes(r.lang)) fields[`recipients.${i}.lang`] = 'ca or en';
  });
  for (const k of ['from', 'to']) time(`quiet.${k}`, cfg.quiet?.[k]);
  for (const rule of cfg.rules ?? []) {
    for (const [name, v] of Object.entries(rule.params ?? {})) {
      const path = `rules.${rule.id}.params.${name}`;
      if (name === 'time') time(path, v);
      else if (LIMITS[name]) int(path, v, LIMITS[name]);
    }
    if (rule.repeatHours !== undefined) int(`rules.${rule.id}.repeatHours`, rule.repeatHours, [0, 720]);
  }
  return fields;
}

// Server field paths ('rules.noData.params.minutes', 'recipients.2', 'quiet.from', 'lang') -> where the message goes.
// The path is the data-field of the input; an unknown path (or '') lands in the form-level list (area 'form').
// The server explains a rejected field in English (alerts.js validateConfig); show it in the app language.
export function errorText(message) {
  const m = /^integer from (\d+) to (\d+)$/.exec(message ?? '');
  if (m) return t('settings.err.range', { min: m[1], max: m[2] });
  const key = {
    'invalid email address': 'email', 'duplicate email address': 'duplicate', [`up to ${MAX_RECIPIENTS} email addresses`]: 'recipients', 'HH:MM': 'time',
  }[message];
  return t(`settings.err.${key ?? 'invalid'}`);
}

export function fieldErrorsByInput(fields) {
  return Object.entries(fields ?? {}).map(([path, raw]) => {
    const message = errorText(raw);
    const [head, a, b, c] = path.split('.');
    const area = head === 'recipients' && a != null ? 'recipient' : head === 'quiet' ? 'quiet' : head === 'lang' ? 'lang'
      : head === 'rules' && a && b ? 'rule' : 'form';
    return { path, message, area, ...(area === 'rule' && { rule: a, input: c ?? b }), ...(area === 'recipient' && { index: Number(a) }) };
  });
}

// Latest time each rule fired (or sent a report), from history rows (newest first).
export function lastFired(rows) {
  const out = {};
  for (const r of rows) if ((r.event === 'fired' || r.event === 'report') && out[r.rule] == null) out[r.rule] = r.ts;
  return out;
}

// i18n key for the delivery state of a history row, plus the extra text to append (SMTP error or raw reason).
export function deliveryWords(row) {
  if (row.delivery === 'skipped') return { key: `settings.delivery.skipped.${row.reason ?? 'unknown'}`, fallback: 'settings.delivery.skipped.unknown' };
  return { key: `settings.delivery.${row.delivery}`, fallback: 'settings.delivery.unknown', detail: row.delivery === 'failed' ? row.error : null };
}

// Writes one form value into a config by field path (the paths validateConfig reports). Unknown paths are ignored.
export function setField(cfg, path, value) {
  const [head, a, b, c] = path.split('.');
  if (head === 'recipients') {
    const r = cfg.recipients[Number(a)];
    if (r && typeof r === 'object') r[b ?? 'email'] = value;
    else cfg.recipients[Number(a)] = value;
  }
  else if (head === 'quiet') cfg.quiet[a] = value;
  else if (head === 'lang') cfg.lang = value;
  else if (head === 'rules') {
    const rule = cfg.rules.find((r) => r.id === a);
    if (!rule) return;
    if (b === 'params') rule.params[c] = value;
    else rule[b] = value;
  }
}

// FusionSolar access as Settings shows it: paused after a failure, unknown before the first check, else working.
export const authKey = (c, now = Date.now()) => (c.authBlockedUntil > now ? 'settings.collector.authPaused'
  : c.lastTick == null ? 'settings.collector.authUnknown' : 'settings.collector.authOk');

// Dollars as the assistant budget reads, with the currency code so nobody takes them for euros: "0,42 USD" (ca),
// "0.42 USD" (en); a whole budget has no decimals.
export function usd(v, lang, { whole = false } = {}) {
  const loc = LANGS[lang]?.locale ?? 'en-GB';
  const n = Number(v) || 0;
  const tiny = n > 0 && n < 0.01; // a few questions cost less than a cent
  const digits = whole && Number.isInteger(n) ? 0 : 2;
  const text = new Intl.NumberFormat(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(tiny ? 0.01 : n);
  return `${tiny ? '<\u00a0' : ''}${text}\u00a0USD`;
}

// "Cost de l\u2019IA aquest mes: 0,42 USD de 5 USD de l\u00edmit" from GET /api/assistant/usage.
export const usageText = ({ spentUsd, budgetUsd }, lang) =>
  String(dict[lang]?.['settings.ai.usage'] ?? dict.en['settings.ai.usage'])
    .replace('{spent}', usd(spentUsd, lang)).replace('{budget}', usd(budgetUsd, lang, { whole: true }));

// The web search line from /api/status `web` (spec 3.3): available, or why not. lastError is the code of the last Jina
// call (src/web.js); a key error makes web search unavailable, any other failure leaves it available.
export function webKey(web) {
  const e = web?.lastError;
  if (web?.available) return e === 'error' ? 'settings.ai.web.error' : 'settings.ai.web.on';
  return { no_balance: 'settings.ai.web.noBalance', bad_key: 'settings.ai.web.badKey' }[e] ?? 'settings.ai.web.noKey';
}
