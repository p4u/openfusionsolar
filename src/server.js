// JSON API over the store plus the frontend, behind a password login (stateless signed cookie, see auth.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dayMoney } from './tariff.js';
import { buildEvents } from './events.js';
import { dayBounds, localDay } from './collector.js';
import * as aggregate from './aggregate.js';
import {
  SERIES_BUCKETS, ENERGY_BUCKETS, spanDays, legalSeriesBuckets, legalEnergyBuckets, autoSeriesBucket, autoEnergyBucket, addDays,
} from '../public/js/buckets.js';
import {
  passwordMatches, sessionKey, signSession, verifySession, createLimiter, clientIp, isHttps, cookieHeader,
} from './auth.js';
import { resolveStatic, MIME, FONTS, buildSprite } from './static.js';
import { isEmail } from './alerts.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const APEXCHARTS = fileURLToPath(new URL('../node_modules/apexcharts/dist/apexcharts.min.js', import.meta.url));
// Served without a session (the login page and what it loads). Missing ones just 404.
const PUBLIC_PATHS = new Set([
  '/js/login.js', '/js/i18n.js', '/js/i18n/core.js', '/js/theme.js', '/css/tokens.css', '/css/base.css', '/css/login.css',
  '/favicon.svg',
]);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};
const DAY_MS = 24 * 60 * 60e3;
const SESSION_MS = 30 * DAY_MS;
const RENEW_MS = 15 * DAY_MS;
const MAX_BODY = 16 * 1024;
const LOGIN_REQUIRED = { error: 'login required' };
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

const { version } = createRequire(import.meta.url)('../package.json');
const MAX_EVENT_DAYS = 800;
const MAX_ENERGY_DAYS = 36600;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Date.parse rolls impossible dates over (2026-02-30 is valid in V8); a real day round-trips unchanged.
const isDay = (d) => DAY_RE.test(d ?? '') && addDays(d, 0) === d;

// Configured values win; otherwise what FusionSolar reports for this plant. null when unknown.
export function batteryInfo(store, cfg) {
  const station = store.getKv('station') ?? {};
  const fs = store.getKv('batteryConfig') ?? {};
  const reserve = cfg.reservePct == null ? null : store.getKv('reserve');
  const src = (env, fusion) => (env != null ? 'env' : fusion != null ? 'fusionsolar' : null);
  return {
    capacityKwh: cfg.capacityKwh ?? station.batteryKwh ?? null,
    minPct: cfg.minPct ?? fs.endOfDischargePct ?? null,
    reservePct: cfg.reservePct ?? null,
    reserveSince: reserve?.since ?? null,
    chargeFromGrid: fs.chargeFromGrid ?? null,
    gridChargeCutoffPct: fs.gridChargeCutoffPct ?? null,
    endOfChargePct: fs.endOfChargePct ?? null,
    maxChargeKw: fs.maxChargeKw ?? null,
    maxDischargeKw: fs.maxDischargeKw ?? null,
    source: {
      capacityKwh: src(cfg.capacityKwh, station.batteryKwh),
      minPct: src(cfg.minPct, fs.endOfDischargePct),
      reservePct: src(cfg.reservePct, null),
      gridChargeCutoffPct: src(null, fs.gridChargeCutoffPct),
      maxChargeKw: src(null, fs.maxChargeKw),
      maxDischargeKw: src(null, fs.maxDischargeKw),
    },
  };
}

// Resolves null when the body exceeds MAX_BODY (the rest is left unread; the caller closes the connection).
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) return resolve(null);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) return chunks.push(c);
      req.removeAllListeners('data').pause();
      resolve(null);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(origin, host) {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false; // missing or opaque ("null") origin
  }
}

const readCookie = (header) => /(?:^|;\s*)ofs_session=([^;]*)/.exec(header ?? '')?.[1];

// config: { password (required), trustProxy, prices (see tariff.js) | null, battery: { capacityKwh, reservePct, minPct } }
export function startServer({
  store, collector, config = {}, port = 8080, host = '127.0.0.1', log = console.log, alerts = null, failDelayMs = 300,
}) {
  if (!config.password) throw new Error('config.password is required');
  const startedAt = Date.now();
  const trustProxy = Boolean(config.trustProxy);
  let secret = store.getKv('sessionSecret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    store.setKv('sessionSecret', secret);
  }
  const key = sessionKey(secret, config.password);
  const limiter = createLimiter();
  const sprite = buildSprite();

  const withMoney = (d) => {
    const [from, to] = dayBounds(d.day);
    // share of the day's 5-minute slots with data; below 1 the day's totals may be low
    const until = Math.min(to, Date.now()); // today: only the slots that have already happened
    const coverage = until <= from ? 1 : Math.min(1, store.countSamples(from, until) / ((until - from) / 300e3));
    return { ...d, coverage, money: dayMoney(d, config.prices) };
  };
  const range = (query) => {
    const from = Number(query.get('from'));
    const to = Number(query.get('to'));
    return Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= MAX_RANGE_MS ? [from, to] : null;
  };
  const dayRange = (query, maxDays) => {
    const [from, to] = [query.get('from') ?? '', query.get('to') ?? ''];
    if (!isDay(from) || !isDay(to) || from > to) {
      return { error: [400, { error: 'from/to (YYYY-MM-DD, from <= to) required' }] };
    }
    const n = spanDays(from, to);
    return n > maxDays ? { error: [400, { error: 'range too long' }] } : { from, to, n };
  };
  const RANGE_ERROR = [400, { error: 'from/to (unix ms, from < to, max 400 days) required' }];
  const needAlerts = (fn) => (ctx) => (alerts ? fn(ctx) : [503, { error: 'alerts are not running' }]);

  // Handler: (ctx) => [status, body, headers?], may be async. ctx = { req, url, query, body }.
  const routes = {
    'GET /api/status': () => [200, {
      station: store.getKv('station') ?? null,
      realtime: store.latestRealtime() ?? null,
      lastSampleTs: store.lastSampleTs(),
      collector: collector ? { ...collector.status, authBlockedUntil: collector.authBlockedUntil ?? 0 } : null,
      firstDay: store.firstDay(),
      firstSampleDay: store.firstSampleTs() == null ? null : localDay(store.firstSampleTs()),
      version,
      today: localDay(Date.now()),
      timeZone: process.env.TZ ?? null,
      activeAlarms: store.activeAlarms?.() ?? [],
      battery: batteryInfo(store, config.battery ?? {}),
      pricesConfigured: Boolean(config.prices),
      plantName: config.plantName ?? null,
      alerts: alerts ? alerts.status() : { smtpConfigured: false, firing: [] },
      prices: config.prices
        ? (({ p1, p2, p3, export: exp, adjust, iee, vat, contractedP1, contractedP2 }) =>
          ({ p1, p2, p3, export: exp, adjust, iee, vat, contractedP1, contractedP2 }))(config.prices)
        : null,
    }],
    'GET /api/days': ({ query }) => {
      const from = query.get('from');
      const to = query.get('to');
      if (!isDay(from) || !isDay(to) || from > to) {
        return [400, { error: 'from/to (YYYY-MM-DD, from <= to) required' }];
      }
      return [200, store.days(from, to).map(withMoney)];
    },
    'GET /api/events': ({ query }) => {
      let r;
      if (isDay(query.get('from')) && isDay(query.get('to'))) {
        const [from, to] = [query.get('from'), query.get('to')];
        if (from > to || spanDays(from, to) > MAX_EVENT_DAYS) return [400, { error: `from/to (days, from <= to, max ${MAX_EVENT_DAYS} days) required` }];
        r = [dayBounds(from)[0], dayBounds(to)[1]];
      } else {
        r = range(query);
        if (!r) return RANGE_ERROR;
      }
      const kinds = query.get('kinds')?.split(',');
      const events = buildEvents(store.alarms(...r), store.samples(...r), Date.now(), { from: r[0], to: r[1], since: store.firstSampleTs() });
      return [200, kinds ? events.filter((e) => kinds.includes(e.kind)) : events];
    },
    'GET /api/series': ({ query }) => {
      const p = dayRange(query, MAX_ENERGY_DAYS);
      if (p.error) return p.error;
      const bucket = query.get('bucket') === 'auto' ? autoSeriesBucket(p.n) : query.get('bucket');
      const legal = legalSeriesBuckets(p.n);
      if (!SERIES_BUCKETS.includes(bucket) || !legal.includes(bucket)) return [400, { error: 'bucket too fine for this range', legal }];
      return [200, aggregate.series(store, { from: p.from, to: p.to, bucket, now: Date.now() })];
    },
    'GET /api/energy': ({ query }) => {
      const p = dayRange(query, MAX_ENERGY_DAYS);
      if (p.error) return p.error;
      const bucket = query.get('bucket') === 'auto' ? autoEnergyBucket(p.n) : query.get('bucket');
      const legal = legalEnergyBuckets(p.n);
      if (!ENERGY_BUCKETS.includes(bucket) || !legal.includes(bucket)) return [400, { error: 'bucket too fine for this range', legal }];
      const compare = query.get('compare');
      if (compare && !['prev', 'yoy'].includes(compare)) return [400, { error: 'compare must be prev or yoy' }];
      return [200, aggregate.energy(store, { ...p, bucket, compare, prices: config.prices, now: Date.now() })];
    },
    'GET /api/signals': () => [200, (store.getKv('devices') ?? []).map((d) => ({
      dn: d.dn, type: d.type, name: d.name,
      signals: d.signals.map((s) => ({ ...s, ...store.signalSpan(d.dn, s.id) })),
    }))],
    'GET /api/signals/history': ({ query }) => {
      const dev = (store.getKv('devices') ?? []).find((d) => d.dn === query.get('dn'));
      if (!dev) return [404, { error: 'unknown device' }];
      const ids = (query.get('ids') ?? '').split(',').map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
      if (ids.length < 1 || ids.length > 6 || ids.some(Number.isNaN)) return [400, { error: 'ids: 1 to 6 numeric signal ids required' }];
      const p = dayRange(query, MAX_ENERGY_DAYS);
      if (p.error) return p.error;
      const bucket = query.get('bucket') === 'auto' ? autoSeriesBucket(p.n) : query.get('bucket');
      const legal = legalSeriesBuckets(p.n);
      if (!SERIES_BUCKETS.includes(bucket) || !legal.includes(bucket)) return [400, { error: 'bucket too fine for this range', legal }];
      return [200, aggregate.signalHistory(store, { dn: dev.dn, ids, from: p.from, to: p.to, bucket, meta: dev.signals })];
    },
    'GET /api/samples': ({ query }) => {
      const r = range(query);
      return r ? [200, store.samples(...r)] : RANGE_ERROR;
    },
    'GET /api/alarms': ({ query }) => {
      const r = range(query);
      return r ? [200, store.alarms(...r)] : RANGE_ERROR;
    },
    // The real amount of each monthly bill, typed in by the user to compare with the estimate: { 'YYYY-MM': euros }.
    'GET /api/bills': () => [200, store.getKv('realBills') ?? {}],
    'PUT /api/bills': ({ body }) => {
      const { month, amount } = body ?? {};
      const fields = {};
      if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fields.month = 'month must be YYYY-MM';
      if (amount !== null && !(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= 1e6)) fields.amount = 'amount must be a number from 0 to 1000000, or null to clear it';
      if (Object.keys(fields).length) return [400, { error: 'invalid', fields }];
      const bills = { ...(store.getKv('realBills') ?? {}) };
      if (amount === null) delete bills[month];
      else bills[month] = Math.round(amount * 100) / 100;
      store.setKv('realBills', bills);
      return [200, bills];
    },
    'GET /api/alerts/config': needAlerts(() => [200, alerts.getConfig()]),
    'PUT /api/alerts/config': needAlerts(({ body }) => {
      const r = alerts.setConfig(body);
      return r.fields ? [400, { error: 'invalid', fields: r.fields }] : [200, r.config];
    }),
    'POST /api/alerts/test': needAlerts(async ({ body }) => {
      const to = body?.to;
      if (to != null && !isEmail(to)) return [400, { error: 'invalid', fields: { to: 'invalid email address' } }];
      return [200, await alerts.sendTest(to ?? undefined)];
    }),
    'GET /api/alerts/history': needAlerts(({ query }) => {
      const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '50', 10) || 50, 1), 200);
      const before = query.get('before') == null ? undefined : Number(query.get('before'));
      if (before !== undefined && !Number.isInteger(before)) return [400, { error: 'before must be an integer id' }];
      return [200, alerts.history({ limit, before })];
    }),
    'POST /api/logout': ({ req }) => [204, null, { 'set-cookie': cookieHeader('', { maxAgeS: 0, secure: isHttps(req, trustProxy) }) }],
  };
  const routePaths = new Set(Object.keys(routes).map((k) => k.slice(k.indexOf(' ') + 1)));

  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { ...(status !== 204 && { 'content-type': 'application/json' }), 'cache-control': 'no-store', ...headers });
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };
    // scripts and styles are never stored: after an update the browser must not run a stale module
    const sendFile = (abs, cacheControl = /^\/(js|css)\//.test(url?.pathname) ? 'no-store' : 'no-cache') => {
      if (!abs) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)], 'cache-control': cacheControl });
      fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
    };
    const newCookie = () =>
      cookieHeader(signSession(key, Date.now() + SESSION_MS), { maxAgeS: SESSION_MS / 1000, secure: isHttps(req, trustProxy) });

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(400, { error: 'bad request' });
    }
    const { pathname } = url;
    const route = `${req.method} ${pathname}`;
    const ctx = { req, url, query: url.searchParams, body: undefined };
    // CSRF: JSON content type (not sendable cross-site without a preflight) and an Origin matching the Host.
    const bodyError = async () => {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return [415, 'json content type required'];
      const reqHost = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
      if (!sameOrigin(req.headers.origin, reqHost)) return [403, 'origin not allowed'];
      const raw = await readBody(req);
      if (raw == null) return [413, 'body too large'];
      try {
        ctx.body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        return [400, 'invalid json'];
      }
      return null;
    };
    const failBody = ([status, error]) => json(status, { error }, status === 413 ? { connection: 'close' } : {});

    try {
      if (route === 'GET /healthz') {
        const ok = !collector || Date.now() - (collector.status.lastTick ?? startedAt) < 20 * 60e3;
        return json(ok ? 200 : 503, { ok });
      }
      if (req.method === 'GET') {
        if (pathname === '/login') return sendFile(resolveStatic(PUBLIC, '/login.html'));
        if (pathname === '/icons.svg') {
          res.writeHead(200, { 'content-type': MIME['.svg'], 'cache-control': 'no-cache' });
          return res.end(sprite);
        }
        if (pathname.startsWith('/fonts/')) return sendFile(FONTS[pathname], 'max-age=86400');
        if (PUBLIC_PATHS.has(pathname)) return sendFile(resolveStatic(PUBLIC, pathname));
      }

      if (route === 'POST /api/login') {
        const err = await bodyError();
        if (err) return failBody(err);
        // check, compare and count in one synchronous step, so parallel guesses are all counted
        const ip = clientIp(req, trustProxy);
        const retryAfter = limiter.retryAfter(ip);
        if (retryAfter > 0) return json(429, { error: 'too many attempts', retryAfter }, { 'retry-after': String(retryAfter) });
        if (!passwordMatches(ctx.body?.password, config.password)) {
          limiter.fail(ip);
          await sleep(failDelayMs);
          return json(401, { error: 'wrong password' });
        }
        limiter.reset(ip);
        return json(204, null, { 'set-cookie': newCookie() });
      }

      const expiry = verifySession(key, readCookie(req.headers.cookie), Date.now());
      if (expiry == null) {
        if (req.method === 'GET' && !pathname.startsWith('/api/') && (pathname === '/' || pathname.endsWith('.html'))) {
          res.writeHead(302, { location: `/login?next=${encodeURIComponent(pathname + url.search)}` });
          return res.end();
        }
        return json(401, LOGIN_REQUIRED);
      }
      if (expiry - Date.now() < RENEW_MS) res.setHeader('set-cookie', newCookie());

      if (req.method === 'POST' || req.method === 'PUT') {
        const err = await bodyError();
        if (err) return failBody(err);
      }
      const handler = routes[route];
      if (handler) {
        const [status, body, headers] = await handler(ctx);
        return json(status, body, headers);
      }
      if (routePaths.has(pathname)) return json(405, { error: 'method not allowed' });
      if (pathname.startsWith('/api/')) return json(404, { error: 'not found' });
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (pathname === '/vendor/apexcharts.js') return sendFile(APEXCHARTS);
      return sendFile(resolveStatic(PUBLIC, pathname === '/' ? '/index.html' : pathname));
    } catch (err) {
      log(`http error: ${err.message}`);
      if (res.headersSent) return res.end();
      json(500, { error: 'internal error' });
    }
  });
  server.listen(port, host, () => log(`http://${host}:${port}`));
  return server;
}
