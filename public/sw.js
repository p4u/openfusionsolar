// Service worker (scope /): the app shell offline, the last /api/status for the Now view, nothing else from /api.
// Bump VERSION when the shell list changes; a changed file makes the browser install the new worker, and the app
// offers "New version available" until the user accepts (no skipWaiting on install).
const VERSION = 4;
const SHELL = `ofs-shell-v${VERSION}`;
const DATA = 'ofs-data'; // the last good /api/status only; dropped on logout and on a 401
const STATUS = '/api/status';

// Served without a session (server.js PUBLIC_PATHS and fonts): the install fails if one is missing.
const PUBLIC_SHELL = [
  '/login', '/offline.html', '/manifest.webmanifest', '/favicon.svg', '/icons.svg',
  '/icons/icon.svg', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png',
  '/css/tokens.css', '/css/base.css', '/css/login.css', '/js/login.js', '/js/i18n.js', '/js/i18n/core.js', '/js/theme.js',
  '/fonts/inter-latin-wght-normal.woff2', '/fonts/inter-latin-ext-wght-normal.woff2',
  '/fonts/eb-garamond-latin-wght-normal.woff2', '/fonts/eb-garamond-latin-ext-wght-normal.woff2',
];
// Behind the login: cached when the worker installs with a session, otherwise on first use.
const APP_SHELL = [
  '/', '/vendor/apexcharts.js',
  '/css/charts.css', '/css/views/assistant.css', '/css/views/battery.css', '/css/views/bill.css', '/css/views/billing.css',
  '/css/views/energy.css', '/css/views/incidents.css', '/css/views/invoices.css',
  '/css/views/now.css', '/css/views/panels.css', '/css/views/settings.css', '/css/views/signals.css',
  '/js/alert-catalogue.js', '/js/api.js', '/js/app.js', '/js/buckets.js', '/js/chart-data.js', '/js/chart-presets.js', '/js/charts.js',
  '/js/format.js', '/js/incidents.js', '/js/privacy.js', '/js/range-bar.js', '/js/range.js', '/js/routes.js', '/js/ui.js', '/js/upload.js',
  '/js/i18n/assistant.js', '/js/i18n/battery.js', '/js/i18n/bill.js', '/js/i18n/billing.js', '/js/i18n/charts.js', '/js/i18n/energy.js',
  '/js/i18n/incidents.js', '/js/i18n/invoices.js',
  '/js/i18n/now.js', '/js/i18n/panels.js', '/js/i18n/settings.js', '/js/i18n/signals.js',
  '/js/views/assistant.js', '/js/views/assistant-model.js', '/js/views/billing.js', '/js/views/billing-model.js',
  '/js/views/invoices.js', '/js/views/invoices-model.js',
  '/js/views/battery.js', '/js/views/battery-model.js', '/js/views/bill.js', '/js/views/bill-model.js',
  '/js/views/energy.js', '/js/views/energy-model.js', '/js/views/incidents.js', '/js/views/incidents-model.js',
  '/js/views/now.js', '/js/views/now-model.js', '/js/views/panels.js', '/js/views/panels-model.js',
  '/js/views/settings.js', '/js/views/settings-model.js', '/js/views/signals.js', '/js/views/signals-model.js',
];

// Only a plain 200 from this origin is kept: never a redirect to the login, a 401 or an error page.
const cacheable = (res) => res.ok && res.type === 'basic' && !res.redirected;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PUBLIC_SHELL);
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        // an unread body keeps its connection busy: six of them stall every later request to the server
        if (cacheable(res)) await cache.put(url, res);
        else await res.body?.cancel();
      } catch { /* offline or logged out: cached on first use */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('ofs-') && name !== SHELL && name !== DATA) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Network first: the server is the truth; the cache answers only when it cannot be reached.
async function networkFirst(request, fallback) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (cacheable(res)) await cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    if (fallback) return (await cache.match(fallback)) ?? Response.error();
    throw err;
  }
}

// The last known status, marked so the app can say it is offline and from when.
async function status(request) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(STATUS, res.clone());
    else if (res.status === 401) await cache.delete(STATUS);
    return res;
  } catch (err) {
    const hit = await cache.match(STATUS);
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set('x-ofs-offline', '1');
    return new Response(hit.body, { status: hit.status, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === STATUS) return event.respondWith(status(request));
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/sw.js') return; // network only
  event.respondWith(networkFirst(request, request.mode === 'navigate' ? '/offline.html' : null));
});
