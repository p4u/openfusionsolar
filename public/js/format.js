// Numbers, dates and durations in the current language and the plant's time zone. Unknown (null) values read
// as t('core.unknown'), never as zero. Formatters are built on first use and cached (none at import time).
import { locale, t } from './i18n.js';

const NB = '\u00a0'; // keeps a number and its unit on one line
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

let zone; // undefined: the browser's zone
const cache = new Map();

export function setTimeZone(tz) {
  try {
    zone = tz ? new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone : undefined;
  } catch {
    zone = undefined;
  }
}

function intl(Kind, opts) {
  const key = `${Kind.name}|${locale()}|${JSON.stringify(opts)}`;
  if (!cache.has(key)) cache.set(key, new Kind(locale(), opts));
  return cache.get(key);
}
const dateFmt = (opts, timeZone = zone) => intl(Intl.DateTimeFormat, { ...opts, timeZone });
const unknown = (v) => v == null || Number.isNaN(v);

export const nf = (digits) => intl(Intl.NumberFormat, { minimumFractionDigits: digits, maximumFractionDigits: digits });
// axis ticks: up to `digits` decimals, no trailing zeros ("2", "2,5", never "2,00")
export const nfAxis = (digits) => intl(Intl.NumberFormat, { maximumFractionDigits: digits });
export const kw = (v) => (unknown(v) ? t('core.unknown') : `${nf(2).format(v)}${NB}kW`);
// one rounding rule for energy: no decimals from 100 kWh up, one below (pass digits to override)
export const kwh = (v, digits) => (unknown(v) ? t('core.unknown') : `${nf(digits ?? (Math.abs(v) >= 100 ? 0 : 1)).format(v)}${NB}kWh`);
export const eur = (v) => (unknown(v) ? t('core.unknown') : intl(Intl.NumberFormat, { style: 'currency', currency: 'EUR' }).format(v));
export const pct = (v) => (unknown(v) ? t('core.unknown') : `${Math.round(v)}${NB}%`);

export const fmtTime = (ts) => (unknown(ts) ? t('core.unknown') : dateFmt({ hour: '2-digit', minute: '2-digit' }).format(ts));
export const fmtDateTime = (ts) =>
  (unknown(ts) ? t('core.unknown') : dateFmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts));

// 'YYYY-MM-DD' is a calendar day (formatted as is); a number is an instant shown in the plant's zone.
export function fmtDate(dayOrTs, opts = { day: 'numeric', month: 'short' }) {
  if (unknown(dayOrTs)) return t('core.unknown');
  if (typeof dayOrTs === 'string' && DAY_RE.test(dayOrTs)) {
    const [y, m, d] = dayOrTs.split('-').map(Number);
    return dateFmt(opts, 'UTC').format(Date.UTC(y, m - 1, d, 12));
  }
  return dateFmt(opts).format(dayOrTs);
}

export function fmtMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const s = dateFmt({ month: 'long', year: 'numeric' }, 'UTC').format(Date.UTC(y, m - 1, 15));
  return s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);
}

// Short month with its year for ticks and month buckets: "gen. 2026" / "Jan 2026". 'YYYY-MM' or an instant.
export function fmtMonthShort(v) {
  if (unknown(v)) return t('core.unknown');
  const day = typeof v === 'string';
  const ts = day ? Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, 15) : v;
  const parts = dateFmt({ month: 'short', year: 'numeric' }, day ? 'UTC' : zone).formatToParts(ts);
  const get = (k) => parts.find((p) => p.type === k)?.value ?? '';
  return `${get('month')} ${get('year')}`;
}

// Machine-readable period of a bucket start for CSV: 'YYYY-MM-DD' for day buckets, else 'YYYY-MM-DDTHH:mm' (plant time).
export function isoLocal(ts, bucket) {
  if (unknown(ts)) return '';
  if (bucket === '1mo') return dayOf(ts).slice(0, 7);
  if (bucket === '1y') return dayOf(ts).slice(0, 4);
  if (bucket === '1d') return dayOf(ts);
  return `${dayOf(ts)}T${dateFmt({ hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(ts)}`;
}

export function duration(ms) {
  if (unknown(ms)) return t('core.unknown');
  const n = (v) => intl(Intl.NumberFormat, { maximumFractionDigits: 1 }).format(v);
  if (ms >= 2 * DAY) return t('core.duration.days', { n: n(ms / DAY) });
  if (ms >= HOUR) return t('core.duration.hours', { n: n(ms / HOUR) });
  return t('core.duration.minutes', { n: Math.max(1, Math.round(ms / 60e3)) });
}

// Change from prev to cur in whole percent; null when there is nothing to compare with.
export function delta(cur, prev) {
  if (unknown(cur) || unknown(prev) || prev === 0) return { pct: null, text: t('core.unknown') };
  const p = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  return { pct: p, text: `${intl(Intl.NumberFormat, { signDisplay: 'exceptZero' }).format(p)}${NB}%` };
}

// The plant's calendar day of an instant, and the instant a plant day starts (DST-safe).
export function dayOf(ts) {
  const p = Object.fromEntries(dateFmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, zone).formatToParts(ts).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function dayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const start = guess - offset(guess);
  return guess - offset(start);
}

// zone offset in ms at an instant (local wall time minus UTC)
function offset(ts) {
  const p = Object.fromEntries(dateFmt({ hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(ts).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
