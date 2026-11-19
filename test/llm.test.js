process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLlm, LlmError, DEFAULT_MODEL, PRICES } from '../src/llm.js';
import { fakeFetch, fixture } from './fixtures/llm/fake.js';

const KEY = 'sk-test-SECRET';
const NOW = Date.parse('2026-11-19T12:00:00+01:00');
const ok = fixture('chat-final');
const messages = [{ role: 'user', content: 'hi' }];

// Fake store (task 1 owns the real one): same two methods llm.js uses.
const fakeStore = () => ({
  rows: [],
  addUsage(r) { this.rows.push(r); },
  usageCostSince(ts) { return this.rows.filter((r) => r.ts >= ts).reduce((s, r) => s + r.cost_usd, 0); },
});

function setup(steps, opts = {}) {
  const store = fakeStore();
  const f = fakeFetch(steps);
  const sleeps = [];
  const logs = [];
  const llm = createLlm({
    apiKey: KEY, store, fetch: f.fetch, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); }, log: (l) => logs.push(l), ...opts,
  });
  return { llm, store, sleeps, logs, ...f };
}
const call = (llm, extra = {}) => llm.complete({ job: 'chat', messages, maxTokens: 100, ...extra });
const code = (p) => p.then(() => assert.fail('should reject'), (e) => { assert.ok(e instanceof LlmError); return e; });

test('the request carries model, strict schema, no-training provider and the key only in the header', async () => {
  const t = setup([fixture('extract-pdf-ok')]);
  const schema = { type: 'object', properties: {} };
  const tools = [{ type: 'function', function: { name: 'x', parameters: {} } }];
  const r = await call(t.llm, { job: 'extract', schema, tools, ref: 'g1' });
  assert.deepEqual(t.calls[0], {
    model: DEFAULT_MODEL, messages, temperature: 0, max_tokens: 100, provider: { data_collection: 'deny' },
    response_format: { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema } }, tools,
  });
  assert.equal(t.headers[0].authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(t.calls[0]).includes(KEY));
  assert.equal(r.finishReason, 'stop');
  assert.equal(JSON.parse(r.message.content).is_electricity_bill, true);
  const plain = setup([ok]);
  await call(plain.llm);
  assert.ok(!('response_format' in plain.calls[0]) && !('tools' in plain.calls[0]));
});

test('usage cost is recorded per call and falls back to the price table', async () => {
  const noCost = (tokens) => ({ status: 200, response: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x' } }], usage: tokens } });
  const t = setup([fixture('extract-pdf-ok'), noCost({ prompt_tokens: 1000, completion_tokens: 200 }), noCost({ prompt_tokens: 1000, completion_tokens: 200 })]);
  const a = await call(t.llm, { job: 'extract', ref: 'g1' });
  assert.deepEqual(a.usage, { tokensIn: 4384, tokensOut: 2647, costUsd: 0.0050665 });
  assert.deepEqual(t.store.rows[0], { ts: NOW, job: 'extract', model: DEFAULT_MODEL, tokens_in: 4384, tokens_out: 2647, cost_usd: 0.0050665, ref: 'g1' });
  const b = await call(t.llm);
  const expected = 1000 * PRICES[DEFAULT_MODEL].in + 200 * PRICES[DEFAULT_MODEL].out;
  assert.equal(b.usage.costUsd, expected);
  const c = await call(t.llm, { model: 'some/other-model' });
  assert.equal(t.store.rows[2].model, 'some/other-model');
  assert.equal(c.usage.costUsd, expected, 'an unknown model without cost is charged at the default prices');
  assert.equal(t.llm.monthSpend(), 0.0050665 + 2 * expected);
});

test('the budget guard refuses before calling once the month reaches the budget', async () => {
  const t = setup([ok, ok], { budgetUsd: 5 });
  t.store.rows.push({ ts: Date.parse('2026-10-31T23:59:00+01:00'), cost_usd: 5 }); // last month: ignored
  await call(t.llm);
  assert.equal(t.calls.length, 1);
  t.store.rows.push({ ts: Date.parse('2026-11-01T00:00:00+01:00'), cost_usd: 5 }); // first instant of this month
  const e = await code(call(t.llm));
  assert.equal(e.code, 'budget');
  assert.equal(t.calls.length, 1);
  assert.equal(t.llm.budgetUsd, 5);
});

test('without a key the client is disabled and calls nothing', async () => {
  const t = setup([ok], { apiKey: '' });
  assert.equal(t.llm.enabled, false);
  assert.equal((await code(call(t.llm))).code, 'disabled');
  assert.equal(t.calls.length, 0);
});

test('429 and 5xx are retried twice, then rate_limited/upstream; a 400 is not retried', async () => {
  const s429 = fixture('upstream-429');
  let t = setup([s429, s429, s429]);
  let e = await code(call(t.llm));
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.status, 429);
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.sleeps, [1000, 3000]);
  assert.equal(t.store.rows.length, 0);

  const s503 = { status: 503, response: { error: { message: 'down' } } };
  t = setup([s503, s503, s503]);
  e = await code(call(t.llm));
  assert.equal(e.code, 'upstream');
  assert.equal(t.calls.length, 3);

  t = setup([s503, 'network', ok]);
  assert.equal((await call(t.llm)).message.content, ok.response.choices[0].message.content);
  assert.equal(t.calls.length, 3);

  t = setup([{ status: 400, response: { error: { message: 'bad' } } }, ok]);
  e = await code(call(t.llm));
  assert.equal(e.code, 'upstream');
  assert.equal(e.status, 400);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.sleeps, []);
});

test('a timeout aborts the request and is retried; an aborted caller signal is not', async () => {
  let t = setup(['timeout', ok]);
  await call(t.llm, { timeoutMs: 20 });
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.sleeps, [1000]);

  t = setup(['timeout', 'timeout', 'timeout']);
  assert.equal((await code(call(t.llm, { timeoutMs: 10 }))).code, 'timeout');
  assert.equal(t.calls.length, 3);

  t = setup(['timeout', ok]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  const e = await code(call(t.llm, { timeoutMs: 5000, signal: ac.signal }));
  assert.equal(e.code, 'timeout');
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.sleeps, []);
});

test('responses over 1 MB and without choices are bad_response', async () => {
  let t = setup([{ status: 200, response: JSON.stringify({ choices: [], pad: 'x'.repeat(1024 * 1024) }) }]);
  assert.equal((await code(call(t.llm))).code, 'bad_response');
  t = setup([{ status: 200, response: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } } }]);
  assert.equal((await code(call(t.llm))).code, 'bad_response');
  assert.equal(t.store.rows.length, 1, 'the 200 was billed, so it is recorded');
  t = setup([{ status: 200, response: 'not json' }]);
  assert.equal((await code(call(t.llm))).code, 'bad_response');
});

test('errors and logs never contain the key', async () => {
  const bodyWithKey = { error: { message: `bad key ${KEY}` } };
  const cases = [['400', { status: 400, response: bodyWithKey }], ['500', { status: 500, response: bodyWithKey }],
    ['429', { status: 429, response: bodyWithKey }], ['net', 'network'], ['junk', { status: 200, response: KEY }]];
  const seen = [];
  for (const [, step] of cases) {
    const t = setup([step, step, step]);
    const e = await code(call(t.llm, { job: 'extract' }));
    seen.push(e.message, String(e), e.stack.split('\n')[0], ...t.logs);
  }
  const t = setup([ok]);
  await call(t.llm);
  seen.push(...t.logs);
  assert.ok(seen.length > 5);
  for (const s of seen) assert.ok(!s.includes(KEY), s);
  assert.deepEqual(t.logs, [`llm chat ${DEFAULT_MODEL} 200 0 ms`]);
  const bad = setup([{ status: 400, response: {} }]);
  await code(call(bad.llm, { job: 'extract' }));
  assert.deepEqual(bad.logs, ['llm extract error upstream 400']);
});

test('fixtures hold no personal data', () => {
  const root = new URL('./fixtures/', import.meta.url).pathname;
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  })(root);
  assert.ok(files.some((f) => f.endsWith('extract-pdf-ok.json')));
  const mainRepoPatterns = '/volumes/repos/fusionsolar/openfusionsolar/.delivery/2026-11-19-billing-assistant/pii-patterns.txt';
  const extra = fs.existsSync(mainRepoPatterns)
    ? fs.readFileSync(mainRepoPatterns, 'utf8').split('\n').filter(Boolean).map((l) => new RegExp(l)) : [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    const at = path.relative(root, f);
    for (const m of txt.match(/ES\d{16}[A-Z]{2}[0-9A-Z]{0,2}/g) ?? []) assert.equal(m, 'ES0031000000000001BJ0F', at);
    for (const m of txt.matchAll(/contract_number\\?"\s*:\s*(?:\\?"(\w*)\\?"|(null))/g)) assert.ok(m[1] === '0000000' || m[2] === 'null', at);
    assert.doesNotMatch(txt, /\b\d{8}[A-Z]\b|\b[XYZ]\d{7}[A-Z]\b/, at);
    for (const m of txt.match(/\b[A-Z]\d{8}\b/g) ?? []) assert.equal(m, 'F55091367', at);
    assert.doesNotMatch(txt, /IBAN|ES\d{2}[ *\d]{16,}/, at);
    assert.doesNotMatch(txt, /base64,[A-Za-z0-9+/=]{41,}/, at);
    for (const re of extra) assert.doesNotMatch(txt, re, `${at} matches a pii pattern`);
  }
});
