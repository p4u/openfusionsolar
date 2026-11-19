// Pure helpers of the Settings view.
import { t } from '../i18n.js';

const LIMITS = { minutes: [5, 1440], soc: [1, 100], maxSeverity: [1, 4] };

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

// Server field paths ('rules.noData.params.minutes', 'recipients.2', 'quiet.from', 'lang') -> where the message goes.
// The path is the data-field of the input; an unknown path (or '') lands in the form-level list (area 'form').
export function fieldErrorsByInput(fields) {
  return Object.entries(fields ?? {}).map(([path, message]) => {
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
  if (head === 'recipients') cfg.recipients[Number(a)] = value;
  else if (head === 'quiet') cfg.quiet[a] = value;
  else if (head === 'lang') cfg.lang = value;
  else if (head === 'rules') {
    const rule = cfg.rules.find((r) => r.id === a);
    if (!rule) return;
    if (b === 'params') rule.params[c] = value;
    else rule[b] = value;
  }
}
