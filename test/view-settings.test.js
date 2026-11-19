import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, RULES, validateConfig } from '../src/alerts.js';
import dict from '../public/js/i18n/settings.js';
import { ruleSentenceParts, splitSentence, fieldErrorsByInput, lastFired, deliveryWords, setField } from '../public/js/views/settings-model.js';

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
    ...['noSmtp', 'noRecipients', 'cooldown', 'rateLimit'].map((reason) => ({ delivery: 'skipped', reason }))];
  for (const r of rows) for (const lang of ['en', 'ca']) assert.ok(dict[lang][deliveryWords(r).key], `${lang} ${r.delivery} ${r.reason}`);
  assert.equal(deliveryWords(rows[2]).detail, 'boom');
});

test('glossary has the same entries in both languages', () => {
  assert.equal(dict.en['settings.glossary'].length, 11);
  assert.equal(dict.ca['settings.glossary'].length, 11);
});
