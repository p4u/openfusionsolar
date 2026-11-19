// Alert engine. evaluate() and schedule() are pure; createAlertEngine() builds snapshots from the store,
// logs every alert to alert_log, sends email and keeps the state in alert_state so restarts never repeat one.
import { buildEvents, classify } from './events.js';
import { localDay, dayBounds } from './collector.js';
import * as aggregate from './aggregate.js';
import { render } from './alert-texts.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const NO_DATA_LAG_MS = 10 * MIN; // samples normally land within 10 min; older than that counts as missing
const CAP_PER_HOUR = 10;
export const QUEUE_MAX = 100; // quiet-hours queue; the oldest entries are dropped (they stay in the history)
const RETRY_PER_RUN = 3;
const RETRY_WINDOW_MS = 24 * HOUR;
const KEEP_MS = 72 * HOUR; // ended incidents leave the 48 h snapshot window well before their state is dropped
const backoff = (n) => Math.min(2 ** n, 60) * MIN; // 2, 4, 8 ... 60 min between retries of a failed email

export const RULES = ['noData', 'gridCut', 'batteryLowInCut', 'batteryLow', 'belowReserve', 'panelsStopped', 'deviceAlarm',
  'dailySummary', 'monthlyReport'];
const REPORTS = ['dailySummary', 'monthlyReport'];
const MERGED = ['gridCut', 'batteryLow']; // events merged from several alarms: their start can move earlier

const rule = (id, params, o = {}) => ({
  id, enabled: true, params, bypassQuiet: false, notifyResolved: true, repeatHours: 24, cooldownMin: 60, ...o,
});
export const DEFAULT_CONFIG = {
  recipients: [],
  lang: 'ca',
  quiet: { from: '22:00', to: '08:00' },
  rules: [
    rule('noData', { minutes: 30 }),
    rule('gridCut', {}, { bypassQuiet: true }),
    rule('batteryLowInCut', { soc: 20 }, { bypassQuiet: true }),
    rule('batteryLow', {}),
    rule('belowReserve', { minutes: 30 }, { enabled: false }),
    rule('panelsStopped', {}),
    rule('deviceAlarm', { maxSeverity: 2 }),
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
const PARAMS = { minutes: int(5, 1440), soc: int(1, 100), maxSeverity: int(1, 4), time };

// Missing fields and rules take their defaults; unknown keys are dropped.
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields: { '': 'object required' } };
  const fields = {};
  const check = (path, err) => {
    if (err) fields[path] = err;
  };
  const d = DEFAULT_CONFIG;
  const recipients = input.recipients ?? d.recipients;
  if (!Array.isArray(recipients) || recipients.length > 10) check('recipients', 'up to 10 email addresses');
  else recipients.forEach((r, i) => check(`recipients.${i}`, isEmail(r) ? null : 'invalid email address'));
  const lang = input.lang ?? d.lang;
  check('lang', ['ca', 'en'].includes(lang) ? null : 'ca or en');
  const quiet = { ...d.quiet, ...(typeof input.quiet === 'object' && input.quiet) };
  for (const k of ['from', 'to']) check(`quiet.${k}`, time(quiet[k]));
  const given = input.rules ?? [];
  if (!Array.isArray(given)) check('rules', 'list of rules');
  const byId = new Map((Array.isArray(given) ? given : []).filter((r) => r && typeof r === 'object').map((r) => [String(r.id), r]));
  for (const id of byId.keys()) if (!RULES.includes(id)) check(`rules.${id}`, 'unknown rule');
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
  return { config: { recipients: [...recipients], lang, quiet: { from: quiet.from, to: quiet.to }, rules } };
}

// ---- evaluation (pure) ----

const minutesOf = (hhmm) => hhmm.split(':').map(Number).reduce((h, m) => h * 60 + m);
const atTime = (day, hhmm) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, 0, minutesOf(hhmm)).getTime();
};

// Reports due now: { dailySummary: 'YYYY-MM-DD', monthlyReport: 'YYYY-MM' (the month to report) }.
// Sent once per period at or after their time, never for a time before the engine was first armed.
export function dueReports(config, state, now) {
  const meta = state?._meta ?? {};
  const today = localDay(now);
  const [y, m] = today.split('-').map(Number);
  const plan = {
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

// Incidents per rule: { key, ongoing, since, end, facts }. Single-key rules return [] when the condition is false.
const eventIncidents = (snap, kind) => snap.events.filter((e) => e.kind === kind).map((e) => ({
  key: `${kind}:${e.start}`, ongoing: e.ongoing, since: e.start, end: e.end,
  facts: { start: e.start, ...(!e.ongoing && { end: e.end }), ...(e.batteryCovered !== undefined && { batteryCovered: e.batteryCovered }) },
}));
const INCIDENTS = {
  noData: (s, p, now) => (s.lastSampleTs != null && now - s.lastSampleTs >= NO_DATA_LAG_MS
    ? [{ key: 'noData', ongoing: true, since: s.lastSampleTs, facts: { since: s.lastSampleTs, authBlocked: Boolean(s.authBlocked) } }]
    : []),
  gridCut: (s) => eventIncidents(s, 'gridCut'),
  batteryLowInCut: (s, p) => (s.soc != null && s.soc < p.soc && s.events.some((e) => e.kind === 'gridCut' && e.ongoing)
    ? [{ key: 'batteryLowInCut', ongoing: true, facts: { soc: s.soc, threshold: p.soc } }]
    : []),
  batteryLow: (s) => eventIncidents(s, 'batteryLow'),
  belowReserve: (s) => (s.reservePct != null && s.soc != null && s.soc < s.reservePct && !(s.batteryKw > 0.05)
    ? [{ key: 'belowReserve', ongoing: true, facts: { soc: s.soc, reservePct: s.reservePct } }]
    : []),
  // once per day: the key is the day, a second stop that day is the same incident
  panelsStopped: (s) => s.events.filter((e) => e.kind === 'noProduction').map((e) => ({
    key: `panelsStopped:${localDay(e.start)}`, ongoing: false, since: e.start, end: e.end, facts: { start: e.start, end: e.end },
  })),
  deviceAlarm: (s, p) => s.alarms
    .filter((a) => a.severity != null && a.severity <= p.maxSeverity && !['network', 'gridCut', 'batteryLow'].includes(classify(a.name ?? '')))
    .map((a) => ({
      key: `deviceAlarm:${a.csn}`, ongoing: a.clear_utc == null, since: a.occur_utc, end: a.clear_utc,
      facts: {
        name: a.name ?? a.alarm_id, device: a.device_type ?? 'FusionSolar', severity: a.severity, start: a.occur_utc,
        ...(a.clear_utc != null && { end: a.clear_utc }),
      },
    })),
};

// snapshot: { lastSampleTs, authBlocked, soc, batteryKw, reservePct, events, alarms, summary? }
// state: { [key]: { status: 'ok'|'pending'|'firing', since, firedAt, lastSentAt, silent, facts, at }, _meta }
export function evaluate(snapshot, config, prev, now) {
  const state = structuredClone(prev ?? {});
  const meta = (state._meta ??= {});
  meta.armedAt ??= now;
  meta.resolved ??= {};
  meta.reports ??= {};
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
    const keys = new Set(incidents.map((i) => i.key));
    for (const inc of incidents) {
      // a late alarm moved a merged event's start: same incident, keep its state under the new key
      if (!state[inc.key] && MERGED.includes(rule.id)) {
        const old = Object.keys(state).find((k) => own(k) && !keys.has(k) && state[k].status === 'firing'
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
          if (now - s.since >= (rule.params.minutes ?? 0) * MIN) fire(inc.key, s, inc.facts);
        } else {
          s.facts = { ...s.facts, ...inc.facts };
          if (rule.repeatHours > 0 && now - s.lastSentAt >= rule.repeatHours * HOUR) {
            Object.assign(s, { lastSentAt: now, silent: false });
            act(inc.key, 'reminder', s.facts);
          }
        }
      } else if (!s) {
        // first seen already over: one past-tense email, unless it ended before the engine was armed (history)
        if (inc.end >= meta.armedAt) {
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
  const save = () => store.saveAlertState(new Map(Object.entries(state)));
  const meta = () => (state._meta ??= {});

  const defaults = () => ({
    ...structuredClone(DEFAULT_CONFIG),
    recipients: String(appConfig.alertTo ?? '').split(',').map((s) => s.trim()).filter(isEmail).slice(0, 10),
  });
  const config = () => {
    const stored = store.getKv('alertsConfig');
    return (stored && validateConfig(stored).config) || defaults();
  };
  const textOpts = () => ({ plantName: appConfig.plantName ?? store.getKv('station')?.name ?? null, appUrl: appConfig.appUrl || null });
  const capFull = (t) => (meta().sent ?? []).filter((x) => t - x < HOUR).length >= CAP_PER_HOUR;
  const countSend = (t) => {
    meta().sent = [...(meta().sent ?? []).filter((x) => t - x < HOUR), t];
  };
  const deliver = (recipients, msg) => transport.send({ to: recipients.join(', '), ...msg });

  const incidentCount = (from, to, t) => buildEvents(store.alarms(from, to), store.samples(from, to), Math.min(to, t))
    .filter((e) => !['network', 'other'].includes(e.kind)).length;

  // Day and month totals, only computed when a report is due.
  function summaries(t, cfg) {
    const due = dueReports(cfg, state, t);
    const out = {};
    if (due.dailySummary) {
      const day = due.dailySummary;
      const b = aggregate.energy(store, { from: day, to: day, bucket: '1d', prices: appConfig.prices, now: t }).buckets[0];
      out.dailySummary = {
        day, pv: b.pv_kwh, load: b.load_kwh, imp: b.import_kwh, exp: b.export_kwh, cost: b.money?.energy ?? null,
        incidents: incidentCount(...dayBounds(day), t),
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
        incidents: incidentCount(dayBounds(from)[0], dayBounds(to)[1], t),
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
      soc: live?.soc ?? null,
      batteryKw: live?.battery_kw ?? null,
      reservePct: appConfig.battery?.reservePct ?? null,
      events: buildEvents(alarms, samples, t),
      alarms,
      summary: summaries(t, cfg),
    };
  }

  // Failed emails of the last 24 h, oldest first, at most 3 per run, with growing pauses; they count in the cap.
  async function retryFailed(t, cfg) {
    const failed = store.failedAlerts(t - RETRY_WINDOW_MS);
    const prev = meta().retry ?? {};
    const retry = (meta().retry = Object.fromEntries(failed.filter((r) => prev[r.id]).map((r) => [r.id, prev[r.id]])));
    let n = 0;
    for (const row of failed) {
      if (n >= RETRY_PER_RUN || capFull(t) || !cfg.recipients.length) break;
      const r = retry[row.id] ?? { n: 0, next: 0 };
      if (t < r.next) continue;
      n++;
      countSend(t);
      try {
        await deliver(cfg.recipients, { subject: row.title, text: row.body });
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
    let deliveries;
    if (transport) ({ state, deliveries } = schedule(ev.actions, cfg, ev.state, t));
    else {
      state = ev.state;
      deliveries = ev.actions.map((a) => ({ ...a, delivery: 'skipped', reason: a.skip ?? 'noSmtp' }));
    }
    const opts = textOpts();
    const outgoing = [];
    for (const d of deliveries) {
      if (d.delivery === 'send' && !cfg.recipients.length) Object.assign(d, { delivery: 'skipped', reason: 'noRecipients' });
      const msg = render(cfg.lang, d, opts);
      const sending = d.delivery === 'send';
      // logged as failed until the send succeeds, so an email cut short by a restart is retried
      const id = store.logAlert({
        ts: t, rule: d.rule, event: d.event, title: msg.subject, body: msg.text,
        delivery: sending ? 'failed' : d.delivery, reason: d.reason ?? null, error: sending ? 'not sent yet' : null,
      });
      if (sending) outgoing.push([id, msg]);
      else log(`alert ${d.rule} ${d.event}: ${d.delivery === 'skipped' ? `not sent (${d.reason})` : d.delivery}`);
    }
    save(); // before sending: a crash mid-send must not fire the same alerts again
    for (const [id, msg] of outgoing) {
      try {
        await deliver(cfg.recipients, msg);
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
  const getConfig = () => ({
    smtp: { configured: Boolean(transport), host: appConfig.smtp?.host ?? null, from: appConfig.smtp?.from ?? null },
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
    sendTest: (to) => serial(async () => {
      const cfg = config();
      const addr = to ?? cfg.recipients[0];
      if (!transport) return { ok: false, error: 'email is not set up' };
      if (!isEmail(addr)) return { ok: false, error: addr == null ? 'no recipient' : 'invalid email address' };
      const t = now();
      if (capFull(t)) return { ok: false, error: `rate limit: ${CAP_PER_HOUR} emails per hour` };
      countSend(t);
      save();
      try {
        await transport.send({ to: addr, ...render(cfg.lang, { rule: 'test', event: 'test', at: t }, textOpts()) });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }),
    history: ({ limit = 50, before } = {}) => store.alertLog({ limit, before }),
  };
}
