// Spanish market prices: REE apidatos, peninsula, hourly EUR/kWh. A past day REE returned whole is kept in
// market_prices and never fetched again; today and later are fetched each time and never stored.
// Days are Europe/Madrid days (REE's and the plant's), computed with Intl so they hold whatever TZ the process runs in.
import { fetchCapped } from './http.js';

const BASE = 'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real';
const SERIES = { PVPC: 'pvpc', 'Precio mercado spot': 'spot' }; // REE series title → kind
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MAX_DAYS = 31;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MADRID = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
const madridDay = (ts) => MADRID.format(ts); // 'YYYY-MM-DD'
const utc = (day) => Date.parse(`${day}T00:00:00Z`);
const nextDay = (day) => new Date(utc(day) + DAY).toISOString().slice(0, 10);

// REE answer → [{ ts, kind, eur_kwh }], one row per hour and kind. The spot series comes in 15-minute values even with
// time_trunc=hour, so values are averaged per hour; EUR/MWh ÷ 1000; negative prices are kept.
export function parseRee(json) {
  const acc = new Map(); // `${kind} ${ts}` → [sum, n]
  for (const s of json.included) {
    const kind = SERIES[s?.attributes?.title];
    if (!kind) continue;
    for (const { value, datetime } of s.attributes.values) {
      const t = Date.parse(datetime);
      if (!Number.isFinite(value) || !Number.isFinite(t)) throw new Error('ree: bad value');
      const key = `${kind} ${Math.floor(t / HOUR) * HOUR}`;
      const a = acc.get(key) ?? [0, 0];
      acc.set(key, [a[0] + value, a[1] + 1]);
    }
  }
  return [...acc].map(([key, [sum, n]]) => {
    const [kind, ts] = key.split(' ');
    return { ts: Number(ts), kind, eur_kwh: Number((sum / n / 1000).toFixed(6)) };
  });
}

// A day REE returned whole: 23, 24 or 25 hours of each kind.
const complete = (rows) => Object.values(SERIES).every((k) => [23, 24, 25].includes(rows.filter((r) => r.kind === k).length));

const byDay = (rows) => Map.groupBy(rows, (r) => madridDay(r.ts));

export function createMarket({ store, fetch = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  // fromDay, toDay: 'YYYY-MM-DD', both included → { pvpc: Map<ts, eurKwh>, spot: Map<ts, eurKwh> } | { unavailable: 'ree' }
  async function hourly(fromDay, toDay, { signal } = {}) {
    if (!DAY_RE.test(fromDay) || !DAY_RE.test(toDay) || fromDay > toDay) throw new TypeError('hourly: bad day range');
    const today = madridDay(now());
    const days = [];
    for (let d = fromDay; d <= toDay; d = nextDay(d)) days.push(d);

    // a Madrid day starts 1 or 2 hours before its UTC midnight
    const stored = byDay(store.marketPrices(utc(fromDay) - 2 * HOUR, utc(nextDay(toDay))));
    const rows = [];
    const missing = [];
    for (const d of days) {
      if (stored.has(d) && complete(stored.get(d))) rows.push(...stored.get(d));
      else missing.push(d);
    }

    // consecutive missing days of one calendar month per request: REE answers 400 to an hourly range longer than a
    // month (1 Feb - 3 Mar fails, 15 Jan - 14 Feb works), so a request never crosses a month boundary
    const chunks = [];
    for (const d of missing) {
      const last = chunks.at(-1);
      if (last && nextDay(last.at(-1)) === d && last.length < MAX_DAYS && last[0].slice(0, 7) === d.slice(0, 7)) last.push(d);
      else chunks.push([d]);
    }
    const fail = (code) => {
      log(`market ree error ${code}`); // never the body
      return { unavailable: 'ree' };
    };
    for (const c of chunks) {
      const url = `${BASE}?start_date=${c[0]}T00:00&end_date=${c.at(-1)}T23:59&time_trunc=hour`;
      let res;
      let got;
      try {
        res = await fetchCapped(url, { headers: { accept: 'application/json' }, timeoutMs: 15000, signal, fetch });
      } catch (e) {
        return fail(e.code);
      }
      if (res.status !== 200) return fail(res.status);
      if (res.text == null) return fail('too_large');
      try {
        got = byDay(parseRee(JSON.parse(res.text)));
      } catch {
        return fail('bad_response');
      }
      for (const d of c) {
        const dayRows = got.get(d) ?? [];
        if (d < today && complete(dayRows)) store.saveMarketDay(dayRows);
        rows.push(...dayRows);
      }
    }

    const out = { pvpc: new Map(), spot: new Map() };
    for (const r of rows.sort((a, b) => a.ts - b.ts)) out[r.kind].set(r.ts, r.eur_kwh);
    return out;
  }

  return { hourly };
}
