// Writes an invented demo database (no real household data): node scripts/demo-db.js <path>
// Used for screenshots and manual UI testing. Never reads .env; prints the env lines to run it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/db.js';
import { localDay, dayBounds, shiftDay } from '../src/collector.js';

const DAYS = 400;
const SAMPLE_DAYS = 45;
const XSS = '<img src=x onerror=alert(1)>';

function rng(seed) { // mulberry32: the same data every run
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (v) => Math.round(v * 100) / 100;

function dailyRow(day, rand) {
  const doy = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${day.slice(0, 4)}-01-01T00:00:00Z`)) / 864e5;
  const season = (1 - Math.cos(((doy - 15) / 365) * 2 * Math.PI)) / 2; // 0 in January, 1 in July
  const pv = (4 + 20 * season) * (0.45 + 0.55 * rand());
  const load = 11 + 3 * (1 - season) + 2 * rand();
  const self = Math.min(pv, load * 0.55);
  const charge = Math.min(pv - self, 7);
  const exp = Math.max(pv - self - charge, 0);
  const discharge = Math.min(charge * 0.92 + 0.5, load - self);
  const imp = Math.max(load - self - discharge, 0);
  return {
    pv_kwh: r2(pv), load_kwh: r2(load), import_kwh: r2(imp), export_kwh: r2(exp), self_use_kwh: r2(self),
    charge_kwh: r2(charge), discharge_kwh: r2(discharge),
    import_p1: r2(imp * 0.22), import_p2: r2(imp * 0.23), import_p3: r2(imp * 0.55),
    load_p1: r2(load * 0.3), load_p2: r2(load * 0.25), load_p3: r2(load * 0.45),
  };
}

// grid_kw > 0 imports, battery_kw > 0 charges (the collector's signs).
function daySamples(store, day, rand) {
  const [start] = dayBounds(day);
  const k = 0.4 + 0.6 * rand();
  let soc = 40;
  for (let i = 0; i < 288; i++) {
    const h = i / 12;
    const pv = h > 7 && h < 19 ? 6 * k * Math.sin(((h - 7) / 12) * Math.PI) ** 2 : 0;
    const load = 0.35 + 0.25 * rand() + (h > 19 && h < 22 ? 1.1 : 0) + (h > 13 && h < 15 ? 0.6 : 0);
    const net = pv - load;
    const battery = net > 0 ? (soc < 100 ? Math.min(net, 2.5) : 0) : (soc > 12 ? -Math.min(-net, 2.5) : 0);
    soc = Math.min(100, Math.max(10, soc + battery * (5 / 60) * 10));
    store.saveSample(start + i * 300e3, {
      pv_kw: r2(pv), inverter_kw: r2(pv), load_kw: r2(load), self_use_kw: r2(Math.min(pv, load)),
      grid_kw: r2(load - pv + battery), battery_kw: r2(battery), soc: Math.round(soc),
    });
  }
}

function shiftMonth(first, n) { // first: the 1st of a month
  const [y, m] = first.split('-').map(Number);
  return localDay(new Date(y, m - 1 + n, 1).getTime());
}

function invoiceFor(from, to, n, rand) {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  const kwh = [3.1, 3.2, 7.5].map((d) => r2(days * d * (0.9 + 0.2 * rand())));
  const price = [0.19, 0.13, 0.08];
  const en = kwh.map((k, i) => r2(k * price[i]));
  const power = r2(4.6 * 0.08 * days);
  const surplus = r2(days * 6 * 0.07);
  const meter = r2(days * 0.027);
  const iee = r2((power + en[0] + en[1] + en[2] - surplus) * 0.0511);
  const base = r2(power + en[0] + en[1] + en[2] - surplus + iee + meter);
  const vat = r2(base * 0.21);
  return {
    status: 'confirmed', supplier: 'Demo Energia', invoice_number: `DEMO-${String(n).padStart(4, '0')}`,
    issue_date: shiftDay(to, 3), period_from: from, period_to: to, days, due_date: shiftDay(to, 18),
    tariff: '2.0TD', self_consumption: 1, contracted_p1_kw: 4.6, contracted_p2_kw: 4.6,
    power_price_p1: 28.47, power_price_p2: 0.73, power_eur: power,
    kwh_p1: kwh[0], kwh_p2: kwh[1], kwh_p3: kwh[2], price_p1: price[0], price_p2: price[1], price_p3: price[2],
    energy_p1_eur: en[0], energy_p2_eur: en[1], energy_p3_eur: en[2], energy_eur: r2(en[0] + en[1] + en[2]),
    surplus_price: 0.07, surplus_eur: surplus, elec_tax_pct: 5.11, elec_tax_eur: iee, meter_rent_eur: meter,
    tax_base_eur: base, vat_pct: 21, vat_eur: vat, total_eur: r2(base + vat), notes: 'Invented demo invoice',
  };
}

const figure = (kind, title, label, notes) => ({
  type: 'figure', kind, title, x: { type: 'month', values: ['2026-01', '2026-02', '2026-03', '2026-04'] },
  series: [{ label, values: [10, null, 40.5, 80.5] }], unit: '€', source: ['estimate'], notes,
  query: { metrics: ['savings_eur', 'estimated_eur'], from: '2026-01-01', to: '2026-04-30', bucket: '1mo' },
});

export function buildDemo(store, now = Date.now()) {
  const rand = rng(20261120);
  const today = localDay(now);
  store.setKv('station', { name: 'Casa Demo', capacity: 5, batteryKwh: 10, timeZone: 'Europe/Madrid' });
  store.tx(() => {
    for (let i = DAYS - 1; i >= 0; i--) {
      const day = shiftDay(today, -i);
      store.saveDaily(day, dailyRow(day, rand));
      if (i > 0) store.markDay(day, 288, dayBounds(day)[1] + 3600e3);
    }
    for (let i = SAMPLE_DAYS - 1; i >= 0; i--) daySamples(store, shiftDay(today, -i), rand);
    const first = `${today.slice(0, 8)}01`; // twelve monthly bills ending with the last full month
    for (let m = 12, n = 1; m >= 1; m--, n++) {
      store.insertInvoice(invoiceFor(shiftMonth(first, -m), shiftDay(shiftMonth(first, -m + 1), -1), n, rand));
    }
    const ts = now - 3600e3;
    const conv = store.createConversation('Estalvi de la casa demo', ts);
    store.addChatMessage(conv, 'user', [{ type: 'text', text: 'Quant he estalviat aquest any?' }], ts);
    store.addChatMessage(conv, 'assistant', [
      { type: 'text', text: 'Aquestes són dades de demostració inventades.' },
      figure('bar', 'Estalvi acumulat 2026', 'Estalvi acumulat', null),
      { type: 'text', text: 'Vols veure un altre període?' },
      { type: 'choice', options: ['Aquest mes', 'Aquest any'] },
    ], ts + 1000);
    const xss = store.createConversation('Prova de seguretat', ts - 1000);
    store.addChatMessage(xss, 'user', [{ type: 'text', text: 'Mostra-ho' }], ts - 1000);
    store.addChatMessage(xss, 'assistant', [
      figure('bar', XSS, XSS, XSS), figure('donut', XSS, XSS, XSS),
      { type: 'sources', items: [{ title: XSS, url: 'https://example.com/demo', host: 'example.com' }] },
    ], ts - 500);
  });
}

export function createDemoDb(file, now = Date.now()) {
  const abs = path.resolve(file);
  const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  if (abs === dataDir || abs.startsWith(dataDir + path.sep)) throw new Error('refusing to write under data/');
  if (fs.existsSync(abs)) throw new Error(`${abs} already exists`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const store = new Store(abs);
  buildDemo(store, now);
  store.db.close();
  return abs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('usage: node scripts/demo-db.js <path>'); process.exit(2); }
  process.env.TZ = 'Europe/Madrid';
  try {
    const abs = createDemoDb(process.argv[2].replace(/^~(?=\/)/, os.homedir()));
    console.log(`demo database written: ${abs}\nRun with:\nDB_PATH=${abs}\nCOLLECT=0\nPLANT_TZ=Europe/Madrid\n`
      + 'PRICE_P1=0.19\nPRICE_P2=0.13\nPRICE_P3=0.08\nPRICE_EXPORT=0.07\nPRICE_POWER_P1=28.47\nPRICE_POWER_P2=0.73\n'
      + 'POWER_P1_KW=4.6\nPOWER_P2_KW=4.6\nTAX_ELECTRICITY_PCT=5.11\nTAX_VAT_PCT=21');
  } catch (e) { console.error(e.message); process.exit(1); }
}
