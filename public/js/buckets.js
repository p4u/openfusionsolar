// Bucket rules shared by the server and the browser. Pure and DOM-free; days are 'YYYY-MM-DD' strings
// and all day math is UTC string math, so it does not depend on the time zone.
export const MAX_BUCKETS = 750;
export const SERIES_BUCKETS = ['5m', '15m', '1h', '1d'];
export const ENERGY_BUCKETS = ['1d', '1mo', '1y'];

const toUtc = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day, n) => fromUtc(toUtc(day) + n * 86400e3);

// Moves by whole months and clamps to the end of the target month (2024-02-29 -12 months is 2023-02-28).
export function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
}

export const spanDays = (from, to) => Math.round((toUtc(to) - toUtc(from)) / 86400e3) + 1;

const PER_DAY = { '5m': 288, '15m': 96, '1h': 24, '1d': 1 };
const monthIndex = (day) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));

export function bucketCount(from, to, bucket) {
  if (bucket === '1mo') return monthIndex(to) - monthIndex(from) + 1;
  if (bucket === '1y') return Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + 1;
  return spanDays(from, to) * PER_DAY[bucket];
}

export function legalSeriesBuckets(n) {
  const out = [];
  if (n <= 2) out.push('5m');
  if (n <= 7) out.push('15m');
  if (n <= 45 && n * 24 <= MAX_BUCKETS) out.push('1h');
  if (n <= MAX_BUCKETS) out.push('1d');
  return out;
}

// Only n is known here, so months and years are counted for the worst alignment of n days.
export function legalEnergyBuckets(n) {
  const count = { '1d': n, '1mo': Math.ceil(n / 28) + 1, '1y': Math.ceil(n / 365) + 1 };
  return ENERGY_BUCKETS.filter((b) => count[b] <= MAX_BUCKETS);
}

export const autoSeriesBucket = (n) => (n <= 2 ? '5m' : n <= 7 ? '15m' : '1d');
export const autoEnergyBucket = (n) => (n <= 120 ? '1d' : n <= 1826 ? '1mo' : '1y');
export const defaultMode = (n) => (n <= 7 ? 'power' : 'energy');

export function compareDays(from, to, cmp) {
  if (cmp === 'yoy') return { from: addMonths(from, -12), to: addMonths(to, -12) };
  const n = spanDays(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}
