// Read-side aggregation for the monitoring views: bucketed power series, period energy with comparison,
// and the signal browser. Pure reads over the Store.
import { dayBounds, localDay } from './collector.js';
import { dayMoney, periodMoney } from './tariff.js';
import { addDays, addMonths, spanDays, compareDays } from '../public/js/buckets.js';

const HOUR = 3600e3;
const SLOT = 300e3;
const STEP = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': HOUR };

// n+1 edges (ms): fixed steps over the whole range (DST days are 23/25 h long), or one per local day.
function edges(from, to, bucket) {
  const start = dayBounds(from)[0];
  const end = dayBounds(to)[1];
  const out = [];
  if (bucket === '1d') {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(dayBounds(d)[0]);
  } else {
    for (let t = start; t < end; t += STEP[bucket]) out.push(t);
  }
  out.push(end);
  return out;
}

// Provisional: the day is not final yet (no sync row, or synced less than 36 h after it ended).
function provisionalDays(store, from, to, now) {
  const today = localDay(now);
  const synced = new Map(store.daySyncs(from, to).map((r) => [r.day, r.synced_at]));
  return (day) => day <= today && !(synced.has(day) && synced.get(day) > dayBounds(day)[1] + 36 * HOUR);
}

const pos = (v) => (v == null ? null : Math.max(v, 0));
const neg = (v) => (v == null ? null : Math.max(-v, 0));
// Signs are split per sample, before any averaging.
const COLS = {
  pv_kw: (s) => s.pv_kw,
  inverter_kw: (s) => s.inverter_kw,
  load_kw: (s) => s.load_kw,
  imp_kw: (s) => pos(s.grid_kw),
  exp_kw: (s) => neg(s.grid_kw),
  charge_kw: (s) => pos(s.battery_kw),
  discharge_kw: (s) => neg(s.battery_kw),
  soc: (s) => s.soc,
};
const MAXES = { load_kw: 'load_kw_max', imp_kw: 'imp_kw_max', soc: 'soc_max' };
const KWH = { pv: 'pv_kw', load: 'load_kw', imp: 'imp_kw', exp: 'exp_kw', charge: 'charge_kw', discharge: 'discharge_kw' };
const DAILY_KWH = { pv: 'pv_kwh', load: 'load_kwh', imp: 'import_kwh', exp: 'export_kwh', charge: 'charge_kwh', discharge: 'discharge_kwh' };

export function series(store, { from, to, bucket, now = Date.now() }) {
  const t = edges(from, to, bucket);
  const end = t.pop();
  const n = t.length;
  const col = (v) => Array(n).fill(v);
  const sum = {}, cnt = {}, max = {}, min = {};
  for (const k of Object.keys(COLS)) [sum[k], cnt[k], max[k], min[k]] = [col(0), col(0), col(null), col(null)];
  const loadCount = col(0);
  let i = 0;
  for (const s of store.samples(t[0], end)) {
    while (i < n - 1 && s.ts >= t[i + 1]) i++;
    if (s.load_kw != null) loadCount[i]++;
    for (const [k, f] of Object.entries(COLS)) {
      const v = f(s);
      if (v == null) continue;
      sum[k][i] += v;
      cnt[k][i]++;
      if (max[k][i] === null || v > max[k][i]) max[k][i] = v;
      if (min[k][i] === null || v < min[k][i]) min[k][i] = v;
    }
  }
  const future = t.map((x) => x >= now);
  const mean = (k) => sum[k].map((x, j) => (cnt[k][j] && !future[j] ? x / cnt[k][j] : null));
  const out = {};
  for (const k of Object.keys(COLS)) out[k] = mean(k);
  for (const [k, name] of Object.entries(MAXES)) out[name] = max[k].map((v, j) => (future[j] ? null : v));
  out.soc_min = min.soc.map((v, j) => (future[j] ? null : v));

  const coverage = t.map((s, j) => {
    const e = Math.min(j + 1 < n ? t[j + 1] : end, now);
    return e <= s ? null : Math.min(1, loadCount[j] / ((e - s) / SLOT));
  });
  const isProv = provisionalDays(store, from, to, now);
  const provisional = t.map((s, j) => {
    const first = localDay(s);
    const last = localDay((j + 1 < n ? t[j + 1] : end) - 1);
    for (let d = first; d <= last; d = addDays(d, 1)) if (isProv(d)) return true;
    return false;
  });
  const res = { bucket, t, coverage, provisional, series: out };

  if (bucket === '1h') {
    const raw = Object.fromEntries(Object.entries(KWH).map(([name, k]) => [name, sum[k].map((x, j) => (cnt[k][j] && !future[j] ? x / 12 : null))]));
    const daily = new Map(store.days(from, to).map((r) => [r.day, r]));
    const dayOf = t.map((s) => localDay(s));
    for (const [name, arr] of Object.entries(raw)) {
      const totals = new Map();
      arr.forEach((v, j) => v != null && totals.set(dayOf[j], (totals.get(dayOf[j]) ?? 0) + v));
      arr.forEach((v, j) => {
        const total = daily.get(dayOf[j])?.[DAILY_KWH[name]];
        const integral = totals.get(dayOf[j]);
        if (v != null && total > 0 && integral > 0) arr[j] = (v * total) / integral;
      });
    }
    res.kwh = raw;
  }
  return res;
}

const SUMMED = ['pv_kwh', 'load_kwh', 'import_kwh', 'export_kwh', 'self_use_kwh', 'charge_kwh', 'discharge_kwh',
  'import_p1', 'import_p2', 'import_p3', 'load_p1', 'load_p2', 'load_p3'];
const KEY_LEN = { '1d': 10, '1mo': 7, '1y': 4 };

// Calendar buckets over [from, to], clipped to the range.
function bucketRanges(from, to, bucket) {
  const out = [];
  for (let cur = from; cur <= to;) {
    const key = cur.slice(0, KEY_LEN[bucket]);
    const last = bucket === '1d' ? cur : bucket === '1y' ? `${key}-12-31` : addDays(addMonths(`${key}-01`, 1), -1);
    const e = last < to ? last : to;
    out.push({ key, from: cur, to: e });
    cur = addDays(e, 1);
  }
  return out;
}

function fold(rows, from, to, extra) {
  const o = { from, to };
  for (const c of SUMMED) {
    const vals = rows.map((r) => r[c]).filter((v) => v != null);
    o[c] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  return { ...o, ...extra };
}

function energyBuckets(store, { from, to, bucket, prices, now }) {
  const today = localDay(now);
  const rows = store.days(from, to);
  const isProv = provisionalDays(store, from, to, now);
  const stats = (r, f, t) => {
    const expected = f > today ? 0 : spanDays(f, t < today ? t : today);
    let provisional = false;
    for (let d = f; d <= t && !provisional; d = addDays(d, 1)) provisional = isProv(d);
    return { days: r.length, daysExpected: expected, coverage: expected ? r.length / expected : null, provisional };
  };
  const money = (r) => (bucket === '1d' ? bucketMoney(r[0], prices) : periodMoney(r, prices));
  const buckets = bucketRanges(from, to, bucket).map((b) => {
    const r = rows.filter((x) => x.day >= b.from && x.day <= b.to);
    return { key: b.key, ...fold(r, b.from, b.to, { ...stats(r, b.from, b.to), money: r.length ? money(r) : null }) };
  });
  const total = fold(rows, from, to, { ...stats(rows, from, to), money: periodMoney(rows, prices) });
  return { buckets, total };
}

// A single day is shown uncapped (a surplus day is an earning); the cap only applies per calendar month.
function bucketMoney(row, prices) {
  const m = dayMoney(row, prices);
  return m && { ...m, bill: m.energy + m.fixed };
}

export function energy(store, { from, to, bucket, compare, prices, now = Date.now() }) {
  const res = { bucket, ...energyBuckets(store, { from, to, bucket, prices, now }) };
  if (compare) {
    const c = compareDays(from, to, compare);
    const cmp = energyBuckets(store, { ...c, bucket, prices, now });
    const first = store.firstDay();
    const reason = first == null || c.from < first ? 'beforeFirstDay' : (cmp.total.coverage ?? 0) < 0.9 ? 'lowCoverage' : null;
    res.compare = { ...c, ...cmp, comparable: reason === null, reason };
  }
  return res;
}

export function signalHistory(store, { dn, ids, from, to, bucket, meta = [] }) {
  const t = edges(from, to, bucket);
  const end = t.pop();
  const rows = store.signalHistory(dn, ids, t[0], end);
  const signals = ids.map((id) => {
    const col = () => Array(t.length).fill(null);
    const [avg, min, max, cnt] = [col(), col(), col(), Array(t.length).fill(0)];
    let i = 0;
    for (const r of rows) {
      if (r.signal_id !== id || r.value == null) continue;
      while (i < t.length - 1 && r.ts >= t[i + 1]) i++;
      avg[i] = (avg[i] ?? 0) + r.value;
      cnt[i]++;
      if (min[i] === null || r.value < min[i]) min[i] = r.value;
      if (max[i] === null || r.value > max[i]) max[i] = r.value;
    }
    const m = meta.find((s) => s.id === id);
    return { id, name: m?.name ?? null, unit: m?.unit ?? null, avg: avg.map((x, j) => (cnt[j] ? x / cnt[j] : null)), min, max };
  });
  return { bucket, t, signals };
}
