// Pure helpers of the Now view (no DOM): the status headline, the flow links and the battery autonomy.
import { fmtTime, duration } from '../format.js';
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
  const ongoing = events.filter((e) => e.ongoing && e.kind !== 'network' && e.kind !== 'noProduction');
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
