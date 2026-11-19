// Pure helpers of the Battery view (also used by Panels for the range clamp and bucket choice).
import { addDays, legalSeriesBuckets, legalEnergyBuckets, autoSeriesBucket, autoEnergyBucket } from '../buckets.js';

export const BUCKET_MS = { '5m': 300e3, '15m': 900e3, '1h': 3600e3, '1d': 86400e3 };

// getSeries accepts at most 750 buckets: start no earlier than the first reading nor 749 days before `to`.
export function clampFrom(from, to, firstSampleDay, maxDays = 750) {
  let start = from;
  if (firstSampleDay && firstSampleDay > start) start = firstSampleDay;
  const floor = addDays(to, -(maxDays - 1));
  if (floor > start) start = floor;
  return { from: start, clamped: start !== from, empty: start > to };
}

// The bucket the user asked for if it is legal for the span, else the automatic one.
export const seriesBucket = (range) => (legalSeriesBuckets(range.days).includes(range.b) ? range.b : autoSeriesBucket(range.days));
export const energyBucket = (range) => (legalEnergyBuckets(range.days).includes(range.b) ? range.b : autoEnergyBucket(range.days, range.r === 'all'));

// Where the present flow takes the battery, and how long it would take at this rate. Giving power: down to the
// minimum charge. Charging from the grid (buying while the sun covers less than the charge): up to the grid-charge
// cutoff, where the grid stops. Charging from the sun: up to the end-of-charge level (100 % when unknown).
// { kind: 'min' | 'grid' | 'sun', target, hours } or null (idle, unknown, already there, or over 48 hours).
const ACTIVE_KW = 0.05;
export function chargeEta(rt, b = {}) {
  const soc = rt?.soc;
  const bat = rt?.battery_kw;
  if (soc == null || bat == null || !(b.capacityKwh > 0) || Math.abs(bat) <= ACTIVE_KW) return null;
  const fromGrid = bat > 0 && (rt.grid_kw ?? 0) > ACTIVE_KW && (rt.pv_kw ?? 0) < bat;
  const kind = bat < 0 ? 'min' : fromGrid && b.gridChargeCutoffPct != null ? 'grid' : 'sun';
  const target = kind === 'min' ? b.minPct ?? 0 : kind === 'grid' ? b.gridChargeCutoffPct : b.endOfChargePct ?? 100;
  if (kind === 'min' ? soc <= target : soc >= target) return null;
  const hours = ((Math.abs(target - soc) / 100) * b.capacityKwh) / Math.abs(bat);
  return hours > 48 ? null : { kind, target, hours };
}

// Equivalent full cycles: discharged energy over capacity. null without both.
export const cycles = (dischargeKwh, capacity) => (dischargeKwh == null || !(capacity > 0) ? null : dischargeKwh / capacity);

// Discharged over charged, as a percentage. Only meaningful from a week on: a short range mostly reflects the state of charge at its ends.
export const roundTrip = (charge, discharge, days) => (days < 7 || charge == null || discharge == null || !(charge > 0) ? null : (discharge / charge) * 100);

// Days whose lowest reading came within one point of the minimum charge; null when nothing is known.
export function daysAtMin(socMin, minPct) {
  if (minPct == null) return null;
  const known = socMin.filter((v) => v != null);
  return known.length ? known.filter((v) => v <= minPct + 1).length : null;
}

// Hours spent below the reserve: only buckets that hold a reading count (a gap is not time below).
// times/sinceMs: the reserve exists from sinceMs on; buckets before it are not counted.
export function hoursBelow(series, reserve, bucketMs, times = null, sinceMs = null) {
  if (reserve == null) return null;
  const known = series.filter((v, i) => v != null && (sinceMs == null || times[i] >= sinceMs));
  return known.length ? (known.filter((v) => v < reserve).length * bucketMs) / 3600e3 : null;
}

// How to draw the reserve on a time chart whose buckets start at `times`: the reserve exists from sinceMs on.
// 'all': a reference line; 'none': the range is before it; 'part': a line that starts at sinceMs (data: [ms, pct|null]).
export function reserveMarks(pct, sinceMs, times) {
  if (pct == null || !times.length) return { mode: 'none' };
  if (sinceMs == null || times[0] >= sinceMs) return { mode: 'all' };
  if (times.at(-1) < sinceMs) return { mode: 'none' };
  return { mode: 'part', data: times.map((ms) => [ms, ms >= sinceMs ? pct : null]) };
}
