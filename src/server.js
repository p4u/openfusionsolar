// Read-only JSON API over the store, plus the static frontend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayMoney } from './tariff.js';
import { buildEvents } from './events.js';
import { dayBounds } from './collector.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/': ['../public/index.html', 'text/html'],
  '/app.js': ['../public/app.js', 'text/javascript'],
  '/i18n.js': ['../public/i18n.js', 'text/javascript'],
  '/style.css': ['../public/style.css', 'text/css'],
  '/vendor/apexcharts.js': ['../node_modules/apexcharts/dist/apexcharts.min.js', 'text/javascript'],
};
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Configured values win; otherwise what FusionSolar reports for this plant. null when unknown.
export function batteryInfo(store, cfg) {
  const station = store.getKv('station') ?? {};
  const fs = store.getKv('batteryConfig') ?? {};
  const reserve = cfg.reservePct == null ? null : store.getKv('reserve');
  return {
    capacityKwh: cfg.capacityKwh ?? station.batteryKwh ?? null,
    minPct: cfg.minPct ?? fs.endOfDischargePct ?? null,
    reservePct: cfg.reservePct ?? null,
    reserveSince: reserve?.since ?? null,
    chargeFromGrid: fs.chargeFromGrid ?? null,
    gridChargeCutoffPct: fs.gridChargeCutoffPct ?? null,
  };
}

// config: { prices (see tariff.js) | null, battery: { capacityKwh, reservePct, minPct } }
export function startServer({ store, collector, config = {}, port = 8080, host = '127.0.0.1', log = console.log }) {
  const withMoney = (d) => {
    const [from, to] = dayBounds(d.day);
    // share of the day's 5-minute slots with data; below 1 the day's totals may be low
    const until = Math.min(to, Date.now()); // today: only the slots that have already happened
    const coverage = until <= from ? 1 : Math.min(1, store.countSamples(from, until) / ((until - from) / 300e3));
    return { ...d, coverage, money: dayMoney(d, config.prices) };
  };
  const server = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(400, { error: 'bad request' });
    }
    const range = () => {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      return Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= MAX_RANGE_MS ? [from, to] : null;
    };

    try {
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
      if (url.pathname === '/api/status') {
        return json(200, {
          station: store.getKv('station') ?? null,
          realtime: store.latestRealtime() ?? null,
          lastSampleTs: store.lastSampleTs(),
          collector: collector?.status ?? null,
          activeAlarms: store.activeAlarms?.() ?? [],
          battery: batteryInfo(store, config.battery ?? {}),
          pricesConfigured: Boolean(config.prices),
          plantName: config.plantName ?? null,
          prices: config.prices
            ? (({ p1, p2, p3, export: exp, adjust, iee, vat }) => ({ p1, p2, p3, export: exp, adjust, iee, vat }))(config.prices)
            : null,
        });
      }
      if (url.pathname === '/api/days') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (!DAY_RE.test(from ?? '') || !DAY_RE.test(to ?? '') || from > to) {
          return json(400, { error: 'from/to (YYYY-MM-DD, from <= to) required' });
        }
        return json(200, store.days(from, to).map(withMoney));
      }
      if (url.pathname === '/api/events') {
        const r = range();
        if (!r) return json(400, { error: 'from/to (unix ms, from < to, max 400 days) required' });
        return json(200, buildEvents(store.alarms(...r), store.samples(...r)));
      }
      if (url.pathname === '/api/samples' || url.pathname === '/api/alarms') {
        const r = range();
        if (!r) return json(400, { error: 'from/to (unix ms, from < to, max 400 days) required' });
        return json(200, url.pathname === '/api/samples' ? store.samples(...r) : store.alarms(...r));
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      const file = STATIC[url.pathname];
      if (!file) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': file[1] });
      fs.createReadStream(path.join(ROOT, file[0])).on('error', () => res.end()).pipe(res);
    } catch (err) {
      log(`http error: ${err.message}`);
      json(500, { error: 'internal error' });
    }
  });
  server.listen(port, host, () => log(`http://${host}:${port}`));
  return server;
}
