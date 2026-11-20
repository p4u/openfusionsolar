// Installable app: manifest, icons, service worker and offline page, served without a session and kept in step with
// the files on disk (the worker's precache list is written by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.js';
import { PUBLIC_PATHS } from '../src/server.js';
import { FONTS } from '../src/static.js';
import { startTestServer } from './helpers.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const list = (name) => [...new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(SW)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const PUBLIC_SHELL = list('PUBLIC_SHELL');
const APP_SHELL = list('APP_SHELL');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield `/${path.relative(PUBLIC, p).split(path.sep).join('/')}`;
  }
}

async function withServer(fn) {
  const t = await startTestServer({ store: new Store(':memory:') });
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

test('the worker precaches every script and stylesheet, and nothing from the api', () => {
  const all = new Set([...PUBLIC_SHELL, ...APP_SHELL]);
  assert.equal(all.size, PUBLIC_SHELL.length + APP_SHELL.length, 'no url listed twice');
  const missing = [...walk(path.join(PUBLIC, 'js')), ...walk(path.join(PUBLIC, 'css'))].filter((f) => !all.has(f));
  assert.deepEqual(missing, []);
  for (const url of all) {
    assert.ok(!url.startsWith('/api/'), url);
    const known = ['/', '/login', '/icons.svg', '/vendor/apexcharts.js'].includes(url) || url in FONTS;
    assert.ok(known || fs.statSync(path.join(PUBLIC, url)).isFile(), url);
  }
});

test('the precache before login holds only public paths', () => {
  for (const url of PUBLIC_SHELL) assert.ok(['/login', '/icons.svg'].includes(url) || url in FONTS || PUBLIC_PATHS.has(url), url);
});

test('the cache name carries the version, so an update clears the old shell', () => {
  assert.match(SW, /^const VERSION = 6;$/m); // bumped whenever the shell files change
  assert.match(SW, /const SHELL = `ofs-shell-v\$\{VERSION\}`;/);
  assert.match(SW, /name\.startsWith\('ofs-'\) && name !== SHELL && name !== DATA/);
});

test('without a session every url the worker installs with answers 200 and app files stay closed', () =>
  withServer(async ({ base }) => {
    for (const url of PUBLIC_SHELL) assert.equal((await fetch(base + url)).status, 200, url);
    for (const url of ['/js/app.js', '/js/views/now.js', '/vendor/apexcharts.js', '/css/charts.css']) {
      assert.equal((await fetch(base + url)).status, 401, url);
    }
    assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 302);
  }));

test('manifest, worker, offline page and icons have their types and headers', () =>
  withServer(async ({ base }) => {
    const m = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.equal(m.headers.get('content-type'), 'application/manifest+json');
    const manifest = await m.json();
    assert.deepEqual(
      [manifest.name, manifest.short_name, manifest.start_url, manifest.scope, manifest.display],
      ['OpenFusionSolar', 'Solar', '/', '/', 'standalone'],
    );
    assert.equal(manifest.background_color, '#f5f5f5'); // tokens.css --canvas
    assert.equal(manifest.description, 'Seguiment de la instal·lació solar, la bateria i les factures');
    assert.deepEqual(manifest.categories, ['utilities', 'productivity']);
    assert.deepEqual(manifest.shortcuts.map((s) => [s.name, s.url]), [['Assistent', '/#/assistant'], ['Factures', '/#/money'], ['Ara', '/']]);
    for (const s of manifest.shortcuts) assert.deepEqual(s.icons.map((i) => i.src), ['/icons/icon-192.png'], s.name);
    for (const size of ['192x192', '512x512']) assert.ok(manifest.icons.some((i) => i.sizes === size && i.purpose === 'any'), size);
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
    for (const icon of manifest.icons) {
      const res = await fetch(base + icon.src);
      assert.equal(res.status, 200, icon.src);
      assert.equal(res.headers.get('content-type'), icon.type, icon.src);
      if (icon.type === 'image/png') {
        const buf = Buffer.from(await res.arrayBuffer());
        assert.equal(buf.toString('latin1', 1, 4), 'PNG', icon.src);
        assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, icon.sizes, icon.src);
      }
    }

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    assert.equal(sw.headers.get('service-worker-allowed'), '/');
    assert.match(sw.headers.get('content-security-policy'), /worker-src 'self'; manifest-src 'self'/);

    // one narrow and one wide screenshot, PNG of the stated size, served without a session, not precached
    assert.deepEqual(manifest.screenshots.map((s) => [s.form_factor, s.sizes]), [['narrow', '1080x1920'], ['wide', '1920x1080']]);
    for (const shot of manifest.screenshots) {
      assert.ok(shot.label.length > 10, shot.src);
      assert.ok(PUBLIC_PATHS.has(shot.src) && !PUBLIC_SHELL.includes(shot.src) && !APP_SHELL.includes(shot.src), shot.src);
      const res = await fetch(base + shot.src);
      assert.equal(res.status, 200, shot.src);
      assert.equal(res.headers.get('content-type'), 'image/png', shot.src);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.toString('latin1', 1, 4), 'PNG', shot.src);
      assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, shot.sizes, shot.src);
    }

    const apple = await fetch(`${base}/icons/icon-180.png`);
    assert.equal(apple.headers.get('content-type'), 'image/png');
    const offline = await fetch(`${base}/offline.html`);
    assert.equal(offline.status, 200);
    assert.match(offline.headers.get('content-type'), /^text\/html/);
    assert.doesNotMatch(await offline.text(), /<script(?![^>]*src="\/js\/theme\.js")/, 'no inline script (CSP)');
  }));

test('the app page lets the keyboard resize the layout', () => {
  assert.match(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), /name="viewport" content="[^"]*interactive-widget=resizes-content"/);
});

test('both pages link the manifest, the touch icon and a theme colour per scheme', () => {
  for (const page of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/, page);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/icon-180.png">/, page);
    assert.match(html, /viewport-fit=cover/, page);
    assert.match(html, /apple-mobile-web-app-capable" content="yes"/, page);
    assert.match(html, /apple-mobile-web-app-title" content="Solar"/, page);
    assert.match(html, /name="theme-color" content="#f5f5f5" media="\(prefers-color-scheme: light\)"/, page);
    assert.match(html, /name="theme-color" content="#0c0a09" media="\(prefers-color-scheme: dark\)"/, page);
  }
});
