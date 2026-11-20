// Bills view model (pure, no DOM): field groups, parsing, queue states, plain-words text, missing months.
import dict from '../i18n/invoices.js';
import { LANGS } from '../i18n.js';

// Texts here take the language as a parameter (the tests check both), so they read the dictionary directly.
export const say = (lang, key, vars = {}) =>
  String(dict[lang]?.[key] ?? dict.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

const eurs = (lang, v) => new Intl.NumberFormat(LANGS[lang].locale, { style: 'currency', currency: 'EUR' }).format(v);

// type: text | date | int | num | kind | bool. The form shows the groups in this order; 'readings' has no fields (a table).
const f = (col, type = 'num', unit = null) => ({ col, type, unit });
export const fieldGroups = () => [
  { id: 'data', fields: [f('supplier', 'text'), f('invoice_number', 'text'), f('kind', 'kind'), f('rectifies_number', 'text'),
    f('issue_date', 'date'), f('period_from', 'date'), f('period_to', 'date'), f('days', 'int'), f('due_date', 'date'),
    f('tariff', 'text'), f('self_consumption', 'bool'), f('notes', 'text')] },
  { id: 'power', fields: [f('contracted_p1_kw', 'num', 'kW'), f('contracted_p2_kw', 'num', 'kW'), f('max_demand_p1_kw', 'num', 'kW'),
    f('max_demand_p2_kw', 'num', 'kW'), f('power_price_p1', 'num', 'eur/kW'), f('power_price_p2', 'num', 'eur/kW'), f('power_eur', 'num', 'eur')] },
  { id: 'energy', fields: [f('kwh_p1', 'num', 'kWh'), f('kwh_p2', 'num', 'kWh'), f('kwh_p3', 'num', 'kWh'),
    f('price_p1', 'num', 'eur/kWh'), f('price_p2', 'num', 'eur/kWh'), f('price_p3', 'num', 'eur/kWh'),
    f('energy_p1_eur', 'num', 'eur'), f('energy_p2_eur', 'num', 'eur'), f('energy_p3_eur', 'num', 'eur'),
    f('adjust_eur', 'num', 'eur'), f('energy_eur', 'num', 'eur')] },
  { id: 'surplus', fields: [f('surplus_p1_kwh', 'num', 'kWh'), f('surplus_p2_kwh', 'num', 'kWh'), f('surplus_p3_kwh', 'num', 'kWh'),
    f('surplus_price', 'num', 'eur/kWh'), f('surplus_eur', 'num', 'eur'), f('surplus_lost_eur', 'num', 'eur')] },
  { id: 'taxes', fields: [f('social_bonus_eur', 'num', 'eur'), f('meter_rent_eur', 'num', 'eur'), f('elec_tax_pct', 'num', '%'),
    f('elec_tax_eur', 'num', 'eur'), f('other_taxed_eur', 'num', 'eur'), f('other_exempt_eur', 'num', 'eur'),
    f('tax_base_eur', 'num', 'eur'), f('vat_pct', 'num', '%'), f('vat_eur', 'num', 'eur'), f('total_eur', 'num', 'eur')] },
  { id: 'readings', fields: [] },
];
export const fieldType = (col) => fieldGroups().flatMap((g) => g.fields).find((x) => x.col === col)?.type ?? 'num';

// The key of the state's words: verified | unverified | suspect | missing | edited.
export const stateLabel = (state) => `invoices.state.${['verified', 'unverified', 'suspect', 'missing', 'edited'].includes(state) ? state : 'unverified'}`;

// Text typed in a field -> { value } (null when empty) or { error: 'number' | 'date' | 'int' | 'long' }. 1.234,56 and 0,249 are numbers; 1.2.3 is not.
export function parseField(col, text) {
  const s = String(text ?? '').replace(/[\s ]/g, '');
  const type = fieldType(col);
  if (type === 'text') {
    const v = String(text ?? '').trim();
    return v.length > (col === 'notes' ? 300 : 200) ? { error: 'long' } : { value: v || null };
  }
  if (type === 'kind') return { value: s };
  if (type === 'bool') return { value: s === 'yes' ? true : s === 'no' ? false : null };
  if (!s) return { value: null };
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { value: s } : { error: 'date' };
  const n = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^-?\d+(\.\d+)?$/.test(n)) return { error: type === 'int' ? 'int' : 'number' };
  const value = Number(n);
  if (!Number.isFinite(value) || Math.abs(value) > 1e6) return { error: 'number' };
  if (type === 'int' && !(Number.isInteger(value) && value >= 0 && value <= 366)) return { error: 'int' };
  return { value };
}

// The jargon the bill prints, explained under the field's label with the Settings glossary text (settings.gloss.*).
export const GLOSS = { adjust_eur: 'adjust', max_demand_p1_kw: 'maxDemand', tax_base_eur: 'taxBase' };

// The value as the input shows it (decimal comma in Catalan).
export function fieldText(col, v, lang) {
  if (v == null) return '';
  const type = fieldType(col);
  if (type === 'bool') return v ? 'yes' : 'no';
  return type === 'num' && lang === 'ca' ? String(v).replace('.', ',') : String(v);
}

// "Potència (12,34) + Energia (20,00) sumen 32,34, però la factura diu 33,00." from a failing check of GET /api/invoices/get.
export function sumText(check, nf, lang) {
  if (!check?.terms?.length || check.expected == null || !check.op) return say(lang, 'invoices.check.rule');
  const sign = check.op === '×' ? ' × ' : ' + ';
  const terms = check.terms.map((t) => `${say(lang, `invoices.col.${t.col}`)} (${nf(Math.abs(t.value))}${t.col.endsWith('_pct') ? ' %' : ''})`);
  return say(lang, check.op === '×' ? 'invoices.check.product' : 'invoices.check.sum', {
    terms: terms.join(sign).replaceAll('+ -', '- '), expected: nf(check.expected), actual: nf(check.actual),
  });
}

// An upload of GET /api/invoices/uploads (plus `badge` of its invoice when the view knows it) -> what the row shows.
// kind: waiting | busy | ok | warn | alarm.
export function queueState(u) {
  const row = (key, kind, more = {}) => ({ key: `invoices.q.${key}`, kind, retry: false, manual: false, ...more });
  switch (u.status) {
    case 'queued': return row('queued', 'waiting');
    case 'processing': return row('processing', 'busy');
    case 'done':
      if (u.duplicateOf) return row('duplicate', 'warn', { duplicate: true });
      return ['auto', 'confirmed'].includes(u.badge) ? row('checked', 'ok') : row('review', 'warn');
    case 'not_a_bill': return row('notBill', 'warn');
    default:
      switch (u.error) {
        case 'ai_disabled': return row('aiOff', 'waiting', { manual: true });
        case 'budget': return row('budget', 'warn', { manual: true });
        case 'rate_limited': return row('rate', 'warn', { retry: true, manual: true });
        case 'heic_unsupported': return row('heic', 'alarm', { manual: true });
        default: return row('error', 'alarm', { retry: true, manual: true });
      }
  }
}

// Upload or process error (body.error or message, HTTP status when known) -> message key. A 413 that is not
// too_many_pages is "file too large" (the server sends two shapes).
export function uploadErrorKey(code, status) {
  const c = String(code ?? '');
  if (c === 'too_many_pages') return 'invoices.err.too_many_pages';
  if (status === 413 || c === 'too_large' || c === 'body too large' || /\b413\b/.test(c)) return 'invoices.err.too_large';
  const known = ['unsupported_type', 'duplicate_file', 'too_many_files', 'pdf_alone', 'too_many_images', 'group_closed',
    'rate_limited', 'budget', 'ai_disabled', 'heic_unsupported'];
  return known.includes(c) ? `invoices.err.${c}` : 'invoices.err.other';
}

// 'YYYY-MM' -> "d’octubre" / "de maig" (ca) or "October" (en), for "Ja la tens: factura d’octubre".
export function ofMonth(month, lang) {
  const [y, m] = month.split('-').map(Number);
  const name = new Intl.DateTimeFormat(LANGS[lang].locale, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 15));
  return lang === 'ca' ? `${/^[aeiouh]/i.test(name) ? 'd’' : 'de '}${name}` : name;
}

// ['2026-05','2026-06'] -> "maig i juny de 2026" / "May and June 2026"; several years read year by year.
export function missingText(months, lang) {
  const byYear = new Map();
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const name = new Intl.DateTimeFormat(LANGS[lang].locale, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 15));
    byYear.set(y, [...(byYear.get(y) ?? []), name]);
  }
  const and = say(lang, 'invoices.and');
  const parts = [...byYear].map(([y, names]) => {
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}` : names[0];
    return say(lang, 'invoices.yearOf', { list, year: y });
  });
  return parts.join(', ');
}

// One sentence per block with its euros, from the extracted numbers (no model involved). Blocks add up to the total:
// fixed + energy + adjust - surplus + taxes + other = total. A missing amount counts as zero.
export function plainWords(inv, lang, lines = []) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cents = (v) => Math.round(v * 100) / 100;
  const adjust = n(inv.adjust_eur);
  const energy = n(inv.energy_eur) - adjust; // energy_eur includes the adjustment
  const fixed = n(inv.power_eur) + n(inv.social_bonus_eur) + n(inv.meter_rent_eur);
  const surplus = n(inv.surplus_eur);
  const taxes = n(inv.elec_tax_eur) + n(inv.vat_eur);
  const other = n(inv.other_taxed_eur) + n(inv.other_exempt_eur);
  const lost = inv.surplus_lost_eur > 0 ? say(lang, 'invoices.plain.surplusLoss', { eur: eurs(lang, inv.surplus_lost_eur) })
    : inv.surplus_lost_eur === 0 ? say(lang, 'invoices.plain.surplusNoLoss') : '';
  const blocks = [
    ['fixed', fixed, {}],
    ['energy', energy, { kwh: new Intl.NumberFormat(LANGS[lang].locale, { maximumFractionDigits: 1 }).format(n(inv.kwh_p1) + n(inv.kwh_p2) + n(inv.kwh_p3)) }],
    ['adjust', adjust, {}],
    ['surplus', -surplus, { lost }],
    ['taxes', taxes, {}],
    ['other', other, {}],
  ];
  // name the other charges by their bill lines (a voluntary donation is not a supply cost)
  const named = lines.filter((l) => (l.section === 'other' || l.section === 'discount') && !l.info && l.concept).map((l) => l.concept);
  const parts = blocks.filter(([id, v]) => v !== 0 || id === 'fixed' || id === 'energy')
    .map(([id, eur, vars]) => ({ id, eur: cents(eur), text: say(lang, id === 'other' ? `invoices.plain.other${eur < 0 ? 'Credit' : ''}${named.length ? 'Named' : ''}` : `invoices.plain.${id}`, { ...vars, eur: eurs(lang, Math.abs(cents(eur))), names: named.join(', ') }) }));
  return { parts, sum: cents(parts.reduce((s, p) => s + p.eur, 0)), total: inv.total_eur ?? null };
}

const numText = (lang, v, max = 3) => new Intl.NumberFormat(LANGS[lang].locale, { maximumFractionDigits: max }).format(v);
const UNIT = { days: 'invoices.unit.d', kW: 'invoices.unit.kW', kWh: 'invoices.unit.kWh', '%': 'invoices.unit.%' };

// A bill line's quantity and unit price in the reader's locale: "31 dies", "4,4 kW", an EUR quantity as money.
export function lineCells(line, lang) {
  const q = line.quantity;
  let qty = '';
  if (typeof q === 'number') {
    qty = line.unit === 'EUR' ? eurs(lang, q) : `${numText(lang, q)}${UNIT[line.unit] ? ` ${say(lang, UNIT[line.unit])}` : ''}`;
  }
  return { qty, price: typeof line.unit_price === 'number' ? numText(lang, line.unit_price, 6) : '' };
}

// A meter reading's kWh: "2.016,92 - 2.017,87 kWh" in Catalan.
export function readingText(r, lang) {
  const v = (x) => (typeof x === 'number' ? numText(lang, x, 2) : '');
  return r.start_kwh == null && r.end_kwh == null ? '' : `${v(r.start_kwh)} - ${v(r.end_kwh)} kWh`;
}

// A coverage cell of GET /api/invoices -> its state. 'missing' only for months the server lists in `missing` (the list
// the sentence under the grid reads too); a month without enough measurements is 'nodata'; a measured month that is not
// missing yet (its bill may still arrive) is 'pending'. Without `measuredMonths` (older server) such a month is 'nodata'.
export function coverageState(cell, missing = [], measuredMonths = null) {
  if (cell.state === 'ok' || cell.state === 'review') return cell.state;
  if (missing.includes(cell.month)) return 'missing';
  return measuredMonths?.includes(cell.month) ? 'pending' : 'nodata';
}

// The checks of a 409 checks_failed -> { notes: [{ id, col, text }], byCol: { col: noteCol } }: one plain sentence per
// failing check, shown under the field it computes (its target) or its first field; every field it names points there.
export function failedChecks(checks, nf, lang) {
  const notes = [];
  const byCol = {};
  for (const c of checks ?? []) {
    const fields = (c.fields ?? []).filter(Boolean);
    if (!fields.length) continue;
    const col = fields.includes(c.target) ? c.target : fields[0];
    const plain = say(lang, dict.en[`invoices.check.${c.id}`] ? `invoices.check.${c.id}` : 'invoices.check.rule');
    const sum = c.terms?.length && c.expected != null && c.op ? ` ${sumText(c, nf, lang)}` : '';
    const note = notes.find((n) => n.col === col);
    if (note) note.text += ` ${plain}${sum}`;
    else notes.push({ id: c.id, col, text: `${plain}${sum}` });
    for (const fld of fields) byCol[fld] ??= col;
  }
  return { notes, byCol };
}
