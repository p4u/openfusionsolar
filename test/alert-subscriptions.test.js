process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { RULES, DEFAULT_CONFIG, DEFAULT_ON, MAX_RECIPIENTS, validateConfig, evaluate, createAlertEngine } from '../src/alerts.js';
import { GROUPS, PRESETS, presetOf } from '../public/js/alert-catalogue.js';
import { createTransport, smtpSecurity, smtpInfo } from '../src/mailer.js';
import { startTestServer } from './helpers.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const at = (d, h, m = 0, month = 10) => new Date(2026, month, d, h, m).getTime(); // local, November by default
const T0 = at(18, 12); // Wednesday 18 November 2026, 12:00

const fakeTransport = () => {
  const sent = [];
  return { sent, fail: false, async send(m) { if (this.fail) throw new Error('connect ETIMEDOUT'); sent.push(m); } };
};

function setup({ transport = fakeTransport(), start = T0, store = new Store(':memory:'), appConfig = {}, config, collector = null } = {}) {
  const clock = { t: start };
  const logs = [];
  const engine = createAlertEngine({
    store, collector, transport, now: () => clock.t, log: (m) => logs.push(m),
    appConfig: { plantName: 'Casa', alertTo: 'owner@example.com', ...appConfig },
  });
  if (config) {
    const r = engine.setConfig(config);
    assert.ok(r.config, JSON.stringify(r.fields));
  }
  const run = async (t) => {
    if (t != null) clock.t = t;
    await engine.run();
  };
  return { store, engine, transport, clock, logs, run };
}

// DEFAULT_CONFIG with recipients and per-rule patches.
const cfg = (recipients, rules = {}, top = {}) => ({
  ...DEFAULT_CONFIG, recipients, ...top,
  rules: DEFAULT_CONFIG.rules.map((r) => ({ ...r, ...rules[r.id], params: { ...r.params, ...rules[r.id]?.params } })),
});
const hit = (csn, name, occur, clear = null, severity = 1) =>
  ({ csn, alarmName: name, severity, occurUtc: occur, cleared: clear != null, clearUtc: clear, devTypeStr: 'Inverter' });
const snap = (o = {}) => ({
  lastSampleTs: null, authBlocked: false, collector: null, soc: null, batteryKw: null, reservePct: null, events: [], alarms: [], samples: [], ...o,
});
const fires = (r) => r.actions.map((a) => [a.key.split(':')[0], a.event]);
const ANA = { email: 'ana@example.com', lang: 'ca', alerts: ['gridCut', 'noData'] };
const BOB = { email: 'bob@example.com', lang: 'en', alerts: ['gridCut'] };
const CEL = { email: 'cel@example.com', lang: 'en', alerts: ['gridCut', 'monthlyReport'] };

// ---- catalogue, migration, validation ----

test('the catalogue has the 12 alerts in three groups and the presets of the consult', () => {
  assert.equal(RULES.length, 12);
  assert.deepEqual([...GROUPS.urgent, ...GROUPS.problems, ...GROUPS.reports].sort(), [...RULES].sort());
  assert.ok(!RULES.includes('batteryLow'));
  assert.equal(DEFAULT_ON.length, 10);
  assert.ok(!DEFAULT_ON.includes('powerLimit') && !DEFAULT_ON.includes('dailySummary'));
  const urgent = DEFAULT_CONFIG.rules.filter((r) => r.bypassQuiet).map((r) => r.id);
  assert.deepEqual(urgent, ['gridCut', 'batteryLowInCut', 'backupOverload']);
  const byId = Object.fromEntries(DEFAULT_CONFIG.rules.map((r) => [r.id, r]));
  assert.deepEqual(byId.noData.params, { minutes: 720 });
  assert.deepEqual([byId.gridCut.repeatHours, byId.gridCut.notifyResolved], [0, true]);
  assert.deepEqual([byId.belowReserve.params, byId.belowReserve.repeatHours, byId.belowReserve.enabled], [{ margin: 5, minutes: 180 }, 72, true]);
  assert.deepEqual(byId.collectorDown.params, { minutes: 60 });
  assert.deepEqual(byId.weeklySummary.params, { time: '08:00' });
  assert.equal(presetOf(DEFAULT_ON), 'important');
  assert.equal(presetOf([...PRESETS.urgent].reverse()), 'urgent');
  assert.equal(presetOf(['weeklySummary', 'monthlyReport']), 'reports');
  assert.equal(presetOf(['gridCut']), 'custom');
  assert.equal(presetOf([]), 'custom');
});

test('migration: plain addresses become recipients in the config language with the default-ON alerts', () => {
  const { config } = validateConfig({ recipients: ['a@example.com', 'B@example.com'], lang: 'en' });
  assert.deepEqual(config.recipients, [
    { email: 'a@example.com', lang: 'en', alerts: DEFAULT_ON }, { email: 'B@example.com', lang: 'en', alerts: DEFAULT_ON },
  ]);
  assert.equal(config.v, 1);
  // a stored config of the previous release: batteryLow and changed defaults
  const old = {
    recipients: ['a@example.com'], lang: 'ca', quiet: { from: '22:00', to: '08:00' },
    rules: [{ id: 'batteryLow', enabled: true, params: {} }, { id: 'noData', params: { minutes: 30 } }, { id: 'belowReserve', enabled: false, params: { minutes: 30 } }],
  };
  const m = validateConfig(old).config;
  assert.ok(m, 'a retired rule is not an error');
  assert.ok(!m.rules.some((r) => r.id === 'batteryLow'));
  const byId = Object.fromEntries(m.rules.map((r) => [r.id, r]));
  assert.equal(byId.noData.params.minutes, 30, 'a stored value is kept');
  assert.deepEqual([byId.belowReserve.enabled, byId.belowReserve.params], [false, { minutes: 30, margin: 5 }]);
  assert.deepEqual(byId.collectorDown.params, { minutes: 60 }, 'a new rule gets its defaults');
  // a recipient keeps a switched-off rule in its list; retired ids are dropped, an empty list is valid
  const r = validateConfig({ recipients: [{ email: 'a@example.com', alerts: ['batteryLow', 'gridCut', 'gridCut'] }, { email: 'b@example.com', alerts: [] }] });
  assert.deepEqual(r.config.recipients.map((x) => x.alerts), [['gridCut'], []]);
  assert.equal(r.config.recipients[0].lang, 'ca');
});

test('ALERT_TO is migrated too: deduplicated, invalid ones dropped, the default-ON set', () => {
  const s = setup({ appConfig: { alertTo: 'a@example.com, A@example.com,nope, b@example.com' } });
  assert.deepEqual(s.engine.getConfig().recipients, [
    { email: 'a@example.com', lang: 'ca', alerts: DEFAULT_ON }, { email: 'b@example.com', lang: 'ca', alerts: DEFAULT_ON },
  ]);
});

test('validation: valid email, no duplicates ignoring case, at most 20 recipients, alert ids from the catalogue, ca or en', () => {
  const bad = validateConfig({
    recipients: [
      { email: 'a@example.com', lang: 'ca', alerts: [] },
      { email: 'A@Example.com', lang: 'en', alerts: [] },
      { email: 'b@example.com', lang: 'fr', alerts: ['gridCut', 'nope'] },
      { email: 'c@example.com', alerts: 'gridCut' },
      { email: 'not an address' },
      42,
    ],
  });
  assert.deepEqual(bad.fields, {
    'recipients.1': 'duplicate email address',
    'recipients.2.lang': 'ca or en',
    'recipients.2.alerts': 'unknown alert',
    'recipients.3.alerts': 'list of alerts',
    'recipients.4': 'invalid email address',
    'recipients.5': 'invalid email address',
  });
  const many = (n) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com` }));
  assert.ok(validateConfig({ recipients: many(MAX_RECIPIENTS) }).config);
  assert.equal(validateConfig({ recipients: many(MAX_RECIPIENTS + 1) }).fields.recipients, 'up to 20 email addresses');
});

test('retired rules lose their stored state on the first run', () => {
  const prev = { 'batteryLow:123': { status: 'firing', facts: {} }, batteryLow: { status: 'pending' }, _meta: { armedAt: T0 } };
  const { state } = evaluate(snap(), DEFAULT_CONFIG, prev, T0);
  assert.deepEqual(Object.keys(state), ['_meta']);
});

// ---- delivery: subscriptions and languages ----

test('an alert reaches only its subscribers, one email per address in its language, and the log says to whom', async () => {
  const s = setup({ config: cfg([ANA, BOB, CEL], { noData: { params: { minutes: 30 } } }) });
  s.store.saveAlarm(hit(1, 'Grid loss', T0 - 5 * MIN));
  await s.run(T0);
  const sent = s.transport.sent.map((m) => [m.to, m.subject]);
  assert.deepEqual(sent, [
    ['ana@example.com', '[Casa]: tall de corrent des de les 11:55'],
    ['bob@example.com', '[Casa]: power cut since 11:55'],
    ['cel@example.com', '[Casa]: power cut since 11:55'],
  ]);
  const rows = s.engine.history().reverse();
  assert.deepEqual(rows.map((r) => [r.rule, r.delivery, r.lang, r.recipients]), [
    ['gridCut', 'sent', 'ca', ['ana@example.com']],
    ['gridCut', 'sent', 'en', ['bob@example.com']],
    ['gridCut', 'sent', 'en', ['cel@example.com']],
  ]);
  assert.equal(new Set(rows.map((r) => r.grp)).size, 1, 'one alert event');

  // noData: only Ana subscribes
  s.store.saveSample(T0 + 5 * MIN, { load_kw: 0.3 });
  await s.run(T0 + 40 * MIN);
  assert.deepEqual(s.transport.sent.slice(3).map((m) => m.to), ['ana@example.com']);
  assert.match(s.transport.sent[3].subject, /sense dades de la instal·lació des de les 12:05/);
});

test('two addresses of the same language get two separate emails, never a shared To: line', async () => {
  const s = setup({ config: cfg([BOB, { ...CEL, alerts: ['gridCut'] }]) });
  s.store.saveAlarm(hit(1, 'Grid loss', T0 - 5 * MIN));
  await s.run(T0);
  assert.deepEqual(s.transport.sent.map((m) => m.to), ['bob@example.com', 'cel@example.com']);
  assert.ok(s.transport.sent.every((m) => !/[,;]/.test(m.to)));
  assert.equal(s.transport.sent[0].subject, s.transport.sent[1].subject);
});

test('a send that fails for one address is retried only to that address', async () => {
  const sent = [];
  const transport = {
    down: new Set(['cel@example.com']),
    async send(m) {
      if (this.down.has(m.to)) throw new Error('550 mailbox unavailable');
      sent.push(m.to);
    },
  };
  const s = setup({ transport, config: cfg([BOB, { ...CEL, alerts: ['gridCut'] }]) });
  s.store.saveAlarm(hit(1, 'Grid loss', T0 - 5 * MIN));
  await s.run(T0);
  assert.deepEqual(sent, ['bob@example.com']);
  assert.deepEqual(s.engine.history().reverse().map((r) => [r.recipients[0], r.delivery, r.error]), [
    ['bob@example.com', 'sent', null], ['cel@example.com', 'failed', '550 mailbox unavailable'],
  ]);
  transport.down.clear();
  await s.run(T0 + 3 * MIN);
  assert.deepEqual(sent, ['bob@example.com', 'cel@example.com'], 'bob is not emailed twice');
  assert.deepEqual(s.engine.history().map((r) => r.delivery), ['sent', 'sent']);
});

test('the hourly cap counts alert events, not emails', async () => {
  const three = ['a', 'b', 'c'].map((x) => ({ email: `${x}@example.com`, lang: 'en', alerts: ['deviceAlarm'] }));
  const s = setup({ config: cfg(three) });
  for (let i = 1; i <= 12; i++) s.store.saveAlarm(hit(i, `Inverter fault ${i}`, T0 - i * MIN));
  await s.run(T0);
  assert.equal(s.transport.sent.length, 30, '10 events to 3 addresses each');
  assert.deepEqual(s.engine.history().filter((r) => r.delivery === 'skipped').map((r) => r.reason), ['rateLimit', 'rateLimit']);
  assert.deepEqual(await s.engine.sendTest('x@example.com'), { ok: false, error: 'rate limit: 10 emails per hour' });
});

test('retries count once per event in the cap, however many of its addresses failed', async () => {
  const three = ['a', 'b', 'c'].map((x) => ({ email: `${x}@example.com`, lang: 'en', alerts: ['deviceAlarm'] }));
  const transport = fakeTransport();
  transport.fail = true;
  const s = setup({ transport, config: cfg(three) });
  for (let i = 1; i <= 9; i++) s.store.saveAlarm(hit(i, `Inverter fault ${i}`, T0 - i * MIN));
  await s.run(T0); // 9 events, 27 failed emails, 9 events in the cap
  transport.fail = false;
  await s.run(T0 + 3 * MIN); // the cap has room for one more event: one event is retried, to its 3 addresses
  assert.equal(transport.sent.length, 3);
  assert.equal(new Set(transport.sent.map((m) => m.subject)).size, 1);
  assert.equal(new Set(transport.sent.map((m) => m.to)).size, 3);
});

test('nobody subscribed: logged as skipped (noRecipients), not sent and not counted in the hourly cap', async () => {
  const s = setup({ config: cfg([BOB]) });
  for (let i = 1; i <= 12; i++) s.store.saveAlarm(hit(i, `Inverter fault ${i}`, T0 - i * MIN));
  await s.run(T0);
  assert.equal(s.transport.sent.length, 0);
  assert.deepEqual([...new Set(s.engine.history().map((r) => `${r.delivery}:${r.reason}`))], ['skipped:noRecipients']);
  assert.deepEqual(await s.engine.sendTest('x@example.com'), { ok: true }, 'the cap is untouched');
  assert.ok(s.logs.some((l) => /not sent \(noRecipients\)/.test(l)));
});

test('the 08:00 digest holds for each recipient only the alerts they subscribe to, in their language', async () => {
  const ana = { email: 'ana@example.com', lang: 'ca', alerts: ['noData', 'deviceAlarm'] };
  const bob = { email: 'bob@example.com', lang: 'en', alerts: ['deviceAlarm'] };
  const cel = { email: 'cel@example.com', lang: 'en', alerts: ['gridCut'] };
  const s = setup({ start: at(18, 23), config: cfg([ana, bob, cel], { noData: { params: { minutes: 30 } } }) });
  s.store.saveSample(at(18, 22, 50), { load_kw: 0.3 });
  await s.run(at(18, 23));
  await s.run(at(18, 23, 30)); // noData, queued
  s.store.saveAlarm(hit(7, 'Fan fault', at(19, 1)));
  await s.run(at(19, 1, 5)); // deviceAlarm, queued
  assert.equal(s.transport.sent.length, 0);
  await s.run(at(19, 8));
  assert.deepEqual(s.transport.sent.map((m) => [m.to, m.subject]), [
    ['ana@example.com', '[Casa]: 2 avisos durant les hores de silenci'],
    ['bob@example.com', '[Casa]: 1 alert during quiet hours'],
  ]);
  assert.match(s.transport.sent[1].text, /Alarm: Fan fault/);
  assert.doesNotMatch(s.transport.sent[1].text, /No data/);
});

test('a failed email is retried to the addresses of the first attempt, in its language', async () => {
  const transport = fakeTransport();
  transport.fail = true;
  const s = setup({ transport, config: cfg([ANA, BOB]) });
  s.store.saveAlarm(hit(1, 'Grid loss', T0 - 5 * MIN));
  await s.run(T0);
  assert.deepEqual(s.engine.history().map((r) => r.delivery), ['failed', 'failed']);
  // the recipients change before the retry
  assert.ok(s.engine.setConfig(cfg([{ email: 'new@example.com', lang: 'en', alerts: DEFAULT_ON }])).config);
  transport.fail = false;
  await s.run(T0 + 3 * MIN);
  assert.deepEqual(s.transport.sent.map((m) => [m.to, m.subject]), [
    ['ana@example.com', '[Casa]: tall de corrent des de les 11:55'],
    ['bob@example.com', '[Casa]: power cut since 11:55'],
  ]);
  assert.deepEqual(s.engine.history().map((r) => r.delivery), ['sent', 'sent']);
});

test('a row logged before per-recipient alerts is retried to today\'s subscribers of its rule', async () => {
  const s = setup({ config: cfg([ANA, BOB]) });
  s.store.logAlert({ ts: T0 - MIN, rule: 'noData', event: 'fired', title: 'old', body: 'old body', delivery: 'failed', error: 'x' });
  await s.run(T0);
  assert.deepEqual(s.transport.sent.map((m) => [m.to, m.subject]), [['ana@example.com', 'old']]);
});

test('reports reach only their subscribers', async () => {
  const s = setup({ start: at(1, 7, 0, 11), config: cfg([ANA, CEL]) });
  s.store.saveDaily('2026-11-15', { pv_kwh: 10, load_kwh: 8, import_kwh: 2, export_kwh: 4 });
  await s.run();
  await s.run(at(1, 8, 0, 11));
  assert.deepEqual(s.transport.sent.map((m) => [m.to, m.subject]), [['cel@example.com', '[Casa]: November 2026 summary']]);
});

test('the test email goes in the recipient\'s language, or the one asked for', async () => {
  const s = setup({ config: cfg([ANA, BOB]) });
  assert.deepEqual(await s.engine.sendTest('BOB@example.com'), { ok: true });
  assert.deepEqual(await s.engine.sendTest('ana@example.com'), { ok: true });
  assert.deepEqual(await s.engine.sendTest('new@example.com', 'en'), { ok: true });
  assert.deepEqual(s.transport.sent.map((m) => m.subject), ['[Casa]: test email', '[Casa]: correu de prova', '[Casa]: test email']);
  const srv = await startTestServer({ store: s.store, alerts: s.engine });
  try {
    const res = await srv.request('/api/alerts/test', { method: 'POST', body: JSON.stringify({ to: 'z@example.com', lang: 'ca' }) });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(s.transport.sent[3].subject, '[Casa]: correu de prova');
  } finally {
    await srv.close();
  }
});

// ---- urgency ----

test('urgent alerts go out during quiet hours, normal ones wait for the digest', async () => {
  const all = [{ email: 'ana@example.com', lang: 'en', alerts: [...RULES] }];
  const s = setup({
    start: at(18, 23), config: cfg(all), appConfig: { battery: { capacityKwh: 10 } },
  });
  await s.run(at(18, 23));
  s.store.saveSample(at(19, 2, 50), { load_kw: 1, soc: 15, battery_kw: -1 });
  s.store.saveAlarm(hit(1, 'Grid loss', at(19, 2, 40)));
  s.store.saveAlarm(hit(2, 'Off-Grid Output Overload', at(19, 2, 50)));
  s.store.saveAlarm(hit(3, 'Fan fault', at(19, 2, 50)));
  await s.run(at(19, 3));
  assert.deepEqual(s.transport.sent.map((m) => m.subject).sort(), [
    '[Casa]: battery at 15 % during a power cut',
    '[Casa]: house without power: the battery cannot carry the load',
    '[Casa]: power cut since 02:40, battery at 15 %',
  ]);
  assert.match(s.transport.sent.find((m) => /during a power cut/.test(m.subject)).text, /lasts about 1 h 30 min/);
  assert.deepEqual(s.engine.history().filter((r) => r.delivery === 'queued').map((r) => r.rule), ['deviceAlarm']);
});

// ---- each rule's trigger ----

test('gridCut waits 2 minutes, ignores blips and its resolve email says power is back, for how long and if the battery covered it', () => {
  const cut = (start, ongoing, end = T0) => ({ kind: 'gridCut', start, end, ongoing, names: [], ...(!ongoing && { batteryCovered: true }) });
  let r = evaluate(snap({ events: [cut(T0 - MIN, true)] }), DEFAULT_CONFIG, {}, T0);
  assert.deepEqual(r.actions, []);
  r = evaluate(snap({ events: [cut(T0 - MIN, true)], soc: 62 }), DEFAULT_CONFIG, r.state, T0 + MIN);
  assert.deepEqual(fires(r), [['gridCut', 'fired']]);
  r = evaluate(snap({ events: [cut(T0 - MIN, false, T0 + 63 * MIN)], soc: 40 }), DEFAULT_CONFIG, r.state, T0 + 65 * MIN);
  assert.deepEqual(fires(r), [['gridCut', 'resolved']]);
  assert.deepEqual([r.actions[0].facts.end - r.actions[0].facts.start, r.actions[0].facts.batteryCovered, r.actions[0].facts.soc], [64 * MIN, true, 40]);
  // a cut first seen already over that lasted under 2 minutes is a blip
  const blip = evaluate(snap({ events: [cut(T0 - 5 * MIN, false, T0 - 5 * MIN + 4000)] }), DEFAULT_CONFIG, { _meta: { armedAt: T0 - HOUR } }, T0);
  assert.deepEqual(blip.actions, []);
});

test('gridCut email: resolve text with duration and coverage, and the limiter hint when the draw was near the contracted power', async () => {
  const s = setup({ config: cfg([BOB]), appConfig: { power: { p1: 4.4, p2: 4.4 } } });
  await s.run(T0 - 20 * MIN);
  s.store.saveSample(T0 - 10 * MIN, { grid_kw: 4.2, load_kw: 4.3, battery_kw: 0 });
  s.store.saveSample(T0 - 5 * MIN, { grid_kw: null, load_kw: 0.5, battery_kw: -0.5, soc: 70 });
  s.store.saveAlarm(hit(1, 'Grid loss', T0 - 2 * MIN));
  await s.run(T0);
  assert.match(s.transport.sent[0].text, /Probably the power limiter tripped: reset it at the meter/);
  s.store.saveAlarm(hit(1, 'Grid loss', T0 - 2 * MIN, T0 + 62 * MIN));
  s.store.saveSample(T0 + 60 * MIN, { grid_kw: null, load_kw: 0.5, battery_kw: -0.5, soc: 55 });
  await s.run(T0 + 65 * MIN);
  const back = s.transport.sent[1];
  assert.equal(back.subject, '[Casa]: power is back after 1 h 4 min');
  assert.match(back.text, /The battery kept the house powered\./);
  assert.match(back.text, /Battery now at 55 %/);
  assert.match(back.text, /Nothing to do\./);
});

test('backupOverload fires on an overload event, once, and its past form names the times', () => {
  const ev = (ongoing, end = T0) => ({ kind: 'overload', start: T0 - 10 * MIN, end, ongoing, names: [] });
  let r = evaluate(snap({ events: [ev(true)] }), DEFAULT_CONFIG, {}, T0);
  assert.deepEqual(fires(r), [['backupOverload', 'fired']]);
  assert.equal(r.actions[0].bypassQuiet, true);
  r = evaluate(snap({ events: [ev(false, T0 + MIN)] }), DEFAULT_CONFIG, r.state, T0 + 2 * MIN);
  assert.deepEqual(fires(r), [['backupOverload', 'resolved']]);
  const past = evaluate(snap({ events: [ev(false, T0 - 5 * MIN)] }), DEFAULT_CONFIG, { _meta: { armedAt: T0 - HOUR } }, T0);
  assert.deepEqual([fires(past), past.actions[0].facts.past], [[['backupOverload', 'fired']], true]);
});

test('batteryLowInCut also counts the 30 minutes after a cut alarm clears, until a grid reading arrives', () => {
  const ended = { kind: 'gridCut', start: T0 - HOUR, end: T0 - 10 * MIN, ongoing: false, names: [] };
  const only = (s, now) => fires(evaluate(snap({ soc: 15, ...s }), DEFAULT_CONFIG, { _meta: { armedAt: now } }, now)).filter(([k]) => k === 'batteryLowInCut');
  assert.deepEqual(only({ events: [ended] }, T0), [['batteryLowInCut', 'fired']]);
  assert.deepEqual(only({ events: [ended], samples: [{ ts: T0 - 5 * MIN, grid_kw: 0.4 }] }, T0), [], 'the grid is back');
  assert.deepEqual(only({ events: [ended] }, T0 + 25 * MIN), [], 'more than 30 minutes after');
  assert.deepEqual(only({ events: [] }, T0), []);
  assert.deepEqual(only({ events: [ended], soc: 25 }, T0), []);
});

test('noData waits 12 hours by default, names an ongoing network alarm and stays quiet while the collector fails', () => {
  const net = { kind: 'network', start: T0 - HOUR, end: T0, ongoing: true, names: [] };
  let r = evaluate(snap({ lastSampleTs: T0 - 11 * HOUR, events: [net] }), DEFAULT_CONFIG, {}, T0);
  assert.deepEqual(r.actions, []);
  r = evaluate(snap({ lastSampleTs: T0 - 11 * HOUR, events: [net] }), DEFAULT_CONFIG, r.state, T0 + HOUR);
  assert.deepEqual(fires(r), [['noData', 'fired']]);
  assert.equal(r.actions[0].facts.network, T0 - HOUR);
  // the collector fails: noData neither resolves nor fires, collectorDown speaks instead
  const failing = { lastTick: T0, lastError: { at: T0 + 2 * HOUR, message: 'HTTP 503' } };
  const r2 = evaluate(snap({ lastSampleTs: T0 + HOUR, collector: failing }), DEFAULT_CONFIG, r.state, T0 + 2 * HOUR);
  assert.equal(r2.state.noData.status, 'firing');
  assert.ok(!fires(r2).some(([k]) => k === 'noData'));
  const fresh = evaluate(snap({ lastSampleTs: T0 - 13 * HOUR, collector: failing }), DEFAULT_CONFIG, {}, T0);
  assert.equal(fresh.state.noData, undefined);
});

test('collectorDown: at once when the login is paused, after 60 minutes of failing ticks otherwise', async () => {
  const collector = { authBlockedUntil: 0, status: { lastTick: T0, lastError: null } };
  const s = setup({ collector, config: cfg([BOB]) });
  await s.run(T0);
  collector.status.lastError = { at: T0 + 5 * MIN, message: 'device-list: HTTP 502' };
  await s.run(T0 + 59 * MIN);
  assert.equal(s.transport.sent.length, 0);
  await s.run(T0 + 60 * MIN);
  assert.equal(s.transport.sent.length, 0, 'BOB is not subscribed');
  assert.deepEqual(s.engine.history().map((r) => [r.rule, r.reason]), [['collectorDown', 'noRecipients']], 'but it fired at 60 minutes');
  // a subscriber, with the login paused
  const c2 = { authBlockedUntil: T0 + HOUR, status: { lastTick: T0 - MIN, lastError: { at: T0, message: 'login failed' } } };
  const s2 = setup({ collector: c2, config: cfg([{ ...BOB, alerts: ['collectorDown'] }]) });
  await s2.run(T0);
  assert.equal(s2.transport.sent[0].subject, '[Casa]: the app cannot sign in to FusionSolar');
  assert.match(s2.transport.sent[0].text, /Last error: login failed/);
  assert.match(s2.transport.sent[0].text, /check the FusionSolar user and password in the \.env file/);
  c2.authBlockedUntil = 0;
  await s2.run(T0 + HOUR + MIN);
  assert.equal(s2.transport.sent.length, 1, 'still failing after the pause: same incident');
  c2.status = { lastTick: T0 + 2 * HOUR, lastError: null };
  await s2.run(T0 + 2 * HOUR);
  assert.equal(s2.transport.sent[1].subject, '[Casa]: the app reads FusionSolar again');
  // ticks that keep failing without a login pause
  const c3 = { authBlockedUntil: 0, status: { lastTick: T0 - 61 * MIN, lastError: { at: T0, message: 'HTTP 503' } } };
  const s3 = setup({ collector: c3, config: cfg([{ ...BOB, alerts: ['collectorDown'] }]) });
  await s3.run(T0);
  assert.equal(s3.transport.sent[0].subject, '[Casa]: the app cannot reach FusionSolar since 10:59');
});

test('belowReserve: below reserve minus the margin for 3 hours, not during a cut, mentions the grid-charge cutoff', () => {
  const base = { reservePct: 60, batteryConfig: { chargeFromGrid: true, gridChargeCutoffPct: 50 } };
  let r = evaluate(snap({ ...base, soc: 56 }), DEFAULT_CONFIG, {}, T0);
  assert.equal(r.state.belowReserve, undefined, 'within the 5-point margin');
  r = evaluate(snap({ ...base, soc: 54 }), DEFAULT_CONFIG, {}, T0);
  assert.equal(r.state.belowReserve.status, 'pending');
  r = evaluate(snap({ ...base, soc: 54 }), DEFAULT_CONFIG, r.state, T0 + 179 * MIN);
  assert.deepEqual(r.actions, []);
  const cut = { kind: 'gridCut', start: T0, end: T0, ongoing: true, names: [] };
  const during = evaluate(snap({ ...base, soc: 30, events: [cut] }), DEFAULT_CONFIG, r.state, T0 + 3 * HOUR);
  assert.ok(!fires(during).some(([k]) => k === 'belowReserve'), 'a cut does not fire it');
  assert.equal(during.state.belowReserve.status, 'pending', 'nor reset it');
  r = evaluate(snap({ ...base, soc: 54 }), DEFAULT_CONFIG, r.state, T0 + 180 * MIN);
  assert.deepEqual(fires(r), [['belowReserve', 'fired']]);
  assert.deepEqual(r.actions[0].facts, { since: T0, soc: 54, reservePct: 60, cutoffPct: 50 });
});

test('belowReserve email carries the number, the reserve and how long', async () => {
  const s = setup({ config: cfg([BOB]), appConfig: { battery: { reservePct: 60 } } });
  s.store.saveSample(T0, { soc: 48, load_kw: 0.4 });
  s.store.setKv('batteryConfig', { chargeFromGrid: false });
  await s.run(T0);
  assert.equal(s.transport.sent.length, 0, 'BOB is not subscribed');
  const s2 = setup({ config: cfg([{ ...BOB, alerts: ['belowReserve'] }]), appConfig: { battery: { reservePct: 60 } }, store: s.store });
  await s2.run(T0);
  await s2.run(T0 + 3 * HOUR);
  assert.equal(s2.transport.sent[0].subject, '[Casa]: battery at 48 %, below the 60 % reserve for 3 h');
  assert.match(s2.transport.sent[0].text, /Grid charging is off in FusionSolar/);
});

test('powerLimit: the first reading above the contracted power of its period, at most once a day, off for new addresses', async () => {
  const power = { p1: 4.4, p2: 6 };
  const sub = [{ email: 'bob@example.com', lang: 'en', alerts: ['powerLimit'] }];
  const s = setup({ config: cfg(sub), appConfig: { power }, start: at(18, 19) });
  await s.run();
  s.store.saveSample(at(18, 20, 50), { grid_kw: 5.1, load_kw: 5.2 }); // P1 (weekday 18-22 h)
  s.store.saveSample(at(18, 20, 55), { grid_kw: 5.5, load_kw: 5.6 });
  await s.run(at(18, 21));
  assert.deepEqual(s.transport.sent.map((m) => m.subject), ['[Casa]: 5.1 kW from the grid at 20:50, above the 4.4 kW contracted']);
  s.store.saveSample(at(18, 23, 0), { grid_kw: 5.5, load_kw: 5.6 }); // off-peak, under its 6 kW, and the same day anyway
  await s.run(at(18, 23, 5));
  s.store.saveSample(at(19, 1, 0), { grid_kw: 5.5, load_kw: 5.6 }); // next day, off-peak: under 6 kW
  await s.run(at(19, 1, 5));
  s.store.saveSample(at(19, 9, 0), { grid_kw: 4.5, load_kw: 4.6 }); // next day, standard period (P1 power)
  await s.run(at(19, 9, 5));
  assert.equal(s.transport.sent.length, 2);
  assert.equal(s.engine.getConfig().unavailable.length, 0);
  assert.deepEqual(setup().engine.getConfig().unavailable, ['powerLimit'], 'hidden without POWER_P1_KW / POWER_P2_KW');
  const pct = setup({ config: cfg(sub, { powerLimit: { params: { overPct: 20 } } }), appConfig: { power }, start: at(18, 19) });
  await pct.run();
  pct.store.saveSample(at(18, 20, 50), { grid_kw: 5.1, load_kw: 5.2 });
  await pct.run(at(18, 21));
  assert.equal(pct.transport.sent.length, 0, '5.1 kW is under 4.4 kW + 20 %');
});

test('weeklySummary: Monday at 08:00, the previous week with incidents and the peak draw', async () => {
  const sub = [{ email: 'bob@example.com', lang: 'en', alerts: ['weeklySummary'] }, { email: 'ana@example.com', lang: 'ca', alerts: ['weeklySummary'] }];
  const s = setup({ config: cfg(sub), appConfig: { power: { p1: 4.4, p2: 4.4 } }, start: at(15, 12) }); // Sunday
  for (let d = 9; d <= 15; d++) s.store.saveDaily(`2026-11-${String(d).padStart(2, '0')}`, { pv_kwh: 6, load_kwh: 8, import_kwh: 3, export_kwh: 1 });
  s.store.saveSample(at(10, 20, 50), { grid_kw: 5.1, load_kw: 5.2 });
  s.store.saveAlarm(hit(1, 'Grid loss', at(10, 7, 41), at(10, 8, 45)));
  await s.run();
  await s.run(at(16, 7, 59));
  assert.equal(s.transport.sent.length, 0);
  await s.run(at(16, 8)); // Monday
  assert.deepEqual(s.transport.sent.map((m) => [m.to, m.subject]), [
    ['bob@example.com', '[Casa]: week of 9 to 15 November: 42 kWh produced'],
    ['ana@example.com', '[Casa]: setmana del 9 al 15 de novembre: 42 kWh produïts'],
  ]);
  const text = s.transport.sent[0].text;
  assert.match(text, /Consumed: 56 kWh/);
  assert.match(text, /Incidents: 1\n- Power cut, 10\/11 07:41, 1 h 4 min/);
  assert.match(text, /Peak draw from the grid: 5\.1 kW \(10\/11 20:50\), contracted 4\.4 kW/);
  await s.run(at(16, 9));
  await s.run(at(17, 8));
  assert.equal(s.transport.sent.length, 2, 'once a week');
});

// ---- mailer ----

test('mailer: SMTP_PASSWORD works like SMTP_PASS, TLS defaults on for port 465, credentials never shown', async () => {
  assert.deepEqual(smtpSecurity({ SMTP_USER: 'u', SMTP_PASSWORD: 'p2' }).auth, { user: 'u', pass: 'p2' });
  assert.deepEqual(smtpSecurity({ SMTP_USER: 'u', SMTP_PASS: 'p1', SMTP_PASSWORD: 'p2' }).auth, { user: 'u', pass: 'p1' });
  assert.equal(smtpSecurity({}).auth, undefined);
  assert.equal(smtpSecurity({ SMTP_PORT: '465' }).secure, true);
  assert.equal(smtpSecurity({ SMTP_PORT: '465', SMTP_SECURE: '' }).secure, true);
  assert.equal(smtpSecurity({ SMTP_PORT: '587' }).secure, false);
  assert.equal(smtpSecurity({}).secure, false);
  assert.equal(smtpSecurity({ SMTP_PORT: '465', SMTP_SECURE: '0' }).secure, false);
  assert.equal(smtpSecurity({ SMTP_PORT: '587', SMTP_SECURE: '1' }).secure, true);
  const env = { SMTP_HOST: 'smtp.invalid', SMTP_PORT: '465', SMTP_USER: 'secret-user', SMTP_PASSWORD: 'secret-pass-123', SMTP_FROM: 'a@b.example' };
  const t = await createTransport(env);
  assert.equal(typeof t.send, 'function');
  assert.doesNotMatch(JSON.stringify(t), /secret/);
  assert.deepEqual(smtpInfo(env), { host: 'smtp.invalid', from: 'a@b.example' });
});
