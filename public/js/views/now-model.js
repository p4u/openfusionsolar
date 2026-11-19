// Pure helpers of the Now view (no DOM): the status headline, the flow links and the battery autonomy.
import { t } from '../i18n.js';
import { fmtTime, duration, kwh, pct, eur } from '../format.js';
import { eventTitle } from '../incidents.js';

export const STALE_MS = 20 * 60e3;
const DAY = 24 * 3600e3;
const ACTIVE_KW = 0.05; // below this a battery counts as idle
const LEVEL = { ok: 0, info: 1, waiting: 2, warn: 2, alarm: 3 };

// Below the power-cut reserve, what refills the battery: { key, vars }, or null when it is not below the reserve.
// When the grid stops charging below the reserve (cutoff < reserve), only the sun fills the rest: say so, promise nothing.
export function reserveNote(soc, bat = {}) {
  if (soc == null || bat.reservePct == null || soc >= bat.reservePct) return null;
  const vars = { soc: Math.round(soc), reserve: bat.reservePct, cutoff: bat.gridChargeCutoffPct };
  if (bat.chargeFromGrid === false) return { key: 'sunOnly', vars };
  if (bat.chargeFromGrid && bat.gridChargeCutoffPct != null && bat.gridChargeCutoffPct < bat.reservePct) {
    return { key: soc >= bat.gridChargeCutoffPct ? 'gridStops' : 'gridUntil', vars };
  }
  return { key: 'plain', vars };
}

// The first line answers "do I need to act?". Returns the most serious candidate: { state, key, vars }.
// The view shows t(`${key}.title`) as the short headline and t(key, vars) as the sentence below it.
export function headline(status, events = [], now = Date.now()) {
  const last = status?.lastSampleTs;
  const rt = status?.realtime;
  const bat = status?.battery ?? {};
  const found = [];
  const ongoing = events.filter((e) => e.ongoing && !['network', 'noProduction', 'noData'].includes(e.kind)); // no data: the stale line says it
  if (ongoing.some((e) => e.kind === 'gridCut')) found.push({ state: 'alarm', key: 'now.head.cut', vars: {} });
  else if (ongoing.length) found.push({ state: 'alarm', key: 'now.head.alarm', vars: { names: [...new Set(ongoing.map(eventTitle))].join(', ') } });
  if (!last) found.push({ state: 'waiting', key: 'now.head.waiting', vars: {} });
  else if (now - last > STALE_MS) found.push({ state: 'warn', key: 'now.head.stale', vars: { time: fmtTime(last), ago: duration(now - last) } });
  const stops = events.filter((e) => e.kind === 'noProduction');
  const stopped = stops.filter((e) => e.end > now - DAY).reduce((a, e) => a + e.end - e.start, 0);
  if (stopped) found.push({ state: 'warn', key: stops.length > 1 ? 'now.head.stoppedRepeat' : 'now.head.stopped', vars: { d: duration(stopped), n: stops.length } });
  const note = reserveNote(rt?.soc, bat);
  if (note) {
    const recharging = (rt.battery_kw ?? 0) > ACTIVE_KW;
    const vars = { soc: note.vars.soc, reserve: note.vars.reserve };
    // above the grid-charge cutoff only the sun can refill it: expected, nothing to do
    if (!recharging && (note.key === 'gridStops' || note.key === 'sunOnly')) found.push({ state: 'info', key: `now.head.${note.key}`, vars: note.vars });
    else found.push({ state: recharging ? 'info' : 'warn', key: recharging ? 'now.head.recharging' : 'now.head.notRecharging', vars });
  }
  // the first candidate wins a tie, so a cut outranks everything else of the same level
  return found.reduce((a, b) => (LEVEL[b.state] > LEVEL[a.state] ? b : a), { state: 'ok', key: 'now.head.ok', vars: {} });
}

// Sign convention: grid_kw > 0 buys, < 0 sells; battery_kw > 0 charges, < 0 gives. Unknown readings draw as 0.
export function flow(rt) {
  const pv = rt?.pv_kw ?? 0;
  const load = rt?.load_kw ?? 0;
  const imp = Math.max(rt?.grid_kw ?? 0, 0);
  const exp = Math.max(-(rt?.grid_kw ?? 0), 0);
  const charge = Math.max(rt?.battery_kw ?? 0, 0);
  const give = Math.max(-(rt?.battery_kw ?? 0), 0);
  const surplus = Math.max(pv - load, 0);
  const pvBat = Math.min(surplus, charge);
  const all = [
    { from: 'pv', to: 'home', kw: Math.min(pv, load) },
    { from: 'pv', to: 'bat', kw: pvBat },
    { from: 'pv', to: 'grid', kw: Math.min(Math.max(surplus - pvBat, 0), exp) },
    { from: 'grid', to: 'home', kw: Math.max(load - Math.min(pv, load) - give, 0) },
    { from: 'grid', to: 'bat', kw: Math.max(charge - pvBat, 0) },
    { from: 'bat', to: 'home', kw: give },
  ];
  return { links: all.filter((l) => l.kw > 0.01), imp, exp, charge, give };
}

// Hours the battery could run the home at loadKw; null when the capacity or the charge is unknown, 0 when it is empty.
// minPct is the floor FusionSolar keeps (0 when it does not report one).
export function autonomyHours(soc, battery, loadKw) {
  if (soc == null || battery?.capacityKwh == null) return null;
  const usable = (Math.max(soc - (battery.minPct ?? 0), 0) / 100) * battery.capacityKwh;
  return usable < 0.1 ? 0 : usable / Math.max(loadKw ?? 0.3, 0.15);
}

// The "today so far" tiles: { icon, label, value, hint, status } for ui.ledger.
export function todayTiles(total, st) {
  const load = total.load_kwh;
  // before any sun today the share is not 0 % but not known yet
  const noSun = !(total.pv_kwh > 0.05);
  const self = !noSun && load && total.self_use_kwh != null ? Math.min(1, total.self_use_kwh / load) * 100 : null;
  const out = [
    { icon: 'sun', label: t('now.tiles.produced'), value: kwh(total.pv_kwh) },
    { icon: 'house', label: t('now.tiles.consumed'), value: kwh(load) },
    { icon: 'utility-pole', label: t('now.tiles.bought'), value: kwh(total.import_kwh) },
    { icon: 'zap', label: t('now.tiles.sold'), value: kwh(total.export_kwh) },
    { icon: 'battery-charging', label: t('now.tiles.stored'), value: kwh(total.charge_kwh), hint: t('now.tiles.storedHint') },
    { icon: 'battery-medium', label: t('now.tiles.taken'), value: kwh(total.discharge_kwh), hint: t('now.tiles.takenHint') },
    { icon: 'gauge', label: t('now.tiles.self'), value: self == null ? null : pct(self), hint: t(noSun ? 'now.tiles.selfNoSun' : 'now.tiles.selfHint') },
  ];
  const m = total.money;
  if (!st.pricesConfigured) out.push({ icon: 'euro', label: t('now.tiles.cost'), value: null, hint: t('now.tiles.noTariff') });
  else if (m) {
    out.push(m.energy < 0
      ? { icon: 'euro', label: t('now.tiles.earned'), value: eur(-m.energy), hint: t('now.tiles.earnedHint') }
      : { icon: 'euro', label: t('now.tiles.cost'), value: eur(m.energy), hint: t('now.tiles.costHint') });
    // before any sun today there is nothing saved yet: no tile; a negative figure never gets a check icon
    if (!noSun) out.push({ icon: m.savings < 0 ? 'euro' : 'check', label: t('now.tiles.savings'), value: eur(m.savings), hint: t(m.savings < 0 ? 'now.tiles.savingsNegative' : 'now.tiles.savingsHint'), status: m.savings < 0 ? undefined : 'ok' });
  }
  return out;
}
