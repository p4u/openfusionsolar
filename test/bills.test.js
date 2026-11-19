// Real bill amounts per month: stored in kv, validated, behind the login and the JSON + same-origin rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { startTestServer } from './helpers.js';

const put = (srv, body, headers = {}) => srv.request('/api/bills', { method: 'PUT', body: JSON.stringify(body), headers });

test('a real bill is saved, rounded to cents, listed and cleared', async () => {
  const store = new Store(':memory:');
  const srv = await startTestServer({ store });
  try {
    assert.deepEqual(await (await srv.request('/api/bills')).json(), {});
    let r = await put(srv, { month: '2026-10', amount: 61.234 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { '2026-10': 61.23 });
    await put(srv, { month: '2026-09', amount: 0 });
    assert.deepEqual(await (await srv.request('/api/bills')).json(), { '2026-10': 61.23, '2026-09': 0 });
    assert.deepEqual(store.getKv('realBills'), { '2026-10': 61.23, '2026-09': 0 }, 'kept in the database');
    r = await put(srv, { month: '2026-10', amount: null });
    assert.deepEqual(await r.json(), { '2026-09': 0 });
  } finally {
    await srv.close();
  }
});

test('bad months and amounts are refused with the field named', async () => {
  const store = new Store(':memory:');
  const srv = await startTestServer({ store });
  try {
    for (const [body, field] of [
      [{ month: '2026-13', amount: 10 }, 'month'], [{ month: '2026-1', amount: 10 }, 'month'], [{ amount: 10 }, 'month'],
      [{ month: '2026-10', amount: -1 }, 'amount'], [{ month: '2026-10', amount: '12' }, 'amount'], [{ month: '2026-10' }, 'amount'],
      [{ month: '2026-10', amount: 1e7 }, 'amount'],
    ]) {
      const r = await put(srv, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok((await r.json()).fields[field], JSON.stringify(body));
    }
    assert.equal(store.getKv('realBills') ?? null, null, 'nothing stored');
  } finally {
    await srv.close();
  }
});

test('saving needs the session, a JSON body and the same origin', async () => {
  const store = new Store(':memory:');
  const srv = await startTestServer({ store });
  try {
    const body = JSON.stringify({ month: '2026-10', amount: 10 });
    const anon = await fetch(`${srv.base}/api/bills`, { method: 'PUT', body, headers: { 'content-type': 'application/json', origin: srv.base } });
    assert.equal(anon.status, 401);
    assert.equal((await put(srv, { month: '2026-10', amount: 10 }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await put(srv, { month: '2026-10', amount: 10 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(store.getKv('realBills') ?? null, null);
  } finally {
    await srv.close();
  }
});
