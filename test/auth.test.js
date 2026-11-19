import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.js';
import { sessionKey, signSession } from '../src/auth.js';
import { FONTS } from '../src/static.js';
import { safeNext } from '../public/js/login.js';
import { startTestServer } from './helpers.js';

const DAY = 24 * 60 * 60e3;
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const COOKIE_RE = /^ofs_session=\d+\.[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/;

const login = (base, password, headers = {}) =>
  fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: JSON.stringify({ password }),
  });

async function withServer(opts, fn) {
  const store = opts.store ?? new Store(':memory:');
  const t = await startTestServer({ ...opts, store });
  try {
    await fn({ ...t, store });
  } finally {
    await t.close();
  }
}

test('unauthenticated api requests get 401 json', () =>
  withServer({}, async ({ base }) => {
    for (const p of ['/api/status', '/api/days?from=2026-01-01&to=2026-01-02']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 401, p);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.deepEqual(await res.json(), { error: 'login required' });
    }
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' } });
    assert.equal(out.status, 401);
  }));

test('unauthenticated page requests redirect to login', () =>
  withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login?next=%2F');
    const page = await fetch(`${base}/index.html?a=1`, { redirect: 'manual' });
    assert.equal(page.headers.get('location'), `/login?next=${encodeURIComponent('/index.html?a=1')}`);
    assert.equal((await fetch(`${base}/app.js`)).status, 401);
  }));

test('public paths answer without a session', () =>
  withServer({}, async ({ base }) => {
    const page = await fetch(`${base}/login`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /autocomplete="current-password"/);
    const icons = await fetch(`${base}/icons.svg`);
    assert.equal(icons.status, 200);
    assert.equal(icons.headers.get('content-type'), 'image/svg+xml');
    assert.match(await icons.text(), /<symbol id="sun"/);
    for (const f of Object.keys(FONTS)) {
      const res = await fetch(base + f);
      assert.equal(res.status, 200, f);
      assert.equal(res.headers.get('content-type'), 'font/woff2');
      assert.match(res.headers.get('cache-control'), /max-age=86400/);
    }
    assert.equal((await fetch(`${base}/fonts/inter-cyrillic-wght-normal.woff2`)).status, 404);
    for (const f of ['/js/login.js', '/css/base.css']) {
      const res = await fetch(base + f);
      assert.equal(res.status, 200, f);
      assert.equal(res.headers.get('cache-control'), 'no-store', f);
    }
    assert.equal((await fetch(`${base}/login`)).headers.get('cache-control'), 'no-cache');
  }));

test('healthz exposes only ok and turns false after 20 minutes without a tick', async () => {
  await withServer({ collector: { status: { lastTick: Date.now() } } }, async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()), ['ok']);
  });
  await withServer({ collector: { status: { lastTick: Date.now() - 21 * 60e3 } } }, async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
  });
  await withServer({ collector: { status: { lastTick: null } } }, async ({ base }) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200); // no tick yet: counts from server start
  });
  await withServer({ collector: null }, async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('correct password sets a signed HttpOnly SameSite=Lax cookie that opens the api', () =>
  withServer({}, async ({ base }) => {
    const res = await login(base, 'pw-test');
    assert.equal(res.status, 204);
    const set = res.headers.get('set-cookie');
    assert.match(set, COOKIE_RE);
    const status = await fetch(`${base}/api/status`, { headers: { cookie: set.split(';')[0] } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
  }));

test('Secure only behind a trusted https proxy', async () => {
  await withServer({ config: { trustProxy: true } }, async ({ base }) => {
    const res = await login(base, 'pw-test', { 'x-forwarded-proto': 'https' });
    assert.match(res.headers.get('set-cookie'), /; Secure$/);
    assert.doesNotMatch((await login(base, 'pw-test')).headers.get('set-cookie'), /Secure/);
  });
  await withServer({}, async ({ base }) => {
    const res = await login(base, 'pw-test', { 'x-forwarded-proto': 'https' });
    assert.equal(res.status, 204);
    assert.doesNotMatch(res.headers.get('set-cookie'), /Secure/);
  });
});

test('five wrong passwords from one ip give 429 with retry-after, even for the right password', () =>
  withServer({ failDelayMs: 300 }, async ({ base }) => {
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await login(base, 'nope');
      if (i === 0) assert.ok(performance.now() - t0 >= 290, 'failure is delayed');
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'wrong password' });
    }
    const res = await login(base, 'pw-test');
    assert.equal(res.status, 429);
    const retry = res.headers.get('retry-after');
    assert.match(retry, /^\d+$/);
    assert.ok(Number(retry) >= 1 && Number(retry) <= 900, retry);
    assert.deepEqual(await res.json(), { error: 'too many attempts', retryAfter: Number(retry) });
  }));

test('ten parallel wrong passwords get at most five 401 and the rest 429', () =>
  withServer({ failDelayMs: 300 }, async ({ base }) => {
    const codes = (await Promise.all(Array.from({ length: 10 }, () => login(base, 'nope')))).map((r) => r.status);
    assert.ok(codes.filter((c) => c === 401).length <= 5, String(codes));
    assert.equal(codes.filter((c) => c === 401 || c === 429).length, 10, String(codes));
  }));

test('thirty failures across ips lock everyone', () =>
  withServer({ config: { trustProxy: true } }, async ({ base }) => {
    for (let i = 0; i < 30; i++) {
      const res = await login(base, 'nope', { 'x-forwarded-for': `203.0.113.9, 10.0.${i >> 2}.${i}` });
      assert.equal(res.status, 401, `attempt ${i}`);
    }
    const res = await login(base, 'pw-test', { 'x-forwarded-for': '10.9.9.9' });
    assert.equal(res.status, 429);
  }));

test('the rate limit uses the last forwarded address only with TRUST_PROXY', () =>
  withServer({}, async ({ base }) => {
    // without trustProxy, spoofed x-forwarded-for values all count against the socket address
    for (let i = 0; i < 5; i++) await login(base, 'nope', { 'x-forwarded-for': `10.0.0.${i}` });
    assert.equal((await login(base, 'pw-test', { 'x-forwarded-for': '10.1.1.1' })).status, 429);
  }));

test('changing APP_PASSWORD invalidates existing cookies', async () => {
  const store = new Store(':memory:');
  let cookie;
  await withServer({ store, password: 'first' }, async (t) => {
    cookie = t.cookie;
    assert.equal((await t.request('/api/status')).status, 200);
  });
  await withServer({ store, password: 'second' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 401);
  });
});

test('tampered and expired cookies are rejected', () =>
  withServer({}, async ({ base, cookie, store }) => {
    const flip = cookie.replace(/[0-9a-f]$/, (c) => (c === '0' ? '1' : '0'));
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: flip } })).status, 401);
    const key = sessionKey(store.getKv('sessionSecret'), 'pw-test');
    const expired = `ofs_session=${signSession(key, Date.now() - 1)}`;
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: expired } })).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: 'ofs_session=garbage' } })).status, 401);
  }));

test('a session with less than 15 days left is renewed', () =>
  withServer({}, async ({ base, cookie, store }) => {
    const key = sessionKey(store.getKv('sessionSecret'), 'pw-test');
    const res = await fetch(`${base}/api/status`, { headers: { cookie: `ofs_session=${signSession(key, Date.now() + 10 * DAY)}` } });
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie');
    assert.match(set, COOKIE_RE);
    const expiry = Number(set.match(/^ofs_session=(\d+)/)[1]);
    assert.ok(Math.abs(expiry - (Date.now() + 30 * DAY)) < 60e3, String(expiry));
    // a fresh session is not renewed
    const fresh = await fetch(`${base}/api/status`, { headers: { cookie } });
    assert.equal(fresh.headers.get('set-cookie'), null);
  }));

test('mutating requests need json and a matching origin', () =>
  withServer({}, async ({ base, cookie, request }) => {
    const post = (p, headers, body = '{}') => request(p, { method: 'POST', headers, body });
    for (const p of ['/api/logout', '/api/login']) {
      const noOrigin = await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(noOrigin.status, 403, p);
      assert.equal((await post(p, { origin: 'http://evil.example' })).status, 403, p);
      assert.equal((await post(p, { origin: 'null' })).status, 403, p);
      assert.equal((await post(p, { 'content-type': 'text/plain' })).status, 415, p);
      assert.equal((await post(p, {}, JSON.stringify({ password: 'x'.repeat(17 * 1024) }))).status, 413, p);
      assert.equal((await post(p, {}, '{')).status, 400, p);
    }
    // an empty body counts as {}
    assert.equal((await request('/api/logout', { method: 'POST' })).status, 204);
    assert.equal((await request('/api/status', { method: 'DELETE' })).status, 405);
  }));

test('logout clears the cookie', () =>
  withServer({}, async ({ request }) => {
    const res = await request('/api/logout', { method: 'POST', body: '{}' });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('set-cookie'), /^ofs_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);
  }));

test('security headers are on every response', () =>
  withServer({}, async ({ base }) => {
    const responses = [
      await fetch(`${base}/healthz`),
      await fetch(`${base}/login`),
      await fetch(`${base}/api/status`),
      await fetch(`${base}/`, { redirect: 'manual' }),
      await fetch(`${base}/nope.html`, { redirect: 'manual' }),
    ];
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 401, 302, 302]);
    for (const res of responses) {
      assert.equal(res.headers.get('content-security-policy'), CSP);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    }
  }));

test('next only accepts same-origin paths', () => {
  const origin = 'http://localhost:8080';
  assert.equal(safeNext('/', origin), '/');
  assert.equal(safeNext('/#/energy?r=month', origin), '/#/energy?r=month');
  assert.equal(safeNext(null, origin), '/');
  for (const bad of ['//evil.example', '/\t/evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)']) {
    assert.equal(safeNext(bad, origin), '/', JSON.stringify(bad));
  }
});

test('main exits when APP_PASSWORD is empty', () => {
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-main-'));
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', main], {
      cwd, env: { PATH: process.env.PATH, APP_PASSWORD: '', COLLECT: '0' }, encoding: 'utf8', timeout: 10e3,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /APP_PASSWORD is required/);
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing created before the check');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
