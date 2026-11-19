process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { RULES, DEFAULT_CONFIG, validateConfig, evaluate, schedule, createAlertEngine, QUEUE_MAX } from '../src/alerts.js';
import { render } from '../src/alert-texts.js';
import { createTransport, smtpInfo } from '../src/mailer.js';
import { startTestServer } from './helpers.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (d, h, m = 0, month = 10) => new Date(2026, month, d, h, m).getTime(); // local, November by default
const T0 = at(18, 12);

const fakeTransport = () => {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); } };
};
const failingTransport = (message) => ({ send: async () => { throw new Error(message); } });

// Engine on a fresh (or given) store with a fake clock. `config` is stored through setConfig.
function setup({ transport = fakeTransport(), start = T0, store = new Store(':memory:'), appConfig = {}, config } = {}) {
  const clock = { t: start };
  const logs = [];
  const engine = createAlertEngine({
    store, collector: null, transport, now: () => clock.t, log: (m) => logs.push(m),
    appConfig: { plantName: 'Casa', alertTo: 'owner@example.com', ...appConfig },
  });
  if (config) assert.ok(engine.setConfig(config).config);
  const run = async (t) => {
    if (t != null) clock.t = t;
    await engine.run();
  };
  return { store, engine, transport, clock, logs, run };
}

// DEFAULT_CONFIG with per-rule patches, e.g. cfgWith({ lang: 'en' }, { noData: { enabled: false } }).
const cfgWith = (top = {}, rules = {}) => ({
  ...DEFAULT_CONFIG, recipients: ['owner@example.com'], ...top,
  rules: DEFAULT_CONFIG.rules.map((r) => ({ ...r, ...rules[r.id], params: { ...r.params, ...rules[r.id]?.params } })),
});
const only = (id, patch = {}) => cfgWith({}, Object.fromEntries(RULES.map((r) => [r, r === id ? { enabled: true, ...patch } : { enabled: false }])));

const hit = (csn, name, occur, clear = null, severity = 1) =>
  ({ csn, alarmName: name, severity, occurUtc: occur, cleared: clear != null, clearUtc: clear, devTypeStr: 'Inverter' });
const row = (csn, name, occur, clear = null, severity = 1) =>
  ({ csn, name, severity, occur_utc: occur, clear_utc: clear, device_type: 'Inverter', device_dn: 'NE=1' });
const snap = (o = {}) => ({ lastSampleTs: null, authBlocked: false, soc: null, batteryKw: null, reservePct: null, events: [], alarms: [], ...o });

test('noData goes pending, fires after 30 minutes, reminds after 24 hours and resolves once', () => {
  let state = {};
  const step = (now, lastSampleTs) => {
    const r = evaluate(snap({ lastSampleTs }), DEFAULT_CONFIG, state, now);
    state = r.state;
    return r.actions.map((a) => a.event);
  };
  assert.deepEqual(evaluate(snap(), DEFAULT_CONFIG, {}, T0 + 10 * DAY).actions, []); // never while no sample exists
  assert.deepEqual(step(T0 + 5 * MIN, T0), []);
  assert.equal(state.noData, undefined);
  assert.deepEqual(step(T0 + 15 * MIN, T0), []);
  assert.equal(state.noData.status, 'pending');
  assert.deepEqual(step(T0 + 30 * MIN, T0), ['fired']);
  assert.equal(state.noData.status, 'firing');
  assert.deepEqual(step(T0 + 35 * MIN, T0), []);
  assert.deepEqual(step(T0 + 24 * HOUR, T0), []);
  assert.deepEqual(step(T0 + 30 * MIN + 24 * HOUR, T0), ['reminder']);
  assert.deepEqual(step(T0 + 30 * MIN + 25 * HOUR, T0), []);
  const back = T0 + 26 * HOUR;
  assert.deepEqual(step(back + 2 * MIN, back), ['resolved']);
  assert.deepEqual(step(back + 7 * MIN, back), []);
  assert.equal(state.noData, undefined);
});

test('a rule that fires again within the cooldown is logged as skipped and stays silent on resolve', async () => {
  const s = setup();
  s.store.saveSample(T0, { load_kw: 0.4 });
  await s.run(T0 + 31 * MIN); // fired
  s.store.saveSample(T0 + 35 * MIN, { load_kw: 0.4 });
  await s.run(T0 + 36 * MIN); // resolved
  assert.equal(s.transport.sent.length, 2);
  await s.run(T0 + 65 * MIN); // no sample for 30 min again, 29 min after the resolve
  assert.deepEqual(s.engine.status().firing, ['noData']);
  s.store.saveSample(T0 + 70 * MIN, { load_kw: 0.4 });
  await s.run(T0 + 71 * MIN);
  assert.equal(s.transport.sent.length, 2);
  assert.deepEqual(s.engine.history({ limit: 10 }).map((r) => [r.event, r.delivery, r.reason]), [
    ['resolved', 'skipped', 'cooldown'], ['fired', 'skipped', 'cooldown'], ['resolved', 'sent', null], ['fired', 'sent', null],
  ]);
});

test('quiet hours queue normal alerts into one 08:00 digest while gridCut is sent at once', async () => {
  const s = setup({ start: at(18, 23), config: cfgWith({ lang: 'en' }) });
  s.store.saveSample(at(18, 22, 50), { load_kw: 0.3 });
  s.store.saveAlarm(hit(1, 'Grid loss', at(18, 22, 58)));
  await s.run(at(18, 23));
  assert.equal(s.transport.sent.length, 1);
  assert.match(s.transport.sent[0].subject, /^\[Casa\]: power cut since 22:58/);
  await s.run(at(18, 23, 30)); // noData fires inside quiet hours
  await s.run(at(19, 2));
  await s.run(at(19, 7, 59));
  assert.equal(s.transport.sent.length, 1);
  assert.deepEqual(s.engine.history().map((r) => [r.rule, r.delivery]), [['noData', 'queued'], ['gridCut', 'sent']]);
  await s.run(at(19, 8));
  assert.equal(s.transport.sent.length, 2);
  const digest = s.transport.sent[1];
  assert.match(digest.subject, /^\[Casa\]: 1 alert during quiet hours/);
  assert.match(digest.text, /18\/11 23:30 {2}No data since 18\/11 22:50/); // dated: the digest goes out the next day
  assert.equal(s.engine.history()[0].event, 'digest');
  await s.run(at(19, 8, 5));
  assert.equal(s.transport.sent.length, 2);
});

test('the quiet-hours queue keeps the newest 100 alerts and logs the dropped ones as skipped', () => {
  const night = at(19, 2);
  const actions = Array.from({ length: QUEUE_MAX + 3 }, (_, i) => ({ rule: 'noData', key: `k${i}`, event: 'fired', at: night }));
  const { state, deliveries } = schedule(actions, DEFAULT_CONFIG, {}, night);
  assert.equal(state._meta.queue.length, QUEUE_MAX);
  assert.deepEqual(state._meta.queue.map((a) => a.key).slice(0, 2), ['k3', 'k4']);
  const dropped = deliveries.filter((d) => d.delivery === 'skipped');
  assert.deepEqual(dropped.map((d) => [d.key, d.reason]), [['k0', 'queueFull'], ['k1', 'queueFull'], ['k2', 'queueFull']]);
  assert.equal(deliveries.filter((d) => d.delivery === 'queued').length, QUEUE_MAX + 3);
  // a later night run drops the next oldest
  const next = schedule([{ rule: 'noData', key: 'late', event: 'fired', at: night }], DEFAULT_CONFIG, state, night + MIN);
  assert.equal(next.state._meta.queue.length, QUEUE_MAX);
  assert.deepEqual(next.deliveries.map((d) => [d.key, d.delivery]), [['late', 'queued'], ['k3', 'skipped']]);
});

test('no more than 10 emails per hour, the rest logged as skipped', async () => {
  const s = setup();
  for (let i = 1; i <= 12; i++) s.store.saveAlarm(hit(i, `Inverter fault ${i}`, T0 - i * MIN));
  await s.run(T0);
  assert.equal(s.transport.sent.length, 10);
  const skipped = s.engine.history().filter((r) => r.delivery === 'skipped');
  assert.deepEqual(skipped.map((r) => r.reason), ['rateLimit', 'rateLimit']);
  assert.deepEqual(await s.engine.sendTest('x@example.com'), { ok: false, error: 'rate limit: 10 emails per hour' });
  s.store.saveAlarm(hit(13, 'Inverter fault 13', T0 + 61 * MIN));
  await s.run(T0 + 62 * MIN); // the hour has rolled over
  assert.equal(s.transport.sent.length, 11);
});

test('history is never emailed: 730 days of past alarms send nothing, an ongoing cut does', async () => {
  const s = setup();
  for (let d = 0; d < 730; d++) {
    const occ = T0 - d * DAY - 3 * HOUR;
    s.store.saveAlarm(hit(3 * d + 1, 'Grid loss', occ, occ + HOUR));
    s.store.saveAlarm(hit(3 * d + 2, 'Battery dischargeable capacity low', occ, occ + 2 * HOUR));
    s.store.saveAlarm(hit(3 * d + 3, 'Inverter fault', occ, occ + HOUR));
  }
  s.store.saveAlarm(hit(9999, 'Grid loss', T0 - 10 * MIN)); // started before the engine was armed, still going
  await s.run(T0);
  assert.equal(s.transport.sent.length, 1);
  assert.deepEqual(s.engine.history().map((r) => [r.rule, r.event]), [['gridCut', 'fired']]);
  await s.run(T0 + 5 * MIN);
  assert.equal(s.transport.sent.length, 1);
});

test('a cut first seen after it ended sends one past-tense email with duration and battery coverage', async () => {
  const s = setup({ config: cfgWith({ lang: 'en' }) });
  await s.run(T0);
  s.store.saveAlarm(hit(5, 'Grid loss', at(18, 12, 10), at(18, 12, 40)));
  for (let m = 10; m <= 40; m += 5) s.store.saveSample(at(18, 12, m), { load_kw: 0.5, battery_kw: -0.5 });
  await s.run(at(18, 13));
  assert.equal(s.transport.sent.length, 1);
  const [mail] = s.transport.sent;
  assert.match(mail.subject, /^\[Casa\]: there was a power cut from 12:10 to 12:40/);
  assert.match(mail.text, /30 min/);
  assert.match(mail.text, /battery kept the house powered/);
  await s.run(at(18, 13, 5));
  assert.equal(s.transport.sent.length, 1);
});

test('a late alarm that moves a cut start earlier does not send a false resolve', () => {
  const cut = (start) => ({ kind: 'gridCut', start, end: T0, ongoing: true, names: [] });
  const first = evaluate(snap({ events: [cut(T0 - 10 * MIN)] }), DEFAULT_CONFIG, {}, T0);
  assert.deepEqual(first.actions.map((a) => a.event), ['fired']);
  const later = evaluate(snap({ events: [cut(T0 - 20 * MIN)] }), DEFAULT_CONFIG, first.state, T0 + 5 * MIN);
  assert.deepEqual(later.actions, []);
  assert.equal(later.state[`gridCut:${T0 - 20 * MIN}`].status, 'firing');
});

test('a resolved cut whose start moves earlier with a late alarm is not emailed again', () => {
  const cut = (start, ongoing) => ({ kind: 'gridCut', start, end: T0, ongoing, names: [] });
  const first = evaluate(snap({ events: [cut(T0 - 10 * MIN, true)] }), DEFAULT_CONFIG, {}, T0);
  assert.deepEqual(first.actions.map((a) => a.event), ['fired']);
  const over = evaluate(snap({ events: [cut(T0 - 10 * MIN, false)] }), DEFAULT_CONFIG, first.state, T0 + 5 * MIN);
  assert.deepEqual(over.actions.map((a) => a.event), ['resolved']);
  const late = evaluate(snap({ events: [cut(T0 - 20 * MIN, false)] }), DEFAULT_CONFIG, over.state, T0 + 10 * MIN);
  assert.deepEqual(late.actions, []);
});

test('alert state is written only when it changed', async () => {
  const store = new Store(':memory:');
  let writes = 0;
  const orig = store.saveAlertState.bind(store);
  store.saveAlertState = (m) => { writes++; return orig(m); };
  const s = setup({ store });
  await s.run(T0);
  const afterFirst = writes;
  await s.run(T0 + 30e3);
  await s.run(T0 + 60e3);
  assert.equal(writes, afterFirst);
});

test('deviceAlarm skips internet losses and severities above the threshold', () => {
  const alarms = [
    row(1, 'Network connection abnormal', T0 - HOUR),
    row(2, 'Fan fault', T0 - HOUR, null, 3),
    row(3, 'Off-grid output overload', T0 - HOUR, null, 2),
    row(4, 'Insulation resistance low', T0 - HOUR, null, 1),
    row(5, 'Grid loss', T0 - HOUR),
    row(6, 'Battery dischargeable capacity low', T0 - HOUR),
  ];
  const keys = (cfg) => evaluate(snap({ alarms }), cfg, {}, T0).actions.map((a) => a.key).sort();
  assert.deepEqual(keys(only('deviceAlarm')), ['deviceAlarm:3', 'deviceAlarm:4']);
  assert.deepEqual(keys(only('deviceAlarm', { params: { maxSeverity: 3 } })), ['deviceAlarm:2', 'deviceAlarm:3', 'deviceAlarm:4']);
});

test('without SMTP every alert is logged as not sent and state still advances', async () => {
  const s = setup({ transport: null });
  s.store.saveSample(T0, { load_kw: 0.4 });
  await s.run(T0 + 31 * MIN);
  const [r] = s.engine.history();
  assert.deepEqual([r.rule, r.event, r.delivery, r.reason], ['noData', 'fired', 'skipped', 'noSmtp']);
  assert.ok(r.title && r.body);
  assert.deepEqual(s.engine.status(), { smtpConfigured: false, firing: ['noData'] });
  assert.ok(s.logs.some((l) => /not sent/.test(l)));
  await s.run(T0 + 40 * MIN);
  assert.equal(s.engine.history().length, 1);
  assert.deepEqual(await s.engine.sendTest('x@example.com'), { ok: false, error: 'email is not set up' });
});

test('a restarted engine on the same store does not repeat a fired alert', async () => {
  const store = new Store(':memory:');
  const transport = fakeTransport();
  store.saveAlarm(hit(1, 'Grid loss', T0 - 5 * MIN));
  await setup({ store, transport }).run(T0);
  const b = setup({ store, transport, start: T0 + 5 * MIN });
  await b.run();
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(b.engine.status().firing, [`gridCut:${T0 - 5 * MIN}`]);
});

test('a failed email is retried on a later run and sent once the transport works, and is not retried after 24 hours', async () => {
  const transport = {
    sent: [], attempts: 0, fail: true,
    async send(m) {
      this.attempts++;
      if (this.fail) throw new Error('connect ETIMEDOUT');
      this.sent.push(m);
    },
  };
  const s = setup({ transport, config: cfgWith({}, { deviceAlarm: { repeatHours: 0 } }) });
  s.store.saveAlarm(hit(1, 'Inverter fault', T0 - MIN));
  await s.run(T0);
  assert.deepEqual([s.engine.history()[0].delivery, s.engine.history()[0].error], ['failed', 'connect ETIMEDOUT']);
  await s.run(T0 + MIN); // backoff: not retried yet
  assert.equal(transport.attempts, 1);
  transport.fail = false;
  await s.run(T0 + 3 * MIN);
  assert.equal(transport.sent.length, 1);
  assert.deepEqual([s.engine.history()[0].delivery, s.engine.history()[0].error], ['sent', null]);
  await s.run(T0 + 10 * MIN);
  assert.equal(transport.sent.length, 1);

  transport.fail = true;
  s.store.saveAlarm(hit(2, 'Inverter fault 2', T0 + 20 * MIN));
  await s.run(T0 + 21 * MIN);
  transport.fail = false;
  await s.run(T0 + 21 * MIN + 25 * HOUR);
  assert.equal(transport.sent.length, 1);
  assert.equal(s.engine.history()[0].delivery, 'failed');
});

test('daily summary and monthly report are sent once at their time', async () => {
  const s = setup({ start: at(1, 7, 0, 11), config: cfgWith({ lang: 'en' }) });
  s.store.saveDaily('2026-11-15', { pv_kwh: 10, load_kwh: 8, import_kwh: 2, export_kwh: 4 });
  s.store.saveDaily('2026-12-01', { pv_kwh: 5, load_kwh: 6, import_kwh: 1.5, export_kwh: 0.5 });
  await s.run(); // first start arms the engine
  await s.run(at(1, 7, 59, 11));
  assert.equal(s.transport.sent.length, 0);
  await s.run(at(1, 8, 0, 11));
  assert.equal(s.transport.sent.length, 1);
  assert.match(s.transport.sent[0].subject, /^\[Casa\]: November 2026/);
  assert.match(s.transport.sent[0].text, /Produced: 10 kWh/);
  await s.run(at(1, 8, 5, 11));
  assert.equal(s.transport.sent.length, 1);
  assert.ok(s.engine.setConfig(cfgWith({ lang: 'en' }, { dailySummary: { enabled: true } })).config);
  await s.run(at(1, 21, 0, 11));
  assert.equal(s.transport.sent.length, 2);
  assert.match(s.transport.sent[1].text, /Produced: 5 kWh/);
  await s.run(at(1, 21, 10, 11));
  await s.run(at(2, 8, 0, 11));
  assert.equal(s.transport.sent.length, 2);
  await s.run(at(2, 21, 0, 11));
  assert.equal(s.transport.sent.length, 3);
  assert.deepEqual(s.engine.history().map((r) => r.event), ['report', 'report', 'report']);
});

test('config validation reports field paths; the config api round-trips and never exposes SMTP credentials', async () => {
  const bad = validateConfig({
    recipients: ['nope', 'a@b.example\r\nBcc: x@y.example'],
    lang: 'fr',
    quiet: { from: '25:00', to: '08:00' },
    rules: [
      { id: 'noData', params: { minutes: 2 } },
      { id: 'batteryLowInCut', params: { soc: 0 } },
      { id: 'deviceAlarm', params: { maxSeverity: 5 } },
      { id: 'dailySummary', params: { time: '9pm' } },
      { id: 'gridCut', enabled: 'yes' },
    ],
  });
  assert.deepEqual(Object.keys(bad.fields).sort(), [
    'lang', 'quiet.from', 'recipients.0', 'recipients.1', 'rules.batteryLowInCut.params.soc', 'rules.dailySummary.params.time',
    'rules.deviceAlarm.params.maxSeverity', 'rules.gridCut.enabled', 'rules.noData.params.minutes',
  ]);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, recipients: Array(11).fill('a@b.example') }).fields.recipients);
  assert.deepEqual(validateConfig(DEFAULT_CONFIG).config, DEFAULT_CONFIG);

  const env = {
    SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'secret-user', SMTP_PASS: 'secret-pass-123', SMTP_FROM: 'Casa <casa@example.com>',
  };
  const s = setup({ appConfig: { smtp: smtpInfo(env) } });
  const srv = await startTestServer({ store: s.store, alerts: s.engine });
  try {
    const raw = await (await srv.request('/api/alerts/config')).text();
    assert.doesNotMatch(raw, /secret-user|secret-pass/);
    const cfg = JSON.parse(raw);
    assert.deepEqual(cfg.smtp, { configured: true, host: 'smtp.example.com', from: 'Casa <casa@example.com>' });
    assert.deepEqual(cfg.recipients, ['owner@example.com']);
    assert.deepEqual(cfg.rules.map((r) => r.id), RULES);
    cfg.rules.find((r) => r.id === 'noData').params.minutes = 45;
    cfg.lang = 'en';
    const put = await srv.request('/api/alerts/config', { method: 'PUT', body: JSON.stringify(cfg) });
    assert.equal(put.status, 200);
    const stored = await put.json();
    assert.equal(stored.rules.find((r) => r.id === 'noData').params.minutes, 45);
    assert.deepEqual(await (await srv.request('/api/alerts/config')).json(), stored);
    const invalid = await srv.request('/api/alerts/config', { method: 'PUT', body: JSON.stringify({ ...cfg, quiet: { from: '22:00', to: 'x' } }) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys((await invalid.json()).fields), ['quiet.to']);
    assert.deepEqual((await (await srv.request('/api/status')).json()).alerts, { smtpConfigured: true, firing: [] });
    assert.deepEqual(await (await srv.request('/api/alerts/history?limit=5')).json(), []);
  } finally {
    await srv.close();
  }
});

test('test email returns the transport error text', async () => {
  const s = setup({ transport: failingTransport('535 5.7.8 authentication failed') });
  assert.deepEqual(await s.engine.sendTest(), { ok: false, error: '535 5.7.8 authentication failed' });
  const srv = await startTestServer({ store: s.store, alerts: s.engine });
  try {
    const res = await srv.request('/api/alerts/test', { method: 'POST', body: JSON.stringify({ to: 'x@example.com' }) });
    assert.deepEqual(await res.json(), { ok: false, error: '535 5.7.8 authentication failed' });
    const bad = await srv.request('/api/alerts/test', { method: 'POST', body: JSON.stringify({ to: 'x@example.com\nBcc: y@example.com' }) });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
  }
  const ok = setup();
  assert.deepEqual(await ok.engine.sendTest('x@example.com'), { ok: true });
  assert.equal(ok.transport.sent[0].to, 'x@example.com');
});

test('texts exist in ca and en for every rule and event, html is escaped', () => {
  const t = at(18, 14, 32);
  const FACTS = {
    noData: { since: t, authBlocked: false },
    gridCut: { start: t, end: t + 38 * MIN, batteryCovered: true },
    batteryLowInCut: { soc: 18, threshold: 20 },
    batteryLow: { start: t, end: t + HOUR },
    belowReserve: { soc: 25, reservePct: 30, since: t },
    panelsStopped: { start: t, end: t + HOUR },
    deviceAlarm: { name: '<script>x</script>', device: 'Inverter', severity: 1, start: t, end: t + HOUR },
    dailySummary: { day: '2026-11-18', pv: 10.2, load: 8, imp: 2, exp: 4.1, cost: 0.35, incidents: 1 },
    monthlyReport: { month: '2026-11', pv: 300, load: 250, imp: 60, exp: 100, bill: 30.5, savings: 40, incidents: 2, yoy: { pv: 280, load: 260, bill: 45 } },
  };
  const opts = { plantName: '<Casa & "Sol">', appUrl: 'https://solar.example/?a=1&b=<2>' };
  const cases = [];
  for (const rule of RULES) {
    if (rule === 'dailySummary' || rule === 'monthlyReport') cases.push({ rule, event: 'report', facts: FACTS[rule] });
    else {
      for (const event of ['fired', 'resolved', 'reminder']) cases.push({ rule, event, facts: FACTS[rule] });
      cases.push({ rule, event: 'fired', facts: { ...FACTS[rule], past: true } });
    }
  }
  cases.push({ rule: 'noData', event: 'fired', facts: { since: t, authBlocked: true } });
  cases.push({ rule: 'gridCut', event: 'resolved', facts: { ...FACTS.gridCut, batteryCovered: 'overload' } });
  cases.push({ rule: 'monthlyReport', event: 'report', facts: { ...FACTS.monthlyReport, bill: null, savings: null, yoy: null } });
  cases.push({ rule: 'digest', event: 'digest', items: cases.slice(0, 3).map((c) => ({ ...c, at: t })) });
  cases.push({ rule: 'test', event: 'test' });
  for (const c of cases) {
    const subjects = {};
    for (const lang of ['ca', 'en']) {
      const m = render(lang, { at: t, ...c }, opts);
      const where = `${lang} ${c.rule} ${c.event}`;
      assert.ok(m.subject.startsWith('[<Casa & "Sol">]: ') && m.subject.length > 22, where);
      assert.doesNotMatch(m.subject + m.text, /undefined|NaN|null|\[object/, where);
      assert.match(m.text, /https:\/\/solar\.example\/\?a=1&b=<2>/, where);
      assert.match(m.html, /&lt;Casa &amp; &quot;Sol&quot;&gt;/, where);
      assert.doesNotMatch(m.html, /<Casa|<script>|<2>/, where);
      subjects[lang] = m.subject;
    }
    assert.notEqual(subjects.ca, subjects.en, `${c.rule} ${c.event}`);
  }
  const noLink = render('en', { at: t, rule: 'test', event: 'test' }, { plantName: 'Casa', appUrl: null });
  assert.doesNotMatch(noLink.text, /http/);
});

test('mailer is off without SMTP_HOST and builds a transport without contacting the server', async () => {
  assert.equal(await createTransport({}), null);
  const t = await createTransport({ SMTP_HOST: 'smtp.invalid', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'a@b.example' });
  assert.equal(typeof t.send, 'function');
  assert.deepEqual(smtpInfo({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }), { host: 'h', from: null });
});
