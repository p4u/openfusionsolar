// Alert engine. evaluate() and schedule() are pure; createAlertEngine() builds snapshots from the store,
// logs every alert to alert_log, sends email and keeps the state in alert_state so restarts never repeat one.
import { buildEvents, classify } from './events.js';
import { localDay, dayBounds, shiftDay } from './collector.js';
import * as aggregate from './aggregate.js';
import { period } from './tariff.js';
import { render } from './alert-texts.js';
import { GROUPS, DEFAULT_ON } from '../public/js/alert-catalogue.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const NO_DATA_LAG_MS = 10 * MIN; // samples normally land within 10 min; older than that counts as missing
const CAP_PER_HOUR = 10;
export const QUEUE_MAX = 100; // quiet-hours queue; the oldest entries are dropped (they stay in the history)
const RETRY_PER_RUN = 3;
const RETRY_WINDOW_MS = 24 * HOUR;
const KEEP_MS = 72 * HOUR; // ended incidents leave the 48 h snapshot window well before their state is dropped
const backoff = (n) => Math.min(2 ** n, 60) * MIN; // 2, 4, 8 ... 60 min between retries of a failed email

const CUT_MIN_MS = 2 * MIN; // cut alarms that clear within seconds are blips, not cuts
const CUT_TAIL_MS = 30 * MIN; // a cut alarm can clear before the grid is really back
const NEAR_LIMIT = 0.9; // grid draw before a cut above this share of the contracted power: the limiter probably tripped
export const MAX_RECIPIENTS = 20;

export { DEFAULT_ON };
export const RULES = ['noData', 'gridCut', 'batteryLowInCut', 'backupOverload', 'collectorDown', 'belowReserve', 'panelsStopped',
  'deviceAlarm', 'powerLimit', 'weeklySummary', 'dailySummary', 'monthlyReport'];
export const RETIRED = ['batteryLow']; // accepted in stored configs and dropped without an error
const REPORTS = GROUPS.reports;
const MERGED = ['gridCut', 'backupOverload']; // events merged from several alarms: their start can move earlier

const rule = (id, params, o = {}) => ({
  id, enabled: true, params, bypassQuiet: false, notifyResolved: true, repeatHours: 24, cooldownMin: 60, ...o,
});
// recipients: [{ email, lang, alerts: [rule id] }]; everything else is global.
export const DEFAULT_CONFIG = {
  v: 1,
  recipients: [],
  lang: 'ca',
  quiet: { from: '22:00', to: '08:00' },
  rules: [
    rule('noData', { minutes: 720 }),
    rule('gridCut', {}, { bypassQuiet: true, repeatHours: 0 }),
    rule('batteryLowInCut', { soc: 20 }, { bypassQuiet: true }),
    rule('backupOverload', {}, { bypassQuiet: true }),
    rule('collectorDown', { minutes: 60 }),
    rule('belowReserve', { margin: 5, minutes: 180 }, { repeatHours: 72 }),
    rule('panelsStopped', {}),
    rule('deviceAlarm', { maxSeverity: 2 }),
    rule('powerLimit', { overPct: 0 }),
    rule('weeklySummary', { time: '08:00' }),
    rule('dailySummary', { time: '21:00' }, { enabled: false }),
    rule('monthlyReport', { time: '08:00' }),
  ],
};

// ---- configuration ----

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/; // \s also rules out CR/LF
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);
const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `integer from ${min} to ${max}`);
const bool = (v) => (typeof v === 'boolean' ? null : 'true or false');
const time = (v) => (typeof v === 'string' && HHMM.test(v) ? null : 'HH:MM');
const FIELDS = { enabled: bool, bypassQuiet: bool, notifyResolved: bool, repeatHours: int(0, 720), cooldownMin: int(0, 1440) };
const PARAMS = { minutes: int(5, 1440), soc: int(1, 100), maxSeverity: int(1, 4), margin: int(0, 50), overPct: int(0, 100), time };
const LANGS = ['ca', 'en'];

// Missing fields and rules take their defaults; unknown keys are dropped. Also the migration of older configs:
// a recipient given as a plain address (and ALERT_TO) gets the config language and the default-ON alerts.
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields: { '': 'object required' } };
  const fields = {};
  const check = (path, err) => {
    if (err) fields[path] = err;
  };
  const d = DEFAULT_CONFIG;
  const lang = input.lang ?? d.lang;
  check('lang', LANGS.includes(lang) ? null : 'ca or en');
  const given = input.recipients ?? d.recipients;
  let recipients = [];
  if (!Array.isArray(given) || given.length > MAX_RECIPIENTS) check('recipients', `up to ${MAX_RECIPIENTS} email addresses`);
  else {
    const seen = new Set();
    recipients = given.map((r, i) => {
      const o = typeof r === 'string' ? { email: r } : r && typeof r === 'object' && !Array.isArray(r) ? r : {};
      const key = String(o.email).toLowerCase();
      check(`recipients.${i}`, !isEmail(o.email) ? 'invalid email address' : seen.has(key) ? 'duplicate email address' : null);
      seen.add(key);
      const rl = o.lang ?? (LANGS.includes(lang) ? lang : d.lang);
      check(`recipients.${i}.lang`, LANGS.includes(rl) ? null : 'ca or en');
      let alerts = o.alerts ?? DEFAULT_ON;
      if (!Array.isArray(alerts)) {
        check(`recipients.${i}.alerts`, 'list of alerts');
        alerts = [];
      }
      alerts = [...new Set(alerts.filter((id) => !RETIRED.includes(id)))];
      if (alerts.some((id) => !RULES.includes(id))) check(`recipients.${i}.alerts`, 'unknown alert');
      return { email: o.email, lang: rl, alerts };
    });
  }
  const quiet = { ...d.quiet, ...(typeof input.quiet === 'object' && input.quiet) };
  for (const k of ['from', 'to']) check(`quiet.${k}`, time(quiet[k]));
  const givenRules = input.rules ?? [];
  if (!Array.isArray(givenRules)) check('rules', 'list of rules');
  const byId = new Map((Array.isArray(givenRules) ? givenRules : []).filter((r) => r && typeof r === 'object').map((r) => [String(r.id), r]));
  for (const id of byId.keys()) if (!RULES.includes(id) && !RETIRED.includes(id)) check(`rules.${id}`, 'unknown rule');
  const rules = d.rules.map((def) => {
    const r = byId.get(def.id) ?? {};
    const out = { id: def.id, params: {} };
    for (const [k, valid] of Object.entries(FIELDS)) {
      out[k] = r[k] ?? def[k];
      check(`rules.${def.id}.${k}`, valid(out[k]));
    }
    for (const [k, dv] of Object.entries(def.params)) {
      out.params[k] = r.params?.[k] ?? dv;
      check(`rules.${def.id}.params.${k}`, PARAMS[k](out.params[k]));
    }
    return out;
  });
  if (Object.keys(fields).length) return { fields };
  return { config: { v: 1, recipients, lang, quiet: { from: quiet.from, to: quiet.to }, rules } };
}

// ---- evaluation (pure) ----

const minutesOf = (hhmm) => hhmm.split(':').map(Number).reduce((h, m) => h * 60 + m);
const atTime = (day, hhmm) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, 0, minutesOf(hhmm)).getTime();
};

// Reports due now: { weeklySummary: Monday 'YYYY-MM-DD' of the week to report, dailySummary: 'YYYY-MM-DD',
// monthlyReport: 'YYYY-MM' (the month to report) }.
// Sent once per period at or after their time, never for a time before the engine was first armed.
export function dueReports(config, state, now) {
  const meta = state?._meta ?? {};
  const today = localDay(now);
  const [y, m] = today.split('-').map(Number);
  const monday = shiftDay(today, -((new Date(now).getDay() + 6) % 7));
  const plan = {
    weeklySummary: [shiftDay(monday, -7), monday],
    dailySummary: [today, today],
    monthlyReport: [localDay(new Date(y, m - 2, 1).getTime()).slice(0, 7), `${today.slice(0, 7)}-01`],
  };
  const due = {};
  for (const r of config.rules) {
    if (!REPORTS.includes(r.id) || !r.enabled) continue;
    const [period, day] = plan[r.id];
    const when = atTime(day, r.params.time);
    if (now >= when && when >= (meta.armedAt ?? now) && meta.reports?.[r.id] !== period) due[r.id] = period;
  }
  return due;
}

// Contracted power (kW) at a time: 2.0TD P1 covers the peak and standard periods, P2 the off-peak one.
const contractedAt = (ts, c) => (c ? (period(ts) === 'p3' ? c.p2 : c.p1) ?? null : null);
const cutOngoing = (s) => s.events.some((e) => e.kind === 'gridCut' && e.ongoing);

// Incidents per rule: { key, ongoing, since, end, hold?, facts }. Single-key rules return [] when the condition is false,
// null when it cannot be known now (the state is then left as it is). hold (ms) overrides the rule's `minutes`.
const eventIncidents = (snap, kind, id, extra = () => ({})) => snap.events.filter((e) => e.kind === kind).map((e) => ({
  key: `${id}:${e.start}`, ongoing: e.ongoing, since: e.start, end: e.end,
  facts: { start: e.start, ...(!e.ongoing && { end: e.end }), ...(e.batteryCovered !== undefined && { batteryCovered: e.batteryCovered }), ...extra(e) },
}));
const INCIDENTS = {
  // only while the collector works: when it cannot read FusionSolar, collectorDown speaks instead
  noData: (s, p, now) => {
    if (s.authBlocked || s.collector?.lastError) return null;
    if (s.lastSampleTs == null || now - s.lastSampleTs < NO_DATA_LAG_MS) return [];
    const network = s.events.find((e) => e.kind === 'network' && e.ongoing)?.start;
    return [{ key: 'noData', ongoing: true, since: s.lastSampleTs, facts: { since: s.lastSampleTs, ...(network != null && { network }) } }];
  },
  gridCut: (s) => eventIncidents(s, 'gridCut', 'gridCut', (e) => {
    const limit = contractedAt(e.start, s.contracted);
    const before = (s.samples ?? []).filter((r) => r.ts >= e.start - 10 * MIN && r.ts <= e.start && r.grid_kw != null);
    const limiter = limit != null && before.some((r) => r.grid_kw > NEAR_LIMIT * limit);
    return { ...(s.soc != null && { soc: s.soc }), ...(limiter && { limiter }) };
  }).map((i) => ({ ...i, hold: CUT_MIN_MS })),
  backupOverload: (s) => eventIncidents(s, 'overload', 'backupOverload'),
  // a cut alarm may clear before the grid is back: the 30 minutes after it count too, until a grid reading arrives
  batteryLowInCut: (s, p, now) => {
    const lastGrid = (s.samples ?? []).findLast((r) => r.grid_kw != null)?.ts ?? -Infinity;
    const inCut = s.events.some((e) => e.kind === 'gridCut' && (e.ongoing || (now - e.end < CUT_TAIL_MS && lastGrid <= e.end)));
    if (!(s.soc != null && s.soc < p.soc && inCut)) return [];
    const leftMin = s.capacityKwh > 0 && s.loadKw > 0.05 ? Math.round((s.capacityKwh * s.soc) / 100 / s.loadKw * 6) * 10 : null;
    return [{ key: 'batteryLowInCut', ongoing: true, facts: { soc: s.soc, threshold: p.soc, ...(leftMin && { leftMin }) } }];
  },
  collectorDown: (s, p, now) => {
    const err = s.collector?.lastError ?? null;
    if (s.authBlocked) return [{ key: 'collectorDown', ongoing: true, since: now, hold: 0, facts: { authBlocked: true, ...(err && { error: err.message }) } }];
    if (!err) return [];
    const since = s.collector.lastTick ?? err.at;
    return [{ key: 'collectorDown', ongoing: true, since, facts: { authBlocked: false, since, error: err.message } }];
  },
  belowReserve: (s, p) => {
    if (cutOngoing(s)) return null; // a cut empties the battery on purpose; batteryLowInCut covers it
    if (!(s.reservePct != null && s.soc != null && s.soc < s.reservePct - p.margin)) return [];
    const b = s.batteryConfig ?? {};
    const charge = b.chargeFromGrid === false ? { gridChargeOff: true }
      : b.gridChargeCutoffPct != null && b.gridChargeCutoffPct < s.reservePct ? { cutoffPct: b.gridChargeCutoffPct } : {};
    return [{ key: 'belowReserve', ongoing: true, facts: { soc: s.soc, reservePct: s.reservePct, ...charge } }];
  },
  // once per day: the key is the day, a second stop that day is the same incident
  panelsStopped: (s) => s.events.filter((e) => e.kind === 'noProduction').map((e) => ({
    key: `panelsStopped:${localDay(e.start)}`, ongoing: false, since: e.start, end: e.end, facts: { start: e.start, end: e.end },
  })),
  deviceAlarm: (s, p) => s.alarms
    .filter((a) => a.severity != null && a.severity <= p.maxSeverity && !['network', 'gridCut', 'batteryLow', 'overload'].includes(classify(a.name ?? '')))
    .map((a) => ({
      key: `deviceAlarm:${a.csn}`, ongoing: a.clear_utc == null, since: a.occur_utc, end: a.clear_utc,
      facts: {
        name: a.name ?? a.alarm_id, device: a.device_type ?? 'FusionSolar', severity: a.severity, start: a.occur_utc,
        ...(a.clear_utc != null && { end: a.clear_utc }),
      },
    })),
  // the first 5-minute reading of the day above the contracted power: at most one email a day
  powerLimit: (s, p) => {
    const out = new Map();
    for (const r of s.samples ?? []) {
      const limit = contractedAt(r.ts, s.contracted);
      const key = `powerLimit:${localDay(r.ts)}`;
      if (limit == null || !(r.grid_kw > limit * (1 + p.overPct / 100)) || out.has(key)) continue;
      out.set(key, { key, ongoing: false, since: r.ts, end: r.ts + 5 * MIN, facts: { ts: r.ts, kw: r.grid_kw, limit } });
    }
    return [...out.values()];
  },
};

// snapshot: { lastSampleTs, authBlocked, collector: { lastTick, lastError } | null, soc, batteryKw, loadKw, capacityKwh,
//   reservePct, batteryConfig, contracted: { p1, p2 } | null, events, alarms, samples (48 h), summary? }
// state: { [key]: { status: 'ok'|'pending'|'firing', since, firedAt, lastSentAt, silent, facts, at }, _meta }
export function evaluate(snapshot, config, prev, now) {
  const state = structuredClone(prev ?? {});
  const meta = (state._meta ??= {});
  meta.armedAt ??= now;
  meta.resolved ??= {};
  meta.reports ??= {};
  for (const k of Object.keys(state)) if (RETIRED.some((id) => k === id || k.startsWith(`${id}:`))) delete state[k];
  const actions = [];
  const due = dueReports(config, state, now);

  for (const rule of config.rules) {
    const own = (k) => k === rule.id || k.startsWith(`${rule.id}:`);
    const act = (key, event, facts, skip) => actions.push({
      rule: rule.id, key, event, facts, at: now, bypassQuiet: rule.bypassQuiet || REPORTS.includes(rule.id), ...(skip && { skip }),
    });
    const fire = (key, s, facts) => {
      const last = meta.resolved[rule.id];
      const cooling = last != null && now - last < rule.cooldownMin * MIN;
      Object.assign(s, { status: 'firing', firedAt: now, lastSentAt: now, silent: cooling, facts, at: now });
      act(key, 'fired', facts, cooling && 'cooldown');
    };
    const resolve = (key, s, facts) => {
      meta.resolved[rule.id] = now;
      const f = { ...s.facts, ...facts };
      if (rule.notifyResolved) act(key, 'resolved', f, s.silent && 'cooldown');
      if (key.includes(':')) Object.assign(s, { status: 'ok', facts: f, at: now });
      else delete state[key];
    };

    if (!rule.enabled) {
      for (const k of Object.keys(state)) if (own(k)) delete state[k];
      continue;
    }
    if (REPORTS.includes(rule.id)) {
      const facts = snapshot.summary?.[rule.id];
      if (due[rule.id] && facts) {
        meta.reports[rule.id] = due[rule.id];
        act(rule.id, 'report', facts);
      }
      continue;
    }

    const incidents = INCIDENTS[rule.id](snapshot, rule.params, now);
    if (!incidents) continue;
    const keys = new Set(incidents.map((i) => i.key));
    for (const inc of incidents) {
      // a late alarm moved a merged event's start: same incident, keep its state under the new key
      if (!state[inc.key] && MERGED.includes(rule.id)) {
        const old = Object.keys(state).find((k) => own(k) && !keys.has(k) && state[k].status !== 'pending'
          && state[k].facts?.start >= inc.since && state[k].facts?.start <= (inc.end ?? now));
        if (old) {
          state[inc.key] = state[old];
          delete state[old];
        }
      }
      let s = state[inc.key];
      if (inc.ongoing) {
        if (!s || s.status === 'ok') s = state[inc.key] = { status: 'pending', since: inc.since ?? now, at: now };
        if (s.status === 'pending') {
          if (inc.since != null) s.since = inc.since;
          if (now - s.since >= (inc.hold ?? (rule.params.minutes ?? 0) * MIN)) fire(inc.key, s, { since: s.since, ...inc.facts });
        } else {
          s.facts = { ...s.facts, ...inc.facts };
          if (rule.repeatHours > 0 && now - s.lastSentAt >= rule.repeatHours * HOUR) {
            Object.assign(s, { lastSentAt: now, silent: false });
            act(inc.key, 'reminder', s.facts);
          }
        }
      } else if (!s) {
        // first seen already over: one past-tense email, unless it ended before the engine was armed (history)
        // or was shorter than the rule's hold (a blip)
        if (inc.end >= meta.armedAt && inc.end - inc.since >= (inc.hold ?? 0)) {
          s = state[inc.key] = { since: inc.since };
          fire(inc.key, s, { ...inc.facts, past: true });
          s.status = 'ok';
        }
      } else if (s.status === 'firing') resolve(inc.key, s, inc.facts);
      else if (s.status === 'pending') delete state[inc.key];
    }
    for (const k of Object.keys(state)) {
      if (!own(k) || keys.has(k)) continue;
      const s = state[k];
      if (s.status === 'firing') resolve(k, s, { end: s.facts?.end ?? now });
      else if (s.status === 'pending' || now - s.at > KEEP_MS) delete state[k];
    }
  }
  return { state, actions };
}

// ---- scheduling (pure): quiet hours, digest, hourly cap ----

function inQuiet(now, quiet) {
  if (!quiet || quiet.from === quiet.to) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const [f, t] = [minutesOf(quiet.from), minutesOf(quiet.to)];
  return f < t ? m >= f && m < t : m >= f || m < t;
}

// deliveries: actions plus { delivery: 'send'|'queued'|'skipped', reason? }, and { rule: 'digest', items } at quiet end.
export function schedule(actions, config, prev, now) {
  const state = structuredClone(prev ?? {});
  const meta = (state._meta ??= {});
  meta.queue ??= [];
  meta.sent = (meta.sent ?? []).filter((t) => now - t < HOUR);
  const deliveries = [];
  const add = (d) => {
    if (d.delivery === 'send') {
      if (meta.sent.length >= CAP_PER_HOUR) Object.assign(d, { delivery: 'skipped', reason: 'rateLimit' });
      else meta.sent.push(now);
    }
    deliveries.push(d);
  };
  const quiet = inQuiet(now, config.quiet);
  if (!quiet && meta.queue.length) {
    add({ rule: 'digest', key: 'digest', event: 'digest', items: meta.queue, at: now, delivery: 'send' });
    meta.queue = [];
  }
  for (const a of actions) {
    if (a.skip) add({ ...a, delivery: 'skipped', reason: a.skip });
    else if (quiet && !a.bypassQuiet) {
      meta.queue.push(a);
      add({ ...a, delivery: 'queued' });
      while (meta.queue.length > QUEUE_MAX) add({ ...meta.queue.shift(), delivery: 'skipped', reason: 'queueFull' });
    } else add({ ...a, delivery: 'send' });
  }
  return { state, deliveries };
}

// ---- engine ----

export function createAlertEngine({ store, collector = null, appConfig = {}, transport = null, now = Date.now, log = console.log }) {
  let state = Object.fromEntries(store.getAlertState());
  let chain = Promise.resolve();
  let timer = null;
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  let saved = JSON.stringify(state);
  // only write when something changed: runOnce runs every minute and on every collector tick
  const save = () => {
    const next = JSON.stringify(state);
    if (next === saved) return;
    store.saveAlertState(new Map(Object.entries(state)));
    saved = next;
  };
  const meta = () => (state._meta ??= {});

  // ALERT_TO until the first save: each address in the config language with the default-ON alerts
  const defaults = () => {
    const seen = new Set();
    const to = String(appConfig.alertTo ?? '').split(',').map((x) => x.trim())
      .filter((x) => isEmail(x) && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, MAX_RECIPIENTS);
    return validateConfig({ recipients: to }).config;
  };
  const config = () => {
    const stored = store.getKv('alertsConfig');
    return (stored && validateConfig(stored).config) || defaults();
  };
  const contracted = () => {
    const c = appConfig.power ?? { p1: appConfig.prices?.contractedP1 || null, p2: appConfig.prices?.contractedP2 || null };
    return c.p1 > 0 || c.p2 > 0 ? c : null;
  };
  const textOpts = () => ({ plantName: appConfig.plantName ?? store.getKv('station')?.name ?? null, appUrl: appConfig.appUrl || null });
  const capFull = (t) => (meta().sent ?? []).filter((x) => t - x < HOUR).length >= CAP_PER_HOUR;
  const countSend = (t) => {
    meta().sent = [...(meta().sent ?? []).filter((x) => t - x < HOUR), t];
  };
  const deliver = (to, msg) => transport.send({ to: to.join(', '), ...msg });
  const subscribed = (cfg, rule) => cfg.recipients.filter((r) => rule === 'digest' || r.alerts.includes(rule));

  // One email per language, and for the digest per set of items: [{ lang, to: [email], d }]. Empty: nobody subscribed.
  function envelopes(cfg, d) {
    const groups = new Map();
    for (const r of cfg.recipients) {
      const items = d.rule === 'digest' ? d.items.filter((i) => r.alerts.includes(i.rule)) : null;
      if (items ? !items.length : !r.alerts.includes(d.rule)) continue;
      const k = `${r.lang}|${items ? items.map((i) => d.items.indexOf(i)).join(',') : ''}`;
      if (!groups.has(k)) groups.set(k, { lang: r.lang, to: [], d: items ? { ...d, items } : d });
      groups.get(k).to.push(r.email);
    }
    return [...groups.values()];
  }

  const INCIDENT_KINDS = ['gridCut', 'overload', 'noProduction'];
  const incidents = (from, to, t) => buildEvents(store.alarms(from, to), store.samples(from, to), Math.min(to, t))
    .filter((e) => !['network', 'other'].includes(e.kind));

  // Week, day and month totals, only computed when a report is due.
  function summaries(t, cfg) {
    const due = dueReports(cfg, state, t);
    const out = {};
    if (due.weeklySummary) {
      const from = due.weeklySummary;
      const to = shiftDay(from, 6);
      const [a, b] = [dayBounds(from)[0], dayBounds(to)[1]];
      const e = aggregate.energy(store, { from, to, bucket: '1d', prices: appConfig.prices, now: t });
      const peak = store.samples(a, b).reduce((m, r) => (r.grid_kw > (m?.grid_kw ?? 0) ? r : m), null);
      out.weeklySummary = {
        from, to, pv: e.total.pv_kwh, load: e.total.load_kwh, imp: e.total.import_kwh, exp: e.total.export_kwh,
        cost: e.total.money?.energy ?? null,
        incidents: incidents(a, b, t).filter((x) => INCIDENT_KINDS.includes(x.kind)).reverse()
          .map((x) => ({ kind: x.kind, start: x.start, end: x.end })),
        peakKw: peak?.grid_kw ?? null, peakTs: peak?.ts ?? null, contractedKw: peak ? contractedAt(peak.ts, contracted()) : null,
      };
    }
    if (due.dailySummary) {
      const day = due.dailySummary;
      const b = aggregate.energy(store, { from: day, to: day, bucket: '1d', prices: appConfig.prices, now: t }).buckets[0];
      out.dailySummary = {
        day, pv: b.pv_kwh, load: b.load_kwh, imp: b.import_kwh, exp: b.export_kwh, cost: b.money?.energy ?? null,
        incidents: incidents(...dayBounds(day), t).length,
      };
    }
    if (due.monthlyReport) {
      const month = due.monthlyReport;
      const [y, m] = month.split('-').map(Number);
      const from = `${month}-01`;
      const to = localDay(new Date(y, m, 0).getTime());
      const e = aggregate.energy(store, { from, to, bucket: '1mo', compare: 'yoy', prices: appConfig.prices, now: t });
      const c = e.compare;
      out.monthlyReport = {
        month, pv: e.total.pv_kwh, load: e.total.load_kwh, imp: e.total.import_kwh, exp: e.total.export_kwh,
        bill: e.total.money?.bill ?? null, savings: e.total.money?.savings ?? null,
        incidents: incidents(dayBounds(from)[0], dayBounds(to)[1], t).length,
        yoy: c?.comparable ? { pv: c.total.pv_kwh, load: c.total.load_kwh, bill: c.total.money?.bill ?? null } : null,
      };
    }
    return out;
  }

  function snapshot(t, cfg) {
    const from = t - 48 * HOUR;
    const alarms = [...new Map([...store.alarms(from, t + 1), ...store.activeAlarms()].map((a) => [a.csn, a])).values()];
    const samples = store.samples(from, t + 1);
    const sample = samples.findLast((s) => s.soc != null || s.battery_kw != null);
    const rt = store.latestRealtime();
    const live = rt && (!sample || rt.ts >= sample.ts) ? rt : sample;
    return {
      lastSampleTs: store.lastSampleTs(),
      authBlocked: Boolean(collector && t < (collector.authBlockedUntil ?? 0)),
      collector: collector?.status ? { lastTick: collector.status.lastTick, lastError: collector.status.lastError } : null,
      soc: live?.soc ?? null,
      batteryKw: live?.battery_kw ?? null,
      loadKw: live?.load_kw ?? null,
      capacityKwh: appConfig.battery?.capacityKwh ?? store.getKv('station')?.batteryKwh ?? null,
      reservePct: appConfig.battery?.reservePct ?? null,
      batteryConfig: store.getKv('batteryConfig'),
      contracted: contracted(),
      events: buildEvents(alarms, samples, t),
      alarms,
      samples,
      summary: summaries(t, cfg),
    };
  }

  // Failed emails of the last 24 h, oldest first, at most 3 per run, with growing pauses; they count in the cap.
  // A retry goes to the addresses of the first attempt (rows from before per-recipient alerts: today's subscribers).
  async function retryFailed(t, cfg) {
    const failed = store.failedAlerts(t - RETRY_WINDOW_MS);
    const prev = meta().retry ?? {};
    const retry = (meta().retry = Object.fromEntries(failed.filter((r) => prev[r.id]).map((r) => [r.id, prev[r.id]])));
    let n = 0;
    for (const row of failed) {
      if (n >= RETRY_PER_RUN || capFull(t)) break;
      const to = row.recipients ?? subscribed(cfg, row.rule).map((r) => r.email);
      const r = retry[row.id] ?? { n: 0, next: 0 };
      if (t < r.next || !to.length) continue;
      n++;
      countSend(t);
      try {
        await deliver(to, { subject: row.title, text: row.body });
        store.updateAlertLog(row.id, { delivery: 'sent' });
        delete retry[row.id];
        log(`alert sent on retry: ${row.title}`);
      } catch (err) {
        store.updateAlertLog(row.id, { delivery: 'failed', error: err.message });
        retry[row.id] = { n: r.n + 1, next: t + backoff(r.n + 1) };
      }
    }
  }

  async function runOnce() {
    const t = now();
    const cfg = config();
    if (transport) await retryFailed(t, cfg);
    const ev = evaluate(snapshot(t, cfg), cfg, state, t);
    // nobody subscribed: logged as skipped, never queued and never counted in the hourly cap
    for (const a of ev.actions) if (!a.skip && !subscribed(cfg, a.rule).length) a.skip = 'noRecipients';
    let deliveries;
    if (transport) ({ state, deliveries } = schedule(ev.actions, cfg, ev.state, t));
    else {
      state = ev.state;
      deliveries = ev.actions.map((a) => ({ ...a, delivery: 'skipped', reason: a.skip ?? 'noSmtp' }));
    }
    const opts = textOpts();
    const outgoing = [];
    for (const d of deliveries) {
      const groups = d.delivery === 'send' ? envelopes(cfg, d) : [];
      if (d.delivery === 'send' && !groups.length) Object.assign(d, { delivery: 'skipped', reason: 'noRecipients' });
      if (d.delivery !== 'send') {
        const msg = render(cfg.lang, d, opts);
        store.logAlert({ ts: t, rule: d.rule, event: d.event, title: msg.subject, body: msg.text, delivery: d.delivery, reason: d.reason ?? null });
        log(`alert ${d.rule} ${d.event}: ${d.delivery === 'skipped' ? `not sent (${d.reason})` : d.delivery}`);
        continue;
      }
      // one row per email; logged as failed until the send succeeds, so an email cut short by a restart is retried
      for (const g of groups) {
        const msg = render(g.lang, g.d, opts);
        const id = store.logAlert({
          ts: t, rule: d.rule, event: d.event, title: msg.subject, body: msg.text, delivery: 'failed', error: 'not sent yet',
          recipients: g.to, lang: g.lang,
        });
        outgoing.push([id, g.to, msg]);
      }
    }
    save(); // before sending: a crash mid-send must not fire the same alerts again
    for (const [id, to, msg] of outgoing) {
      try {
        await deliver(to, msg);
        store.updateAlertLog(id, { delivery: 'sent' });
        log(`alert sent: ${msg.subject}`);
      } catch (err) {
        store.updateAlertLog(id, { delivery: 'failed', error: err.message });
        (meta().retry ??= {})[id] = { n: 1, next: t + backoff(1) };
        log(`alert email failed: ${err.message}`);
      }
    }
    if (outgoing.length) save();
  }

  const run = () => serial(runOnce);
  // unavailable: rules hidden in Settings because the .env lacks what they need
  const getConfig = () => ({
    smtp: { configured: Boolean(transport), host: appConfig.smtp?.host ?? null, from: appConfig.smtp?.from ?? null },
    unavailable: contracted() ? [] : ['powerLimit'],
    ...config(),
  });
  return {
    run,
    start() {
      timer ??= setInterval(() => run().catch((err) => log(`alerts error: ${err.message}`)), MIN);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    status: () => ({ smtpConfigured: Boolean(transport), firing: Object.keys(state).filter((k) => state[k]?.status === 'firing') }),
    getConfig,
    setConfig(input) {
      const r = validateConfig(input);
      if (r.fields) return r;
      store.setKv('alertsConfig', r.config);
      return { config: getConfig() };
    },
    // Counts toward the hourly cap; the error text is the transport's own (never contains credentials).
    // In the language given, else the recipient's, else the config's.
    sendTest: (to, lang) => serial(async () => {
      const cfg = config();
      const addr = to ?? cfg.recipients[0]?.email;
      if (!transport) return { ok: false, error: 'email is not set up' };
      if (!isEmail(addr)) return { ok: false, error: addr == null ? 'no recipient' : 'invalid email address' };
      const t = now();
      if (capFull(t)) return { ok: false, error: `rate limit: ${CAP_PER_HOUR} emails per hour` };
      countSend(t);
      save();
      try {
        const own = cfg.recipients.find((r) => r.email.toLowerCase() === addr.toLowerCase());
        const l = LANGS.includes(lang) ? lang : own?.lang ?? cfg.lang;
        await transport.send({ to: addr, ...render(l, { rule: 'test', event: 'test', at: t }, textOpts()) });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }),
    history: ({ limit = 50, before } = {}) => store.alertLog({ limit, before }),
  };
}
