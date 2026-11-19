// Pure helpers of the Energy view (no DOM, runs under Node). Energy buckets carry pv_kwh, load_kwh, import_kwh, export_kwh.
import { register, t } from '../i18n.js';
import dict from '../i18n/energy.js';
import { delta } from '../format.js';
import { legalSeriesBuckets, addDays } from '../buckets.js';
import { rangeLabel } from '../range.js';

register(dict);

const num = (v) => typeof v === 'number' && Number.isFinite(v);
// whole percent of part in total, clamped to 0..100; null when it cannot be known
const share = (part, total) => (num(part) && num(total) && total > 0 ? Math.min(100, Math.max(0, Math.round((part / total) * 100))) : null);

// Where consumption came from and where solar went, in whole percent that add up to 100 (null when unknown).
export function shares(total) {
  const grid = share(total?.import_kwh, total?.load_kwh);
  const sold = share(total?.export_kwh, total?.pv_kwh);
  return {
    consumption: { solar: grid == null ? null : 100 - grid, grid },
    solar: { home: sold == null ? null : 100 - sold, sold },
  };
}

const REASONS = { beforeFirstDay: 'energy.cmp.beforeFirstDay', lowCoverage: 'energy.cmp.lowCoverage' };

// cmp: { value, comparable, reason, label } for the comparison period, or null when none is chosen.
export function deltaText(cur, cmp) {
  if (!cmp) return null;
  if (!cmp.comparable) return t('energy.cmp.notComparable', { reason: t(REASONS[cmp.reason] ?? 'energy.cmp.other') });
  const d = delta(cur, cmp.value);
  return d.pct == null ? t('energy.cmp.noBase', { label: cmp.label }) : t('energy.cmp.vs', { delta: d.text, label: cmp.label });
}

// Bars of the diverging chart: above zero home-from-solar + bought, below zero sold (negative).
export function energyBars(buckets) {
  const col = (f) => buckets.map(f);
  return {
    home_solar: col((b) => (num(b.load_kwh) && num(b.import_kwh) ? Math.max(b.load_kwh - b.import_kwh, 0) : null)),
    bought: col((b) => (num(b.import_kwh) ? b.import_kwh : null)),
    sold: col((b) => (num(b.export_kwh) ? (b.export_kwh === 0 ? 0 : -b.export_kwh) : null)),
    produced: col((b) => (num(b.pv_kwh) ? b.pv_kwh : null)),
  };
}

// Power lines need a bucket of 1 hour or finer.
export const powerAllowed = (days) => legalSeriesBuckets(days).some((b) => ['5m', '15m', '1h'].includes(b));

// Label of the comparison period: a whole calendar month or year reads as such.
export function compareLabel(c, locale) {
  const month = c.from.slice(8) === '01' && addDays(c.to, 1).slice(8) === '01' && c.from.slice(0, 7) === c.to.slice(0, 7);
  const year = c.from.slice(5) === '01-01' && c.to.slice(5) === '12-31' && c.from.slice(0, 4) === c.to.slice(0, 4);
  const r = month ? 'month' : year ? 'year' : 'custom';
  return rangeLabel({ r, d: month ? c.from.slice(0, 7) : year ? c.from.slice(0, 4) : null, from: c.from, to: c.to }, locale);
}
