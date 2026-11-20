import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, RULES, validateConfig } from '../src/alerts.js';
import dict from '../public/js/i18n/settings.js';
import { register, setLang } from '../public/js/i18n.js';
import { ruleSentenceParts, ruleTemplate, splitSentence, fieldErrorsByInput, lastFired, deliveryWords, setField } from '../public/js/views/settings-model.js';

test('every rule has a sentence in both languages whose placeholders are exactly its inputs', () => {
  assert.deepEqual(DEFAULT_CONFIG.rules.map((r) => r.id), RULES);
  for (const rule of DEFAULT_CONFIG.rules) {
    const inputs = ruleSentenceParts(rule).map((p) => p.name).sort();
    for (const lang of ['en', 'ca']) {
      const template = dict[lang][`settings.rule.${rule.id}`];
      assert.equal(typeof template, 'string', `${lang} ${rule.id}`);
      assert.deepEqual(splitSentence(template).filter((p) => p.input).map((p) => p.input).sort(), inputs, `${lang} ${rule.id}`);
    }
  }
});

test('the rendered rule template keeps one placeholder per input in both languages', () => {
  register(dict);
  for (const lang of ['en', 'ca']) {
    setLang(lang);
    for (const rule of DEFAULT_CONFIG.rules) {
      const inputs = splitSentence(ruleTemplate(rule)).filter((p) => p.input).map((p) => p.input).sort();
      assert.deepEqual(inputs, ruleSentenceParts(rule).map((p) => p.name).sort(), `${lang} ${rule.id}`);
    }
  }
  assert.match(ruleTemplate(DEFAULT_CONFIG.rules.find((r) => r.id === 'noData')), /durant \{minutes\} minuts/);
});

test('sentence inputs carry the server limits and the field path', () => {
  const noData = ruleSentenceParts(DEFAULT_CONFIG.rules.find((r) => r.id === 'noData'));
  assert.deepEqual(noData, [{ name: 'minutes', type: 'number', min: 5, max: 1440, path: 'rules.noData.params.minutes' }]);
  const daily = ruleSentenceParts(DEFAULT_CONFIG.rules.find((r) => r.id === 'dailySummary'));
  assert.equal(daily[0].type, 'time');
});

test('every field path the server can report maps to an input or the form-level list', () => {
  const bad = structuredClone(DEFAULT_CONFIG);
  bad.recipients = ['x', 'a@b.cc'];
  bad.quiet.from = '25:00';
  bad.rules[0].params.minutes = 1;
  bad.rules[0].repeatHours = -1;
  const { fields } = validateConfig(bad);
  const errs = fieldErrorsByInput(fields);
  assert.deepEqual(errs.map((e) => e.path).sort(), Object.keys(fields).sort());
  const by = Object.fromEntries(errs.map((e) => [e.path, e]));
  assert.equal(by['recipients.0'].area, 'recipient');
  assert.equal(by['recipients.0'].index, 0);
  assert.equal(by['quiet.from'].area, 'quiet');
  assert.deepEqual([by['rules.noData.params.minutes'].area, by['rules.noData.params.minutes'].input], ['rule', 'minutes']);
  assert.equal(by['rules.noData.repeatHours'].input, 'repeatHours');
  assert.equal(fieldErrorsByInput({ '': 'object required' })[0].area, 'form');
});

test('setField writes the value the path names', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.recipients = ['a@b.cc'];
  setField(cfg, 'rules.noData.params.minutes', 45);
  setField(cfg, 'rules.noData.enabled', false);
  setField(cfg, 'recipients.0', 'z@b.cc');
  setField(cfg, 'quiet.to', '07:00');
  setField(cfg, 'lang', 'en');
  setField(cfg, 'rules.nope.enabled', true);
  assert.equal(cfg.rules[0].params.minutes, 45);
  assert.equal(cfg.rules[0].enabled, false);
  assert.deepEqual([cfg.recipients[0], cfg.quiet.to, cfg.lang], ['z@b.cc', '07:00', 'en']);
});

test('last fired takes the newest fired or report row per rule', () => {
  const rows = [
    { rule: 'noData', event: 'resolved', ts: 9 }, { rule: 'noData', event: 'fired', ts: 8 },
    { rule: 'noData', event: 'fired', ts: 3 }, { rule: 'dailySummary', event: 'report', ts: 5 },
  ];
  assert.deepEqual(lastFired(rows), { noData: 8, dailySummary: 5 });
});

test('delivery words exist in both languages for every state and skip reason', () => {
  const rows = [{ delivery: 'sent' }, { delivery: 'queued' }, { delivery: 'failed', error: 'boom' },
    ...['noSmtp', 'noRecipients', 'cooldown', 'rateLimit', 'queueFull'].map((reason) => ({ delivery: 'skipped', reason }))];
  for (const r of rows) for (const lang of ['en', 'ca']) assert.ok(dict[lang][deliveryWords(r).key], `${lang} ${r.delivery} ${r.reason}`);
  assert.equal(deliveryWords(rows[2]).detail, 'boom');
});

test('glossary has the same entries in both languages', () => {
  assert.equal(dict.en['settings.glossary'].length, 14);
  assert.equal(dict.ca['settings.glossary'].length, 14);
  for (const k of ['periods', 'adjust', 'maxDemand', 'taxBase']) {
    for (const lang of ['en', 'ca']) assert.ok(dict[lang]['settings.glossary'].includes(dict[lang][`settings.gloss.${k}`]), `${lang} ${k}`);
  }
});

test('server validation messages are shown in the app language', async () => {
  const { errorText } = await import('../public/js/views/settings-model.js');
  register(dict);
  setLang('ca');
  const bad = structuredClone(DEFAULT_CONFIG);
  bad.recipients = ['x'];
  bad.quiet.from = '25:00';
  bad.rules[0].params.minutes = 1;
  const errs = fieldErrorsByInput(validateConfig(bad).fields);
  const by = Object.fromEntries(errs.map((e) => [e.path, e.message]));
  assert.equal(by['recipients.0'], 'Aquesta adreça electrònica no és vàlida.');
  assert.match(by['rules.noData.params.minutes'], /del 5 al 1440/);
  assert.match(by['quiet.from'], /HH:MM/);
  for (const e of errs) assert.doesNotMatch(e.message, /invalid|integer from/, e.path);
  assert.equal(errorText('something new'), 'Aquest valor no és vàlid.');
  setLang('en');
  assert.equal(errorText('invalid email address'), 'This email address is not valid.');
});

test('the FusionSolar access state is unknown until the first check', async () => {
  const { authKey } = await import('../public/js/views/settings-model.js');
  assert.equal(authKey({ lastTick: null, authBlockedUntil: 0 }, 1000), 'settings.collector.authUnknown');
  assert.equal(authKey({ lastTick: 500, authBlockedUntil: 0 }, 1000), 'settings.collector.authOk');
  assert.equal(authKey({ lastTick: null, authBlockedUntil: 2000 }, 1000), 'settings.collector.authPaused');
  for (const lang of ['en', 'ca']) assert.ok(dict[lang]['settings.collector.authUnknown'], lang);
});

test('the page checks alert settings like the server does, before sending anything', async () => {
  const { validateAlerts, fieldErrorsByInput } = await import('../public/js/views/settings-model.js');
  const ok = structuredClone(DEFAULT_CONFIG);
  assert.deepEqual(validateAlerts(ok), {});
  assert.equal(validateConfig(ok).fields, undefined, 'the server agrees');
  const bad = structuredClone(DEFAULT_CONFIG);
  bad.rules.find((r) => r.id === 'noData').params.minutes = 0;
  bad.rules.find((r) => r.id === 'batteryLowInCut').params.soc = 0;
  bad.rules.find((r) => r.id === 'dailySummary').params.time = '25:00';
  bad.rules.find((r) => r.id === 'gridCut').repeatHours = 1000;
  bad.recipients = ['a@b.cat', 'not-an-address'];
  bad.quiet.from = '';
  const fields = validateAlerts(bad);
  // same paths and messages as the server, so one code path shows them by their fields
  assert.deepEqual(fields, validateConfig(bad).fields);
  assert.deepEqual(Object.keys(fields).sort(), [
    'quiet.from', 'recipients.1', 'rules.batteryLowInCut.params.soc', 'rules.dailySummary.params.time', 'rules.gridCut.repeatHours', 'rules.noData.params.minutes',
  ]);
  // an emptied field is refused here too (the server would quietly put the default back)
  const empty = structuredClone(DEFAULT_CONFIG);
  empty.rules.find((r) => r.id === 'noData').params.minutes = null;
  assert.deepEqual(Object.keys(validateAlerts(empty)), ['rules.noData.params.minutes']);
  setLang('ca');
  assert.match(fieldErrorsByInput(fields).find((e) => e.path === 'rules.noData.params.minutes').message, /5.*1440/);
});

test('pasting several addresses adds the valid new ones and reports the rest', async () => {
  const { parseAddresses } = await import('../public/js/views/settings-model.js');
  assert.deepEqual(parseAddresses('a@b.cat, nope; <c@d.cat>\n A@B.cat e@f.cat', ['x@y.cat']), {
    add: ['a@b.cat', 'c@d.cat', 'e@f.cat'], invalid: ['nope'], already: ['A@B.cat'], full: [],
  });
  assert.deepEqual(parseAddresses('X@Y.cat', ['x@y.cat']).already, ['X@Y.cat']);
  assert.deepEqual(parseAddresses('a@b.cat c@d.cat', Array.from({ length: 19 }, (_, i) => `p${i}@b.cat`)), {
    add: ['a@b.cat'], invalid: [], already: [], full: ['c@d.cat'],
  });
  assert.deepEqual(parseAddresses('  ').add, []);
});

test('the page checks recipients like the server: valid, not repeated, at most 20', async () => {
  const { validateAlerts } = await import('../public/js/views/settings-model.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.recipients = [
    { email: 'a@b.cat', lang: 'ca', alerts: ['gridCut'] }, { email: 'A@b.cat', lang: 'en', alerts: [] },
    { email: 'nope', lang: 'en', alerts: [] }, { email: 'c@b.cat', lang: 'fr', alerts: [] },
  ];
  assert.deepEqual(validateAlerts(cfg), validateConfig(cfg).fields);
  assert.deepEqual(Object.keys(validateAlerts(cfg)).sort(), ['recipients.1', 'recipients.2', 'recipients.3.lang']);
  cfg.recipients = Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@b.cat`, lang: 'ca', alerts: [] }));
  assert.deepEqual(validateAlerts(cfg), validateConfig(cfg).fields);
  setLang('ca');
  assert.equal(fieldErrorsByInput({ 'recipients.1': 'duplicate email address' })[0].message, 'Aquesta adreça ja és a la llista.');
  assert.equal(fieldErrorsByInput({ recipients: 'up to 20 email addresses' })[0].message, 'Com a màxim 20 adreces electròniques.');
});

test('every alert of the catalogue has a name and a one-line description, every group and preset a label', async () => {
  const { GROUPS, PRESETS } = await import('../public/js/alert-catalogue.js');
  for (const lang of ['en', 'ca']) {
    for (const id of RULES) {
      assert.equal(typeof dict[lang][`settings.alert.${id}`], 'string', `${lang} ${id}`);
      assert.doesNotMatch(dict[lang][`settings.alert.${id}.desc`], /\n/, `${lang} ${id}`);
    }
    for (const g of Object.keys(GROUPS)) assert.ok(dict[lang][`settings.group.${g}`] && dict[lang][`settings.group.${g}Hint`], `${lang} ${g}`);
    for (const p of [...Object.keys(PRESETS), 'custom']) assert.ok(dict[lang][`settings.preset.${p}`], `${lang} ${p}`);
  }
  assert.equal(dict.ca['settings.preset.important'], 'Tot el que és important');
  assert.equal(dict.ca['settings.preset.urgent'], 'Només urgències');
  assert.equal(dict.ca['settings.preset.reports'], 'Només informes');
  assert.equal(dict.ca['settings.preset.custom'], 'Personalitzat');
});

test('setField writes into a recipient object', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.recipients = [{ email: 'a@b.cc', lang: 'ca', alerts: [] }];
  setField(cfg, 'recipients.0', 'z@b.cc');
  setField(cfg, 'recipients.0.lang', 'en');
  assert.deepEqual(cfg.recipients[0], { email: 'z@b.cc', lang: 'en', alerts: [] });
});

test('usage text formats dollars in both languages', async () => {
  const { usageText, usd } = await import('../public/js/views/settings-model.js');
  assert.equal(usageText({ spentUsd: 0.42, budgetUsd: 5 }, 'ca'), 'Cost de l\u2019IA aquest mes: 0,42\u00a0USD de 5\u00a0USD de l\u00edmit');
  assert.equal(usageText({ spentUsd: 0.42, budgetUsd: 5 }, 'en'), 'AI cost this month: 0.42\u00a0USD of a 5\u00a0USD limit');
  assert.equal(usageText({ spentUsd: 0, budgetUsd: 0.25 }, 'ca'), 'Cost de l\u2019IA aquest mes: 0,00\u00a0USD de 0,25\u00a0USD de l\u00edmit');
  assert.equal(usageText({ spentUsd: 1234.5, budgetUsd: 2000 }, 'en'), 'AI cost this month: 1,234.50\u00a0USD of a 2,000\u00a0USD limit');
  assert.equal(usd(0.0084, 'ca'), '<\u00a00,01\u00a0USD');
  assert.equal(usd(0.0084, 'en'), '<\u00a00.01\u00a0USD');
});

test('the web search line: available, or no key, no balance, bad key; a failed call keeps it available', async () => {
  const { webKey } = await import('../public/js/views/settings-model.js');
  const cases = [
    [{ available: true, lastError: null }, 'on'], [{ available: true, lastError: 'error' }, 'error'],
    [{ available: false, lastError: null }, 'noKey'], [{ available: false, lastError: 'error' }, 'noKey'],
    [{ available: false, lastError: 'no_balance' }, 'noBalance'], [{ available: false, lastError: 'bad_key' }, 'badKey'], [undefined, 'noKey'],
  ];
  for (const [web, key] of cases) assert.equal(webKey(web), `settings.ai.web.${key}`, JSON.stringify(web));
});

test('the install row sits in the always-shown About card, not in the assistant card', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../public/js/views/settings.js', import.meta.url), 'utf8'));
  const drawAi = src.slice(src.indexOf('async function drawAi('), src.indexOf('function plantHtml('));
  assert.ok(drawAi.length > 0);
  assert.doesNotMatch(drawAi, /data-install|installEntry/);
  const about = src.slice(src.indexOf("t('settings.about.title')"), src.indexOf('</div></section>`;'));
  assert.match(about, /data-install/);
});
