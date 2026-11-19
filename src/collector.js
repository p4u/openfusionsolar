// Polls FusionSolar, stores every response in `raw`, and derives samples/history/realtime/alarms.
import { AuthError } from './fusionsolar.js';
import { period } from './tariff.js';

const FIVE_MIN = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const AUTH_BACKOFF_MS = 30 * 60 * 1000;
const PAUSE_MS = 1500; // between backfill requests, to stay gentle with the portal

// Huawei's "no data" markers: '--' in energy-balance, Double.MAX_VALUE in device history.
export function num(v) {
  if (v === null || v === undefined || v === '' || v === '--' || v === '-' || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e300 ? n : null;
}

// Power/energy to kW/kWh using the unit Huawei reports for the signal.
export function toK(value, unit) {
  if (value === null) return null;
  return unit === 'W' || unit === 'Wh' ? value / 1000 : value;
}

export function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Calendar arithmetic on local days, safe across DST (unlike subtracting 24 h).
export function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n).getTime());
}

export function dayBounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

// 'YYYY-MM-DD HH:MM' in plant-local time (same zone as this machine) to unix ms.
function slotTs(s) {
  const [date, time] = s.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which history signals feed which sample column, per device type (mocTypeName).
const SAMPLE_SIGNALS = {
  Inverter: { 30017: 'pv_kw', 30014: 'inverter_kw', 30016: 'yield_kwh' },
  Battery: { 30005: 'battery_kw', 30007: 'soc' },
  'Power Sensor': { 30003: 'grid_kw' },
};

export class Collector {
  constructor({ client, store, log = console.log, onSession = () => {} }) {
    this.client = client;
    this.store = store;
    this.log = log;
    this.onSession = onSession;
    this.queue = Promise.resolve();
    this.authBlockedUntil = 0;
    this.status = { lastTick: null, lastError: null, backfill: null };
  }

  // All portal calls go through one queue so backfill and polling never overlap (one session, one CSRF).
  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async #call(endpoint, params, fn) {
    if (Date.now() < this.authBlockedUntil) throw new Error('login paused after an auth failure');
    try {
      const json = await fn();
      this.store.saveRaw(endpoint, params, json);
      if (json?.success === false) throw new Error(`${endpoint} failed: failCode=${json.failCode ?? '?'}`);
      return json;
    } catch (err) {
      if (err instanceof AuthError) {
        this.authBlockedUntil = Date.now() + AUTH_BACKOFF_MS;
        this.log(`auth failure, pausing logins for 30 min: ${err.message}`);
      }
      throw err;
    } finally {
      this.onSession();
    }
  }

  async discover() {
    const c = this.client;
    const stations = await this.#call('station-list', {}, () => c.stationList());
    const station = stations.data.list[0];
    const devList = await this.#call('device-list', { parentDn: station.dn }, () => c.deviceList(station.dn));
    const devices = devList.data.map((d) => ({ dn: d.dn, type: d.mocTypeName, name: d.name, signals: [] }));
    for (const dev of devices) {
      const sig = await this.#call('device-statistics-signal', { deviceDn: dev.dn }, () => c.deviceSignals(dev.dn));
      for (const s of sig.data?.signalList ?? []) {
        const unit = s.unit?.unit ?? null;
        this.store.saveSignalMeta(dev.dn, s.id, s.name, unit);
        dev.signals.push({ id: s.id, name: s.name, unit });
      }
    }
    this.station = {
      dn: station.dn,
      name: station.name,
      capacity: num(station.installedCapacity ?? station.capacity),
      batteryKwh: num(station.batteryCapacity),
      timeZone: station.timeZone || null,
      latitude: num(station.latitude),
      longitude: num(station.longitude),
    };
    this.devices = devices;
    this.store.setKv('station', this.station);
    this.store.setKv('devices', devices);
    // Day bounds and Huawei's local timestamps are in the plant's zone; PLANT_TZ overrides.
    if (!process.env.PLANT_TZ && this.station.timeZone) process.env.TZ = this.station.timeZone;
    await this.syncBatteryConfig();
    this.log(`station ${station.dn} "${station.name}", devices: ${devices.map((d) => `${d.type}(${d.signals.length})`).join(', ')}`);
  }

  // Battery limits as configured in FusionSolar (signal ids from the device settings page).
  async syncBatteryConfig() {
    const battery = this.devices.find((d) => d.type === 'Battery');
    if (!battery) return;
    const j = await this.#call('device-config', { dn: battery.dn }, () => this.client.deviceConfig(battery.dn));
    const v = Object.fromEntries(
      (j.data ?? []).flatMap((g) => g.configSignalDisplayList ?? []).map((s) => [String(s.id), num(s.value)]),
    );
    this.store.setKv('batteryConfig', {
      endOfChargePct: v['230320277'] ?? null,
      endOfDischargePct: v['230320278'] ?? null,
      chargeFromGrid: v['230320279'] == null ? null : v['230320279'] === 1,
      gridChargeCutoffPct: v['230320280'] ?? null,
      maxChargeKw: toK(v['10011'] ?? null, 'W'),
      maxDischargeKw: toK(v['10012'] ?? null, 'W'),
      at: Date.now(),
    });
  }

  async realtime() {
    const c = this.client;
    const st = this.station.dn;
    await this.#call('energy-flow', { stationDn: st }, () => c.energyFlow(st));
    const signals = {};
    for (const dev of this.devices) {
      const j = await this.#call('device-realtime', { deviceDn: dev.dn }, () => c.deviceRealtime(dev.dn));
      signals[dev.type] = Object.fromEntries(
        (j.data ?? []).flatMap((g) => g.signals ?? []).map((s) => [String(s.id), toK(num(s.realValue ?? s.value), s.unit)]),
      );
    }
    const dongle = signals.Dongle ?? {};
    const meter = signals['Power Sensor'] ?? {};
    const row = {
      ts: Date.now(),
      pv_kw: dongle['10032'] ?? null,
      load_kw: dongle['10033'] ?? null,
      grid_kw: meter['10004'] == null ? null : -meter['10004'], // meter reports export as positive
      battery_kw: signals.Battery?.['10004'] ?? null,
      soc: signals.Battery?.['10006'] ?? null,
      inverter_kw: signals.Inverter?.['10018'] ?? null,
    };
    if (Object.entries(row).some(([k, v]) => k !== 'ts' && v !== null)) this.store.saveRealtime(row);
    return row;
  }

  // Fetches one local day of 5-minute data: plant energy balance plus every history signal of every device.
  async syncDay(day) {
    const c = this.client;
    const st = this.station.dn;
    const [start, end] = dayBounds(day);
    const date = new Date(start + 12 * HOUR);
    const rows = new Map(); // ts -> sample columns
    const put = (ts, col, v) => {
      if (v === null || ts < start || ts >= end) return;
      if (!rows.has(ts)) rows.set(ts, {});
      rows.get(ts)[col] = v;
    };

    const bal = await this.#call('energy-balance', { stationDn: st, timeDim: 2, day }, () =>
      c.energyBalance(st, { timeDim: 2, date }),
    );
    const b = bal.data;
    if (!Array.isArray(b?.xAxis)) throw new Error('energy-balance: no xAxis');
    (b.xAxis ?? []).forEach((x, i) => {
      const ts = slotTs(x);
      put(ts, 'load_kw', num(b.usePower?.[i]));
      put(ts, 'self_use_kw', num(b.selfUsePower?.[i]));
    });

    const history = [];
    for (const dev of this.devices) {
      if (!dev.signals.length) continue;
      const ids = dev.signals.map((s) => s.id);
      const h = await this.#call('device-history-data', { deviceDn: dev.dn, signalIds: ids, day }, () =>
        c.deviceHistory(dev.dn, ids, date),
      );
      if (!h.data || typeof h.data !== 'object') throw new Error(`device-history-data ${dev.dn}: no data object`);
      const map = SAMPLE_SIGNALS[dev.type] ?? {};
      for (const [id, series] of Object.entries(h.data)) {
        const unit = dev.signals.find((s) => String(s.id) === id)?.unit;
        for (const p of series.pmDataList ?? []) {
          const ts = p.startTime * 1000;
          const v = num(p.counterValue);
          if (v === null || ts < start || ts >= end) continue;
          history.push([dev.dn, Number(id), ts, v]);
          const col = map[id];
          if (col) put(ts, col, col === 'grid_kw' ? -toK(v, unit) : toK(v, unit)); // meter: export positive
        }
      }
    }

    this.store.tx(() => {
      for (const h of history) this.store.saveHistory(...h);
      for (const [ts, row] of rows) this.store.saveSample(ts, row);
      this.store.markDay(day, rows.size);
    });
    this.deriveDaily(day);
    return rows.size;
  }

  // Day totals from what is already stored (raw energy-balance + samples + battery history); no API calls,
  // so it can rebuild every stored day.
  deriveDaily(day) {
    const bal = this.store.latestRaw('energy-balance', { stationDn: this.station.dn, timeDim: 2, day })?.data;
    if (!bal) return;
    const [start, end] = dayBounds(day);
    const battery = this.devices.find((d) => d.type === 'Battery');
    const row = {
      pv_kwh: num(bal.totalProductPower),
      load_kwh: num(bal.totalUsePower),
      import_kwh: num(bal.totalBuyPower),
      export_kwh: num(bal.totalOnGridPower),
      self_use_kwh: num(bal.totalSelfUsePower),
      // 30001/30002 are the battery's daily charge/discharge counters (kWh)
      charge_kwh: battery ? this.store.historyMax(battery.dn, 30001, start, end) : null,
      discharge_kwh: battery ? this.store.historyMax(battery.dn, 30002, start, end) : null,
    };
    const split = { import: { p1: 0, p2: 0, p3: 0 }, load: { p1: 0, p2: 0, p3: 0 } };
    for (const s of this.store.samples(start, end)) {
      const p = period(s.ts);
      if (s.grid_kw != null) split.import[p] += Math.max(s.grid_kw, 0) / 12;
      if (s.load_kw != null) split.load[p] += s.load_kw / 12;
    }
    // Instantaneous 5-minute samples misestimate energy; keep their period shares, scaled to Huawei's totals.
    for (const kind of ['import', 'load']) {
      const total = row[`${kind}_kwh`];
      const sum = split[kind].p1 + split[kind].p2 + split[kind].p3;
      for (const p of ['p1', 'p2', 'p3']) row[`${kind}_${p}`] = total == null || sum <= 0 ? (total === 0 ? 0 : null) : (split[kind][p] / sum) * total;
    }
    this.store.saveDaily(day, row);
  }

  rebuildDaily() {
    const days = this.store.syncedWithoutDaily();
    for (const day of days) this.deriveDaily(day);
    if (days.length) this.log(`daily totals rebuilt for ${days.length} days`);
  }

  async syncAlarms() {
    const st = this.station.dn;
    let n = 0;
    for (const dataType of ['CURRENT', 'HISTORY']) {
      for (let pageNo = 1; ; pageNo++) {
        const j = await this.#call('alarms', { stationDn: st, dataType, pageNo }, () =>
          this.client.alarms(st, { dataType, pageNo, pageSize: 100 }),
        );
        const hits = j.data?.hits ?? [];
        this.store.tx(() => hits.forEach((h) => this.store.saveAlarm(h)));
        n += hits.length;
        if (hits.length < 100 || pageNo * 100 >= (j.data?.totalCount ?? 0)) break;
        await sleep(PAUSE_MS);
      }
    }
    return n;
  }

  // Month/year/lifetime totals, kept raw for later use.
  async syncPeriods() {
    const st = this.station.dn;
    for (const timeDim of [4, 5, 6]) {
      await this.#call('energy-balance', { stationDn: st, timeDim, day: localDay(Date.now()) }, () =>
        this.client.energyBalance(st, { timeDim }),
      );
    }
  }

  // A day is final once it was synced 36 h after it ended (the dongle uploads buffered data late).
  #isFinal(day) {
    const s = this.store.daySync(day);
    return s && s.synced_at > dayBounds(day)[1] + 36 * HOUR;
  }

  // Walks back from yesterday; stops after `days` days or 30 consecutive days without data
  // (shorter gaps are real outages, e.g. the dongle offline for a few days). A failing day is retried
  // a few times and then skipped unmarked, so the next backfill run picks it up again.
  async backfill(days) {
    const anchor = localDay(Date.now());
    let empty = 0;
    try {
      for (let i = 1; i <= days && empty < 30; i++) {
        this.status.backfill = { done: i, total: days };
        const day = shiftDay(anchor, -i);
        if (this.#isFinal(day)) {
          empty = 0;
          continue;
        }
        let n = null;
        for (let attempt = 1; attempt <= 3 && n === null; attempt++) {
          try {
            n = await this.#serial(() => this.syncDay(day));
          } catch (err) {
            this.#fail(err);
            await sleep(Math.max(attempt * FIVE_MIN, this.authBlockedUntil - Date.now()));
          }
        }
        if (n === null) continue;
        empty = n ? 0 : empty + 1;
        this.log(`backfill ${day}: ${n} slots`);
        await sleep(PAUSE_MS);
      }
    } finally {
      this.status.backfill = null;
    }
    this.log('backfill done');
  }

  async tick() {
    const now = Date.now();
    await this.#serial(async () => {
      await this.realtime();
      const today = localDay(now);
      await this.syncDay(today);
      const hourly = !this.lastHourly || now - this.lastHourly >= HOUR;
      if (hourly) {
        this.lastHourly = now;
        for (const back of [1, 2]) {
          const day = shiftDay(today, -back);
          if (!this.#isFinal(day)) await this.syncDay(day);
        }
      }
      if (!this.lastDaily || now - this.lastDaily >= 6 * HOUR) {
        this.lastDaily = now;
        await this.syncAlarms();
        await this.syncPeriods();
        await this.syncBatteryConfig();
      }
    });
    this.status.lastTick = now;
  }

  async run({ backfillDays = 30 } = {}) {
    for (;;) {
      try {
        await this.#serial(() => this.discover());
        this.rebuildDaily();
        break;
      } catch (err) {
        this.#fail(err);
        await sleep(FIVE_MIN);
      }
    }
    this.backfill(backfillDays).catch((err) => this.#fail(err));
    for (;;) {
      try {
        await this.tick();
        this.status.lastError = null;
      } catch (err) {
        this.#fail(err);
      }
      // Next run one minute after the next 5-minute boundary, when Huawei has usually published the slot.
      const next = Math.ceil((Date.now() + 1) / FIVE_MIN) * FIVE_MIN + 60 * 1000;
      await sleep(next - Date.now());
    }
  }

  #fail(err) {
    this.status.lastError = { at: Date.now(), message: err.message };
    this.log(`error: ${err.message}`);
  }
}
