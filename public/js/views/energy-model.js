// Pure helpers of the Energy view (no DOM, runs under Node). Energy buckets carry pv_kwh, load_kwh, import_kwh, export_kwh.
import { register, t, getLang } from '../i18n.js';
import dict from '../i18n/energy.js';
import { delta } from '../format.js';
import { legalSeriesBuckets, addDays } from '../buckets.js';
import { rangeLabel } from '../range.js';

register(dict);

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// Whole percents of parts that add up to exactly 100 (largest remainder); nulls when the total is not positive.
export function percents(parts) {
  const total = parts.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return parts.map(() => null);
  const raw = parts.map((v) => (v / total) * 100);
  const out = raw.map(Math.floor);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < 100 - out.reduce((a, v) => a + v, 0); k++) out[order[k][1]] += 1;
  return out;
}

// Where the solar energy went (home, battery, sold) and where the home energy came from (solar, grid, battery), in
// whole percents adding up to 100, null when unknown. Day totals cannot say which kWh went where, so one rule keeps
// both bars consistent with the energy balance: the battery is charged by the sun first and by the grid for the
// rest; what the home used beyond the sun and the grid came from the battery. Huawei's self-use includes what the
// sun put in the battery; a self-use below pv minus sold also counts the difference as gone to the battery.
export function shares(total) {
  const pv = total?.pv_kwh;
  const load = total?.load_kwh;
  const imp = total?.import_kwh;
  const exp = num(total?.export_kwh) ? total.export_kwh : 0;
  const charge = num(total?.charge_kwh) ? total.charge_kwh : 0;
  const self = total?.self_use_kwh;
  const onsite = num(pv) ? Math.max(pv - exp, 0) : null;
  const solarBat0 = onsite == null ? 0 : Math.min(onsite, Math.max(charge, num(self) ? onsite - self : 0));
  const gridBat = Math.max(charge - solarBat0, 0);
  const gridHome = num(imp) && num(load) ? Math.min(Math.max(imp - gridBat, 0), load) : null;
  const solarHome = onsite == null ? null : Math.max(Math.min(onsite - solarBat0, num(load) ? load - (gridHome ?? 0) : Infinity), 0);
  const solarBat = onsite == null ? null : onsite - solarHome;
  const batHome = num(load) && gridHome != null ? Math.max(load - gridHome - (solarHome ?? 0), 0) : null;
  const solar = onsite == null || !num(pv) ? [null, null, null] : percents([solarHome, solarBat, Math.min(exp, pv)]);
  const home = gridHome == null ? [null, null, null] : percents([solarHome ?? 0, gridHome, batHome]);
  return {
    solar: { home: solar[0], battery: solar[1], sold: solar[2] },
    consumption: { solar: home[0], grid: home[1], battery: home[2] },
  };
}

const REASONS = { beforeFirstDay: 'energy.cmp.beforeFirstDay', lowCoverage: 'energy.cmp.lowCoverage' };

// Catalan joins "respecte" to a period with the right contraction: "del 17 de nov.", "d’octubre", "de març".
export function ofPeriod(label) {
  if (getLang() !== 'ca') return label;
  if (/^\d/.test(label)) return `del ${label}`;
  return /^[aeiouàèéíòóú]/i.test(label) ? `d’${label}` : `de ${label}`;
}

// cmp: { value, comparable, reason, label } for the comparison period, or null when none is chosen.
export function deltaText(cur, cmp) {
  if (!cmp) return null;
  if (!cmp.comparable) return t('energy.cmp.notComparable', { reason: t(REASONS[cmp.reason] ?? 'energy.cmp.other') });
  const d = delta(cur, cmp.value);
  return d.pct == null ? t('energy.cmp.noBase', { label: cmp.label }) : t('energy.cmp.vs', { delta: d.text, label: ofPeriod(cmp.label) });
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
