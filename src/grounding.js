// Number grounding check. It answers one question: does each figure in an answer appear in text the
// model was given this turn? It does not prove the figure carries the right label or period. Pure, no I/O.
// The checker does no arithmetic of its own: derived figures come from tools (calculate, query_data, precomputed fields).

export const MARK = { ca: '[xifra no comprovada]', en: '[unverified figure]' };
const NOTE = {
  ca: (n) => `He tret ${n} ${n === 1 ? 'xifra que no he pogut comprovar' : 'xifres que no he pogut comprovar'} amb les dades.`,
  en: (n) => `I removed ${n} ${n === 1 ? 'figure' : 'figures'} I could not check against the data.`,
};

// Closed unit list (step 4), longest first so `kWh` wins over `kW` and `€/kWh` over `€`.
const UNITS = ['€', 'EUR', 'euros', 'cèntims', 'cents', 'c€', '%', 'kWh', 'MWh', 'Wh', 'kW', 'W', 'kWp', 'Wp', '€/kWh', '€/MWh',
  '€/kW', 'h', 'hores', 'hours', 'min', 'minuts', 'minutes', 'dies', 'days', 'mesos', 'months', 'anys', 'years']
  .sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const UNIT_RE = UNITS.map(esc).join('|');
// a number (not glued to a letter or digit before it), an optional currency sign before, an optional unit after
const TOKEN = new RegExp(`(?:(€)\\s?)?(?<![\\p{L}\\p{N}.,])(\\d+(?:[.,]\\d+)*)(?:[ \\t*_]{0,5}(${UNIT_RE})(?![\\p{L}\\p{N}]))?`, 'giu');
const CANON = new Map(UNITS.map((u) => [u.toLowerCase(), u])); // units match in any case; ** and _ may sit before the unit

// Unit factors k tried besides 1 (step 6).
const THOUSAND = [1000, 0.001];
const HOURS = [60, 1 / 60];
const FACTORS = {
  '%': [100], kW: THOUSAND, W: THOUSAND, MWh: THOUSAND, kWh: THOUSAND, Wh: THOUSAND, '€/MWh': THOUSAND, '€/kWh': THOUSAND,
  cents: [100], 'cèntims': [100], 'c€': [100], h: HOURS, hores: HOURS, hours: HOURS, min: HOURS, minuts: HOURS, minutes: HOURS,
};

const MONTHS_CA = 'gener|febrer|març|abril|maig|juny|juliol|agost|setembre|octubre|novembre|desembre';
// Masked, never checked (step 3). Bare years are skipped in figures() because they need the unit check.
const MASKS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
  new RegExp(`\\b\\d{1,2} d(?:e |['\u2019])(?:${MONTHS_CA})`, 'giu'),
  /\b\d{1,2}:\d{2}\b/g,
  /\bP[1-3]\b/g,
  /\b2\.0\s?TD\b/gi,
  /^[ \t]*\d{1,3}[.)](?=\s)/gm,
];

// Step 2.
export const normalise = (text) => String(text ?? '').normalize('NFKC').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\u2212/g, '-');

const decimals = (s) => (s ? s.length : 0);
// `s` read with thousands separator T and decimal separator D; null when it does not fit that convention.
function parseWith(s, T, D) {
  const t = esc(T);
  const d = esc(D);
  const m = new RegExp(`^(\\d{1,3}(?:${t}\\d{3})+|\\d+)(?:${d}(\\d+))?$`).exec(s);
  if (!m) return null;
  return { value: Number(`${m[1].split(T).join('')}.${m[2] ?? '0'}`), d: decimals(m[2]) };
}

const CONV = { ca: ['.', ','], en: [',', '.'] };

// Every reading of a numeric string, for the answer in `lang` (step 5).
function readings(s, lang) {
  const [T, D] = CONV[lang] ?? CONV.en;
  const seps = s.match(/[.,]/g) ?? [];
  if (!seps.length) return [{ value: Number(s), d: 0 }];
  if (seps.length === 1 && /^\d+[.,]\d{3}$/.test(s)) {
    return [parseWith(s, T, D), parseWith(s, D, T)].filter(Boolean); // 1.180 is 1180 or 1.18
  }
  const own = parseWith(s, T, D);
  if (own) return [own];
  const other = parseWith(s, D, T); // written in the other convention
  return other ? [other] : [];
}

// Lenient: every number a text can mean, for the grounded set (both conventions, pieces when neither fits).
export function numbersIn(text) {
  const out = [];
  for (const [s] of normalise(text).matchAll(/\d+(?:[.,]\d+)*/g)) {
    const r = [parseWith(s, '.', ','), parseWith(s, ',', '.')].filter(Boolean);
    if (r.length) for (const x of r) out.push(x.value);
    else for (const p of s.split(/[.,]/)) out.push(Number(p));
  }
  return out;
}

function walk(v, add) {
  if (typeof v === 'number') add(v);
  else if (typeof v === 'string') for (const n of numbersIn(v)) add(n);
  else if (Array.isArray(v)) v.forEach((x) => walk(x, add));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k, add); walk(x, add); }
}

// Step 1: G from message contents (system prompt, history texts, the user message, every tool result string as sent).
// A JSON string is walked (its numbers and the numbers inside its strings); any other string is scanned as text.
export function groundedSet(contents, into = new Set()) {
  const add = (n) => { if (Number.isFinite(n)) into.add(Math.abs(n)); };
  for (const c of contents) {
    if (typeof c !== 'string') { walk(c, add); continue; }
    const s = c.trim();
    let parsed;
    if (s.startsWith('{') || s.startsWith('[')) {
      try { parsed = JSON.parse(s); } catch { parsed = undefined; }
    }
    walk(parsed === undefined ? c : parsed, add);
  }
  return into;
}

// The checked figures of a text (step 4): [{ start, end, raw, unit, readings: [{ value, d }] }].
export function figures(text, lang) {
  const norm = normalise(text);
  let masked = norm;
  for (const re of MASKS) masked = masked.replace(re, (m) => ' '.repeat(m.length));
  const out = [];
  for (const m of masked.matchAll(TOKEN)) {
    const [, pre, num, post] = m;
    const unit = pre ?? (post ? CANON.get(post.toLowerCase()) ?? post : null);
    let start = m.index;
    const end = m.index + m[0].length;
    if (pre && post) continue; // "€ 5 €" is not a figure we can read
    if (!unit && /^\d+$/.test(num) && Number(num) >= 1900 && Number(num) <= 2100) continue; // a bare year
    const rs = readings(num, lang);
    if (!rs.length) continue;
    const checked = unit || rs.some((r) => r.d > 0 || r.value >= 1000);
    if (!checked) continue;
    if (norm[start - 1] === '-' && !/\d/.test(norm[start - 2] ?? '')) start -= 1; // a sign belongs to the figure
    out.push({ start, end, raw: norm.slice(start, end), unit, readings: rs });
  }
  return out;
}

const significant = (n) => String(n).replace(/0+$/, '').length;
const roundSig = (v, digits) => {
  if (v === 0) return 0;
  const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) + 1 - digits);
  return Math.round(v / p) * p;
};

// Step 7 for one reading against G with the unit's factors.
function readingGrounded({ value, d }, unit, G) {
  const x = Math.abs(value);
  const ks = [1, ...(FACTORS[unit] ?? [])];
  const tol = 0.5 * 10 ** -d + 1e-9;
  const roundish = d === 0 && /0$/.test(String(x)) && significant(x) >= 2;
  for (const g of G) {
    for (const k of ks) {
      const v = g * k;
      if (Math.abs(x - v) <= tol) return true;
      if (roundish && Math.abs(roundSig(v, significant(x)) - x) < 1e-6 && Math.abs(x - v) <= 0.05 * v) return true;
    }
  }
  return false;
}

export const isGrounded = (fig, G) => fig.readings.some((r) => readingGrounded(r, fig.unit, G));

// Steps 4-7 over a whole text: the figures that are not grounded.
export function check(text, G, lang) {
  return figures(text, lang).filter((f) => !isGrounded(f, G));
}

// Step 9, last resort: each ungrounded figure becomes the placeholder and one line says how many were removed.
export function redact(text, ungrounded, lang) {
  const norm = normalise(text);
  if (!ungrounded.length) return norm;
  let out = norm;
  for (const f of [...ungrounded].sort((a, b) => b.start - a.start)) out = out.slice(0, f.start) + (MARK[lang] ?? MARK.en) + out.slice(f.end);
  return `${out}\n\n${(NOTE[lang] ?? NOTE.en)(ungrounded.length)}`;
}

// The correction request sent back to the model (step 9, first pass).
export const correction = (ungrounded) => `These figures are not in any tool result or message of this turn: ${ungrounded.map((f) => f.raw).join('; ')}. `
  + 'Get each one from a tool (use calculate for any arithmetic) or leave it out, then write the whole answer again.';
