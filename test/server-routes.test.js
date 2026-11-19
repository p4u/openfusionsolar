import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/db.js';
import { startServer, readBody } from '../src/server.js';
import { startTestServer } from './helpers.js';

const MB = 1024 * 1024;
const RAW_TYPES = ['application/pdf', 'image/', 'application/octet-stream'];

// Sends only the request head (no body) and resolves with the response head, so a reply proves nothing was read.
function headOnly(base, lines) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    let out = '';
    const s = net.connect(Number(port), '127.0.0.1', () => s.write(`${lines.join('\r\n')}\r\n\r\n`));
    s.on('data', (d) => {
      out += d;
      if (out.includes('\r\n\r\n')) {
        s.destroy();
        resolve(out.slice(0, out.indexOf('\r\n\r\n')));
      }
    }).on('error', reject);
  });
}

async function withServer(routes, fn, config = {}) {
  const srv = await startTestServer({ store: new Store(':memory:'), routes, config });
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

function rawRoutes(calls = []) {
  return {
    'POST /api/up': {
      body: 'raw', types: RAW_TYPES, maxBytes: MB,
      handler: async ({ req }) => {
        calls.push(1);
        const buf = await readBody(req, MB);
        if (buf == null) return [413, { error: 'too_large' }];
        return [201, { sha: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length }];
      },
    },
  };
}

test('raw route refuses json, text and form content types with 415 before reading', async () => {
  const calls = [];
  await withServer(rawRoutes(calls), async (srv) => {
    for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'image', '']) {
      const head = await headOnly(srv.base, [
        'POST /api/up HTTP/1.1', `Host: ${new URL(srv.base).host}`, `Cookie: ${srv.cookie}`, `Origin: ${srv.base}`,
        ...(type ? [`Content-Type: ${type}`] : []), 'Content-Length: 500000',
      ]);
      assert.match(head, /^HTTP\/1.1 415/, type);
    }
    assert.equal(calls.length, 0);
  });
});

test('raw route rejects a declared size over the cap with 413 and connection close', async () => {
  const calls = [];
  await withServer(rawRoutes(calls), async (srv) => {
    const head = await headOnly(srv.base, [
      'POST /api/up HTTP/1.1', `Host: ${new URL(srv.base).host}`, `Cookie: ${srv.cookie}`, `Origin: ${srv.base}`,
      'Content-Type: application/pdf', `Content-Length: ${MB + 1}`,
    ]);
    assert.match(head, /^HTTP\/1.1 413/);
    assert.match(head, /\r\nconnection: close/i);
    assert.equal(calls.length, 0);
  });
});

test('raw route needs a matching origin', async () => {
  const calls = [];
  await withServer(rawRoutes(calls), async (srv) => {
    for (const origin of ['http://evil.example', null]) {
      const res = await srv.request('/api/up', {
        method: 'POST', headers: { 'content-type': 'application/pdf', ...(origin ? { origin } : { origin: '' }) }, body: Buffer.from('%PDF-1.4\n%%EOF'),
      });
      assert.equal(res.status, 403);
    }
    assert.equal(calls.length, 0);
  });
});

test('raw route hands the unread stream to the handler', async () => {
  await withServer(rawRoutes(), async (srv) => {
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(50_000), Buffer.from('\n%%EOF')]);
    const res = await srv.request('/api/up', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { sha: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length });

    // no declared length: readBody counts and stops at the cap; the 413 closes the connection
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (sent++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    const big = await srv.request('/api/up', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: stream, duplex: 'half' });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get('connection'), 'close');
  });
});

test('json route with its own cap accepts 20 KB and the default route refuses it', async () => {
  const routes = { 'POST /api/big': { maxBytes: 32 * 1024, handler: ({ body }) => [200, { n: body.text.length }] } };
  await withServer(routes, async (srv) => {
    const body = JSON.stringify({ text: 'x'.repeat(20 * 1024) });
    const ok = await srv.request('/api/big', { method: 'POST', body });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { n: 20 * 1024 });
    const refused = await srv.request('/api/bills', { method: 'PUT', body });
    assert.equal(refused.status, 413);
    const tooBig = await srv.request('/api/big', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(33 * 1024) }) });
    assert.equal(tooBig.status, 413);
    const wrongType = await srv.request('/api/big', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body });
    assert.equal(wrongType.status, 415);
  });
});

test('buffer bodies keep route headers and override x-frame-options', async () => {
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  const routes = {
    'GET /api/file': () => [200, pdf, {
      'content-type': 'application/pdf', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
      'content-disposition': 'inline; filename="factura-1.pdf"',
    }],
  };
  await withServer(routes, async (srv) => {
    const res = await srv.request('/api/file');
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), pdf);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'self'");
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="factura-1.pdf"');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const other = await srv.request('/api/status');
    assert.equal(other.headers.get('x-frame-options'), 'DENY');
    assert.match(other.headers.get('content-security-policy'), /frame-src 'self'$/);
  });
});

test('stream routes write ndjson lines in order and abort the signal when the client goes away', async () => {
  let aborted;
  const gone = new Promise((resolve) => (aborted = resolve));
  const routes = {
    'GET /api/stream': () => [200, async (emit, signal) => {
      for (let n = 1; n <= 3; n++) emit({ type: 'step', n });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      aborted(signal.aborted);
    }],
    'GET /api/boom': () => [200, async (emit) => {
      emit({ type: 'step', n: 1 });
      throw new Error('boom');
    }],
  };
  await withServer(routes, async (srv) => {
    const ac = new AbortController();
    const res = await srv.request('/api/stream', { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (text.split('\n').length < 4) text += dec.decode((await reader.read()).value, { stream: true });
    assert.deepEqual(text.trim().split('\n').map((l) => JSON.parse(l).n), [1, 2, 3]);
    ac.abort();
    assert.equal(await Promise.race([gone, sleep(2000).then(() => 'timeout')]), true);

    const boom = await srv.request('/api/boom');
    assert.equal(boom.status, 200);
    assert.deepEqual((await boom.text()).trim().split('\n').map((l) => JSON.parse(l)), [{ type: 'step', n: 1 }, { type: 'error', code: 'internal' }]);
  });
});

test('a finished response does not abort the signal', async () => {
  let signal;
  const routes = { 'GET /api/x': (ctx) => { signal = ctx.signal; return [200, { ok: true }]; } };
  await withServer(routes, async (srv) => {
    assert.equal((await srv.request('/api/x')).status, 200);
    await sleep(20);
    assert.equal(signal.aborted, false);
  });
});

test('everything is 401 without a session', async () => {
  let called = 0;
  const routes = {
    ...rawRoutes(),
    'GET /api/file': () => (called++, [200, Buffer.from('x'), { 'content-type': 'text/plain' }]),
    'GET /api/stream': () => (called++, [200, async (emit) => emit({ n: 1 })]),
    'POST /api/big': { maxBytes: 32 * 1024, handler: () => (called++, [200, {}]) },
  };
  await withServer(routes, async (srv) => {
    const origin = srv.base;
    for (const [path, init] of [
      ['/api/up', { method: 'POST', headers: { 'content-type': 'application/pdf', origin }, body: Buffer.from('%PDF-1.4') }],
      ['/api/file', {}], ['/api/stream', {}],
      ['/api/big', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' }],
    ]) {
      const res = await fetch(srv.base + path, init);
      assert.equal(res.status, 401, path);
    }
    assert.equal(called, 0);
  });
});

test('status reports ai enabled only when configured', async () => {
  for (const [config, enabled] of [[{}, false], [{ ai: { enabled: false } }, false], [{ ai: { enabled: true } }, true]]) {
    await withServer({}, async (srv) => {
      const body = await (await srv.request('/api/status')).json();
      assert.deepEqual(body.ai, { enabled });
      assert.ok(!JSON.stringify(body).includes('apiKey'));
    }, config);
  }
});

test('an extra route that repeats a built-in one throws at start', () => {
  assert.throws(() => startServer({
    store: new Store(':memory:'), config: { password: 'x' }, port: 0, log: () => {}, routes: { 'GET /api/status': () => [200, {}] },
  }), /duplicate route GET \/api\/status/);
});
