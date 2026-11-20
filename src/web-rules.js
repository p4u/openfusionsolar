// What may leave the server through the web tools (spec 3.3): search queries without personal data or the household's
// own figures, and page reads limited to URLs this turn's search returned or the guide lists. Pure, no I/O.
import { isGrounded } from './grounding.js';

const MAX_QUERY = 200;

// Personal identifiers, tried on the upper-cased query.
const PATTERNS = {
  tax_id: /\b(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])\b/,
  iban: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/,
  cups: /\bES\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?[A-Z]{2}(?:\d[A-Z])?\b/,
  email: /[^\s@]+@[^\s@]+\.[^\s@]+/,
  phone: /(?:\+|\b00)\d[\d\s.-]{7,}\d|\b[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b|\b[6789]\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}\b/,
};

// lower case, accents stripped, spaces collapsed
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// null when the query may be sent, else the reason. groundedNonWeb: the household's figures of this turn (history, the
// user message, attachments and every tool result except read_guide, calculate, web_search and read_web_page; never
// the system prompt, preflight F5); personal: plant name, every invoice's invoice_number, rectifies_number,
// contract_number, cups and supplier_tax_id, device names and DNs of kv devices, bill note lines of 12 characters or more.
export function queryRefusal(query, { groundedNonWeb = new Set(), personal = [] } = {}) {
  if (typeof query !== 'string' || !query.trim()) return 'the query is empty';
  if (query.length > MAX_QUERY) return `the query is longer than ${MAX_QUERY} characters`;
  const up = query.normalize('NFKC').toUpperCase();
  for (const [name, re] of Object.entries(PATTERNS)) if (re.test(up)) return `the query looks like it holds a ${name.replace('_', ' ')}`;
  for (const [s] of query.replace(/\b2\.0\s?TD\b|\bP[1-3]\b/gi, ' ').matchAll(/\d+(?:[.,]\d+)*/g)) {
    const digits = s.replace(/\D/g, '');
    if (digits.length < 2) continue;
    if (/^\d{4}$/.test(s) && Number(s) >= 1900 && Number(s) <= 2100) continue; // a year
    const readings = [/^\d+$/.test(s) ? { value: Number(s), d: 0 } : null,
      ...[['.', ','], [',', '.']].map(([T, D]) => {
        const m = new RegExp(`^(\\d{1,3}(?:\\${T}\\d{3})+|\\d+)(?:\\${D}(\\d+))?$`).exec(s);
        return m && { value: Number(`${m[1].split(T).join('')}.${m[2] ?? '0'}`), d: m[2]?.length ?? 0 };
      })].filter(Boolean);
    if (isGrounded({ unit: null, readings }, groundedNonWeb)) return `the query contains ${s}, a figure from the household's data`;
  }
  const q = fold(query);
  for (const p of personal) {
    const f = fold(p);
    if (f.length >= 3 && q.includes(f)) return 'the query contains the plant name, a bill number or a line of bill notes';
  }
  return null;
}

// The canonical form of a URL (what `new URL(u).href` gives), or null.
export function canonicalUrl(u) {
  try {
    return new URL(u).href;
  } catch {
    return null;
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// null when `raw` may be read, else the reason. allowed: canonical URLs returned by web_search this turn plus the
// guide's sources. The URL must equal one of them character for character after canonicalisation.
export function urlRefusal(raw, allowed) {
  if (typeof raw !== 'string' || raw.length > 2000) return 'not a url';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'not a url';
  }
  if (u.protocol !== 'https:') return 'only https pages can be read';
  if (u.username || u.password) return 'a url with a user name or password cannot be read';
  const host = u.hostname;
  if (host.startsWith('[') || IPV4.test(host)) return 'a url with an ip address cannot be read';
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return 'a local address cannot be read';
  // `new URL` drops a default port, so look at the authority as written
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:\d*(?:[/?#]|$)/i.test(raw.trim())) return 'a url with a port cannot be read';
  if (!allowed.has(u.href)) return 'only a url returned by web_search in this turn, or a source listed in the guide, can be read';
  return null;
}
