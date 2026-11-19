// Entry point: collector loop + web server in one process.
import fs from 'node:fs';
import { FusionSolarClient } from './fusionsolar.js';
import { Store } from './db.js';
import { Collector } from './collector.js';
import { startServer } from './server.js';
import { pricesFromEnv } from './tariff.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
const SESSION = env.SESSION_PATH ?? '.session.json';
const log = (m) => console.log(new Date().toISOString(), m);

// Fail closed: the web UI is never served without a password.
if (!env.APP_PASSWORD) {
  console.error('APP_PASSWORD is required: set it in .env');
  process.exit(1);
}
if (env.APP_PASSWORD.length < 8) log('warning: APP_PASSWORD is shorter than 8 characters');

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION, 'utf8'));
  } catch {
    return undefined; // missing or corrupt: log in again
  }
}

function writeSession(data) {
  fs.writeFileSync(`${SESSION}.tmp`, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(`${SESSION}.tmp`, SESSION);
}

fs.mkdirSync('data', { recursive: true });
const store = new Store(env.DB_PATH ?? 'data/openfusionsolar.db');
// Everything runs in the plant's time zone: PLANT_TZ, else the one FusionSolar reported last time
// (the collector sets it again after discovery), else the host's.
env.TZ = env.PLANT_TZ || store.getKv('station')?.timeZone || env.TZ || 'UTC';
const optNum = (v) => (v == null || v === '' ? null : Number(v));
const client = new FusionSolarClient({
  user: env.FUSIONSOLAR_USER,
  password: env.FUSIONSOLAR_PASSWORD,
  session: readSession(),
  log,
});
const collector = new Collector({
  client,
  store,
  log,
  onSession: () => writeSession(client.exportSession()),
});

// Battery values left empty are taken from FusionSolar (station and battery settings).
// The power-cut reserve ("Backup power SOC") is not exposed by the API, so it is only shown when configured.
const reservePct = optNum(env.BATTERY_RESERVE_PCT);
const reserve = store.getKv('reserve');
if (reservePct != null && reserve?.pct !== reservePct) {
  store.setKv('reserve', { pct: reservePct, since: env.BATTERY_RESERVE_SINCE || new Date().toISOString().slice(0, 10) });
}
const config = {
  prices: pricesFromEnv(env),
  battery: { capacityKwh: optNum(env.BATTERY_KWH), minPct: optNum(env.BATTERY_MIN_PCT), reservePct },
  plantName: env.PLANT_NAME || null,
  password: env.APP_PASSWORD,
  trustProxy: env.TRUST_PROXY === '1',
};
startServer({ store, collector, config, port: Number(env.PORT ?? 8080), host: env.HOST ?? '127.0.0.1', log });
if (env.COLLECT !== '0') collector.run({ backfillDays: Number(env.BACKFILL_DAYS ?? 30) });
