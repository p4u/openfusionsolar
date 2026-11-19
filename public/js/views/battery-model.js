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
export const energyBucket = (range) => (legalEnergyBuckets(range.days).includes(range.b) ? range.b : autoEnergyBucket(range.days));

// Equivalent full cycles: discharged energy over capacity. null without both.
export const cycles = (dischargeKwh, capacity) => (dischargeKwh == null || !(capacity > 0) ? null : dischargeKwh / capacity);

// Discharged over charged, as a percentage. Only meaningful from a week on: a short range mostly reflects the state of charge at its ends.
export const roundTrip = (charge, discharge, days) => (days < 7 || charge == null || discharge == null || !(charge > 0) ? null : (discharge / charge) * 100);

// Days whose lowest reading came within one point of the end-of-discharge level; null when nothing is known.
export function daysAtMin(socMin, minPct) {
  if (minPct == null) return null;
  const known = socMin.filter((v) => v != null);
  return known.length ? known.filter((v) => v <= minPct + 1).length : null;
}

// Hours spent below the reserve: only buckets that hold a reading count (a gap is not time below).
export function hoursBelow(series, reserve, bucketMs) {
  if (reserve == null) return null;
  const known = series.filter((v) => v != null);
  return known.length ? (known.filter((v) => v < reserve).length * bucketMs) / 3600e3 : null;
}
