// Time range model shared by every ranged view. Pure: days are 'YYYY-MM-DD' strings, ctx is { today, firstDay }.
// URL keys: r (preset), d (day, YYYY-MM or YYYY), from, to (custom), cmp (none|prev|yoy), b (bucket, auto).
import { addDays, addMonths, spanDays, SERIES_BUCKETS, ENERGY_BUCKETS } from './buckets.js';

export const PRESETS = ['today', 'yesterday', '7d', '30d', 'month', 'year', 'all', 'custom'];
export const COMPARES = ['none', 'prev', 'yoy'];
const BUCKETS = new Set([...SERIES_BUCKETS, ...ENERGY_BUCKETS]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const isDay = (s) => DAY_RE.test(s ?? '') && addDays(s, 0) === s; // rejects 2026-02-31
const daysInMonth = (ym) => Number(addDays(addMonths(`${ym}-01`, 1), -1).slice(8));
const lastOfMonth = (ym) => `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
const clamp = (day, { today, firstDay }) => (day > today ? today : firstDay && day < firstDay ? firstDay : day);

const getter = (params) => (k) => {
  const v = typeof params?.get === 'function' ? params.get(k) : params?.[k];
  return v == null || v === '' ? null : String(v);
};

// Builds the full range for a preset. `d` (day, month or year) and `custom` only matter for the presets that use them.
function build(r, { d, from, to }, ctx) {
  const { today } = ctx;
  let a;
  let z = today;
  let key = null;
  if (r === 'today') a = z = today;
  else if (r === 'yesterday') a = z = addDays(today, -1);
  else if (r === '7d') a = addDays(today, -6);
  else if (r === '30d') a = addDays(today, -29);
  else if (r === 'month') {
    key = MONTH_RE.test(d ?? '') && isDay(`${d}-01`) ? d : today.slice(0, 7);
    a = `${key}-01`;
    z = lastOfMonth(key);
  } else if (r === 'year') {
    key = YEAR_RE.test(d ?? '') ? d : today.slice(0, 4);
    a = `${key}-01-01`;
    z = `${key}-12-31`;
  } else if (r === 'all') a = ctx.firstDay ?? today;
  else [a, z] = from <= to ? [from, to] : [to, from];
  a = clamp(a, ctx);
  z = clamp(z, ctx);
  if (a > z) a = z;
  return { r, d: key, from: a, to: z, days: spanDays(a, z) };
}

export function parseRange(params, ctx, fallback = 'today') {
  const get = getter(params);
  const asked = get('r');
  const valid = (r) => PRESETS.includes(r) && !(r === 'custom' && !(isDay(get('from')) && isDay(get('to'))));
  const r = valid(asked) ? asked : valid(fallback) ? fallback : 'today';
  const cmp = COMPARES.includes(get('cmp')) ? get('cmp') : 'none';
  const b = BUCKETS.has(get('b')) ? get('b') : 'auto';
  return { ...build(r, { d: get('d'), from: get('from'), to: get('to') }, ctx), cmp, b };
}

// null clears a key (ctx.setParams deletes null keys); defaults and derived values are not written.
export function rangeParams(range) {
  const custom = range.r === 'custom';
  return {
    r: range.r,
    d: range.d ?? null,
    from: custom ? range.from : null,
    to: custom ? range.to : null,
    cmp: range.cmp && range.cmp !== 'none' ? range.cmp : null,
    b: range.b && range.b !== 'auto' ? range.b : null,
  };
}

const customOf = (range, from, to) => ({ ...range, r: 'custom', d: null, from, to, days: spanDays(from, to) });

// Previous (dir -1) or next (+1) period; null when it would lie wholly before firstDay or after today.
export function stepRange(range, dir, ctx) {
  const { today, firstDay } = ctx;
  const inside = (from, to) => from <= today && (!firstDay || to >= firstDay);
  const finish = (r) => (inside(r.from, r.to) ? r : null);
  if (range.r === 'all') return null;
  if (range.r === 'month' || range.r === 'year') {
    const month = range.r === 'month';
    const d = month ? addMonths(`${range.d}-01`, dir).slice(0, 7) : String(Number(range.d) + dir);
    const next = build(range.r, { d }, ctx);
    const from = month ? `${d}-01` : `${d}-01-01`;
    const to = month ? lastOfMonth(d) : `${d}-12-31`;
    return inside(from, to) ? { ...range, ...next } : null;
  }
  if (range.r === 'today' || range.r === 'yesterday') {
    const day = addDays(range.from, dir);
    if (day === today) return finish({ ...range, r: 'today', d: null, from: day, to: day, days: 1 });
    if (day === addDays(today, -1)) return finish({ ...range, r: 'yesterday', d: null, from: day, to: day, days: 1 });
    return finish(customOf(range, day, day));
  }
  // 7d, 30d, custom: move by the span; the last window may end after today and is cut there
  const n = spanDays(range.from, range.to);
  const from = addDays(range.from, dir * n);
  const to = addDays(range.to, dir * n);
  if (!inside(from, to)) return null;
  return customOf(range, clamp(from, ctx), clamp(to, ctx));
}

export function rangeLabel(range, locale) {
  const utc = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  const f = (opts) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
  const full = { day: 'numeric', month: 'short', year: 'numeric' };
  if (range.r === 'month') return f({ month: 'long', year: 'numeric' }).format(utc(`${range.d}-01`));
  if (range.r === 'year') return range.d;
  if (range.from === range.to) return f(full).format(utc(range.from));
  // the shortest form the language has: "13–19 de nov. 2026", "21 d’oct. – 19 de nov. 2026"
  return f(full).formatRange(utc(range.from), utc(range.to));
}

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A drag-zoom covers the whole days it touches. Pass format.dayOf to read the days in the plant's time zone.
export function customFromZoom(fromMs, toMs, dayOf = localDay) {
  const [a, z] = [dayOf(Math.min(fromMs, toMs)), dayOf(Math.max(fromMs, toMs))];
  return { r: 'custom', from: a, to: z };
}
