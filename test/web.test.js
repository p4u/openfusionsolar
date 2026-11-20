// Jina client: outcomes, the snippet-only search, the keyless reader retry, the daily cap and the key's reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeb } from '../src/web.js';
import { Store } from '../src/db.js';

const KEY = 'jina_test_SECRET_123';
const NOW = Date.parse('2026-11-20T12:00:00+01:00');

// Replays steps in order ({ status, response } with response an object or a raw string, or 'timeout' / 'network')
// and records every request.
function fakeFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const fetch = async (url, init) => {
    calls.push({ url, ...init, json: init.body ? JSON.parse(init.body) : undefined });
    const step = queue.shift();
    if (!step) throw new Error('fakeFetch: no step left');
    if (step === 'network') throw new TypeError('fetch failed');
    if (step === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const body = typeof step.response === 'string' ? step.response : JSON.stringify(step.response);
    return new Response(body, { status: step.status });
  };
  return { fetch, calls };
}

function setup(steps, { apiKey = KEY, store = new Store(':memory:') } = {}) {
  const f = fakeFetch(steps);
  const logs = [];
  const web = createWeb({ apiKey, store, fetch: f.fetch, now: () => NOW, log: (l) => logs.push(l) });
  return { web, store, logs, ...f };
}

const hit = (i) => ({ title: `Result ${i} ${'t'.repeat(300)}`, url: `https://example.org/p${i}`, description: `Snippet ${i} ${'s'.repeat(500)}`, content: '' });
const searchOk = (n = 7) => ({ status: 200, response: { code: 200, status: 20000, data: Array.from({ length: n }, (_, i) => hit(i)) } });
const readOk = (content, title = 'Mercados | REE') => ({ status: 200, response: { code: 200, status: 20000, data: { title, url: 'https://elsewhere.example/', content } } });
const err = (status) => ({ status, response: { name: 'InsufficientBalanceError', message: `upstream says ${KEY}` } });

test('search posts the query in the body with the key and the snippet-only header and returns 5 trimmed results', async () => {
  const data = searchOk(7).response.data;
  data[1].url = 'http://example.org/plain'; // not https: dropped
  data[2].url = 'javascript:alert(1)';
  const t = setup([{ status: 200, response: { data } }]);
  const r = await t.web.search('preu PVPC avui');
  assert.equal(t.calls.length, 1);
  const c = t.calls[0];
  assert.equal(c.url, 'https://s.jina.ai/');
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.json, { q: 'preu PVPC avui' });
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.equal(c.headers.accept, 'application/json');
  assert.equal(c.headers['x-respond-with'], 'no-content');
  assert.equal(r.results.length, 5);
  assert.deepEqual(r.results.map((x) => x.url), [0, 3, 4, 5, 6].map((i) => `https://example.org/p${i}`));
  for (const x of r.results) {
    assert.equal(x.title.length, 200);
    assert.equal(x.snippet.length, 400);
  }
  assert.deepEqual(t.store.getKv('web'), { lastError: null, at: NOW });
  assert.equal(t.store.countUsage(['web_search'], 0), 1);
});

test('search drops results read_web_page could not read: an ip address, a port, a local host', async () => {
  const data = searchOk(7).response.data;
  data[0].url = 'https://192.168.1.1/';
  data[1].url = 'https://example.org:8443/p1';
  data[2].url = 'https://router/x';
  const t = setup([{ status: 200, response: { data } }]);
  const r = await t.web.search('preu PVPC');
  assert.deepEqual(r.results.map((x) => x.url), [3, 4, 5, 6].map((i) => `https://example.org/p${i}`));
});

test('search without a key returns no_key and makes no request', async () => {
  const t = setup([], { apiKey: '' });
  assert.deepEqual(await t.web.search('preu PVPC'), { unavailable: 'no_key' });
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.web.status(), { available: false, lastError: null });
});

test('402 gives no_balance and kv web keeps it, 401 gives bad_key, 429/500/timeout give error', async () => {
  const t = setup([err(402)]);
  assert.deepEqual(await t.web.search('q'), { unavailable: 'no_balance' });
  assert.equal(t.store.getKv('web').lastError, 'no_balance');
  assert.deepEqual(t.web.status(), { available: false, lastError: 'no_balance' });
  assert.deepEqual(t.logs, ['web search error no_balance']);

  const t2 = setup([err(401)]);
  assert.deepEqual(await t2.web.search('q'), { unavailable: 'bad_key' });
  assert.deepEqual(t2.web.status(), { available: false, lastError: 'bad_key' });

  for (const step of [err(429), err(500), err(503), 'timeout', 'network', { status: 200, response: 'not json' }, { status: 200, response: { data: null } }]) {
    const t3 = setup([step]);
    assert.deepEqual(await t3.web.search('q'), { unavailable: 'error' }, JSON.stringify(step));
    assert.deepEqual(t3.web.status(), { available: true, lastError: 'error' });
    assert.equal(t3.store.countUsage(['web_search', 'web_read'], 0), 0);
  }
});

test('read retries once without the key on 402 and strips images and link targets to 6000 chars', async () => {
  const page = '# Mercados\n![logo](https://img.example/l.png) Precio [PVPC](https://www.ree.es/pvpc) hoy. '
    + '[![badge](https://img.example/b.svg)](https://x.example/) Ver https://www.ree.es/es plano.\n' + 'x'.repeat(7000);
  const t = setup([err(402), readOk(page)]);
  const r = await t.web.read('https://www.ree.es/es/datos/mercados');
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal('authorization' in t.calls[1].headers, false);
  assert.deepEqual(t.calls[1].json, { url: 'https://www.ree.es/es/datos/mercados' });
  assert.equal(r.title, 'Mercados | REE');
  assert.equal(r.url, 'https://www.ree.es/es/datos/mercados'); // the url asked for, not the one Jina reports
  assert.equal(r.text.length, 6000);
  assert.ok(r.text.startsWith('# Mercados\n Precio PVPC hoy.  Ver https://www.ree.es/es plano.\n'), r.text.slice(0, 80));
  assert.doesNotMatch(r.text, /img\.example|\]\(/);
  // the keyless success counts as a call but does not clear the key's error
  assert.equal(t.store.countUsage(['web_read'], 0), 1);
  assert.deepEqual(t.web.status(), { available: false, lastError: 'no_balance' });
});

test('read without a key goes keyless once; a 500 is not retried', async () => {
  const t = setup([readOk('hola')], { apiKey: '' });
  assert.equal((await t.web.read('https://www.ree.es/')).text, 'hola');
  assert.equal(t.calls.length, 1);
  assert.equal('authorization' in t.calls[0].headers, false);

  const t2 = setup([err(500)]);
  assert.deepEqual(await t2.web.read('https://www.ree.es/'), { unavailable: 'error' });
  assert.equal(t2.calls.length, 1);
  assert.deepEqual(t2.logs, ['web read error error']);
});

test('read sends the url in the body, not the path, and no other option', async () => {
  const t = setup([readOk('ok')]);
  await t.web.read('https://www.boe.es/buscar/doc.php?id=BOE-A-2019-5089');
  assert.equal(t.calls[0].url, 'https://r.jina.ai/');
  assert.equal(t.calls[0].method, 'POST');
  assert.deepEqual(t.calls[0].json, { url: 'https://www.boe.es/buscar/doc.php?id=BOE-A-2019-5089' });
  assert.deepEqual(Object.keys(t.calls[0].headers).sort(), ['accept', 'authorization', 'content-type']);
});

test('read sends the canonical url (a backslash, tab or dot-segment spelling arrives as https://host/path)', async () => {
  for (const raw of ['https:\\\\www.ree.es:443\\es/datos/mercados', 'https://www.ree.es:\t443/es/datos/mercados',
    'https://www.ree.es/es/datos/../datos/mercados', 'https://WWW.REE.ES/es/datos/mercados\n']) {
    const t = setup([readOk('ok')]);
    await t.web.read(raw);
    assert.deepEqual(t.calls[0].json, { url: 'https://www.ree.es/es/datos/mercados' }, JSON.stringify(raw));
  }
  for (const raw of ['http://www.ree.es/', 'javascript:alert(1)', 'not a url', 'file:///etc/passwd']) {
    const t = setup([]);
    assert.deepEqual(await t.web.read(raw), { unavailable: 'error' });
    assert.equal(t.calls.length, 0);
  }
});

test('a 61st successful call of the local day is daily_limit; failures are not counted', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 59; i++) store.addUsage({ ts: NOW - 3600e3, job: i % 2 ? 'web_search' : 'web_read', model: 'jina', cost_usd: 0 });
  store.addUsage({ ts: NOW - 24 * 3600e3, job: 'web_search', model: 'jina', cost_usd: 0 }); // yesterday
  store.addUsage({ ts: NOW - 3600e3, job: 'chat', model: 'x', cost_usd: 0.01 }); // another job
  const t = setup([err(500), searchOk(), readOk('x')], { store });
  assert.deepEqual(await t.web.search('q'), { unavailable: 'error' }); // not counted
  assert.equal((await t.web.search('q')).results.length, 5); // the 60th
  assert.deepEqual(await t.web.search('q'), { unavailable: 'daily_limit' });
  assert.deepEqual(await t.web.read('https://www.ree.es/'), { unavailable: 'daily_limit' });
  assert.equal(t.calls.length, 2);
});

test('a body over 1 MB is error', async () => {
  const big = JSON.stringify({ data: [{ title: 'x', url: 'https://a.example/', description: 'y'.repeat(1024 * 1024) }] });
  const t = setup([{ status: 200, response: big }]);
  assert.deepEqual(await t.web.search('q'), { unavailable: 'error' });
  const t2 = setup([{ status: 200, response: big }]);
  assert.deepEqual(await t2.web.read('https://www.ree.es/'), { unavailable: 'error' });
});

test('the key appears in no log line, error, kv value or status()', async () => {
  const out = [];
  for (const steps of [[err(401)], [err(402)], [err(429)], ['timeout'], ['network'], [searchOk()], [{ status: 200, response: `{"x":"${KEY}"` }]]) {
    const t = setup(steps);
    out.push(await t.web.search('q'), t.logs, t.store.getKv('web'), t.web.status());
  }
  for (const steps of [[err(402), err(402)], [err(401), readOk(`page ${'z'.repeat(10)}`)], ['network']]) {
    const t = setup(steps);
    out.push(await t.web.read('https://www.ree.es/'), t.logs, t.store.getKv('web'), t.web.status());
  }
  const t = setup([]);
  const web = createWeb({ apiKey: KEY, store: t.store, fetch: async () => { throw new Error(`boom ${KEY}`); } });
  out.push(await web.search('q'), await web.read('https://www.ree.es/'));
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
});

test('countUsage counts the given jobs since a time', () => {
  const store = new Store(':memory:');
  const add = (ts, job) => store.addUsage({ ts, job, model: 'm', cost_usd: 0 });
  add(100, 'web_search');
  add(200, 'web_read');
  add(200, 'chat');
  add(300, 'web_search');
  add(50, 'web_read');
  assert.equal(store.countUsage(['web_search', 'web_read'], 100), 3);
  assert.equal(store.countUsage(['web_search'], 0), 2);
  assert.equal(store.countUsage(['web_read'], 201), 0);
  assert.equal(store.countUsage([], 0), 0);
});
