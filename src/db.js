// SQLite storage. Every API response is kept verbatim (gzip) in `raw`; the other tables are
// derived from it and can be rebuilt. Timestamps are unix milliseconds (UTC).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const SCHEMA = `
pragma journal_mode = wal;
create table if not exists raw (
  id integer primary key,
  fetched_at integer not null,
  endpoint text not null,
  params text not null,
  sha text not null,
  body blob not null
);
create index if not exists raw_lookup on raw(endpoint, params, id);
create table if not exists kv (key text primary key, value text not null);
create table if not exists signal_meta (
  device_dn text not null, signal_id integer not null, name text, unit text,
  primary key (device_dn, signal_id)
);
create table if not exists signal_history (
  device_dn text not null, signal_id integer not null, ts integer not null, value real,
  primary key (device_dn, signal_id, ts)
) without rowid;
create table if not exists samples (
  ts integer primary key,
  pv_kw real,        -- inverter total input power (DC from panels)
  inverter_kw real,  -- inverter AC active power
  yield_kwh real,    -- inverter daily energy, cumulative within the day
  load_kw real,      -- house consumption (energy-balance usePower)
  self_use_kw real,  -- consumption covered by PV (energy-balance selfUsePower)
  grid_kw real,      -- meter: + import, - export
  battery_kw real,   -- + charging, - discharging
  soc real           -- battery state of charge, %
);
create table if not exists realtime (
  ts integer primary key,
  pv_kw real, load_kw real, grid_kw real, battery_kw real, soc real, inverter_kw real
);
create table if not exists alarms (
  csn integer primary key,
  device_dn text, device_type text, alarm_id text, name text, severity integer,
  occur_utc integer, clear_utc integer, json text not null
);
create table if not exists day_sync (day text primary key, synced_at integer not null, rows integer not null);
-- Daily totals (kWh). pv/load/import/export/self_use are Huawei's own day totals; *_p1..p3 split
-- import and load by 2.0TD period using the 5-minute samples, scaled to those totals.
create table if not exists daily (
  day text primary key,
  pv_kwh real, load_kwh real, import_kwh real, export_kwh real, self_use_kwh real,
  charge_kwh real, discharge_kwh real,
  import_p1 real, import_p2 real, import_p3 real,
  load_p1 real, load_p2 real, load_p3 real
);
-- Alert engine (src/alerts.js): per-rule state and every alert it raised, sent or not.
create table if not exists alert_state (key text primary key, value text not null);
create table if not exists alert_log (
  id integer primary key, ts integer not null, rule text not null, event text not null,
  title text, body text, delivery text not null, reason text, error text
);
create index if not exists alert_log_ts on alert_log(ts);
`;

const DAILY_COLS = ['pv_kwh', 'load_kwh', 'import_kwh', 'export_kwh', 'self_use_kwh', 'charge_kwh', 'discharge_kwh',
  'import_p1', 'import_p2', 'import_p3', 'load_p1', 'load_p2', 'load_p3'];
const SAMPLE_COLS = ['pv_kw', 'inverter_kw', 'yield_kwh', 'load_kw', 'self_use_kw', 'grid_kw', 'battery_kw', 'soc'];

const logRow = (r) => ({ ...r, recipients: r.recipients ? JSON.parse(r.recipients) : null });

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // added columns (older databases get them here): who an alert email went to, and in which language
    const logCols = new Set(this.db.prepare('pragma table_info(alert_log)').all().map((c) => c.name));
    for (const c of ['recipients', 'lang']) if (!logCols.has(c)) this.db.exec(`alter table alert_log add column ${c} text`);
    const q = (sql) => this.db.prepare(sql);
    this.st = {
      lastSha: q('select sha from raw where endpoint = ? and params = ? order by id desc limit 1'),
      insertRaw: q('insert into raw (fetched_at, endpoint, params, sha, body) values (?, ?, ?, ?, ?)'),
      setKv: q('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'),
      getKv: q('select value from kv where key = ?'),
      meta: q(`insert into signal_meta (device_dn, signal_id, name, unit) values (?, ?, ?, ?)
               on conflict do update set name = excluded.name, unit = excluded.unit`),
      history: q(`insert into signal_history (device_dn, signal_id, ts, value) values (?, ?, ?, ?)
                  on conflict do update set value = coalesce(excluded.value, signal_history.value)`),
      sample: q(`insert into samples (ts, ${SAMPLE_COLS}) values (?, ${SAMPLE_COLS.map(() => '?')})
                 on conflict(ts) do update set ${SAMPLE_COLS.map((c) => `${c} = coalesce(excluded.${c}, samples.${c})`)}`),
      realtime: q('insert or replace into realtime (ts, pv_kw, load_kw, grid_kw, battery_kw, soc, inverter_kw) values (?, ?, ?, ?, ?, ?, ?)'),
      alarm: q(`insert or replace into alarms (csn, device_dn, device_type, alarm_id, name, severity, occur_utc, clear_utc, json)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      daySync: q('insert or replace into day_sync (day, synced_at, rows) values (?, ?, ?)'),
      getDaySync: q('select * from day_sync where day = ?'),
      latest: q('select * from realtime order by ts desc limit 1'),
      samples: q('select * from samples where ts >= ? and ts < ? order by ts'),
      lastSample: q('select max(ts) as ts from samples where load_kw is not null or grid_kw is not null'),
      countSamples: q('select count(*) as n from samples where ts >= ? and ts < ? and load_kw is not null'),
      alarms: q('select * from alarms where occur_utc < ? and (clear_utc is null or clear_utc >= ?) order by occur_utc desc'),
      activeAlarms: q('select * from alarms where clear_utc is null order by occur_utc desc'),
      latestRaw: q('select body from raw where endpoint = ? and params = ? order by id desc limit 1'),
      historyMax: q('select max(value) as v from signal_history where device_dn = ? and signal_id = ? and ts >= ? and ts < ?'),
      daily: q(`insert or replace into daily (day, ${DAILY_COLS}) values (?, ${DAILY_COLS.map(() => '?')})`),
      days: q('select * from daily where day >= ? and day <= ? order by day'),
      firstDay: q('select min(day) as v from daily'),
      firstSample: q('select min(ts) as v from samples'),
      daySyncs: q('select * from day_sync where day >= ? and day <= ?'),
      sigHistory: q(`select signal_id, ts, value from signal_history where device_dn = ? and signal_id = ? and ts >= ? and ts < ?
                     order by ts`),
      sigFirst: q('select ts from signal_history where device_dn = ? and signal_id = ? order by ts limit 1'),
      sigLast: q('select ts from signal_history where device_dn = ? and signal_id = ? order by ts desc limit 1'),
      syncedWithoutDaily: q('select day from day_sync where day not in (select day from daily) order by day desc'),
      alertState: q('select key, value from alert_state'),
      clearAlertState: q('delete from alert_state'),
      putAlertState: q('insert into alert_state (key, value) values (?, ?)'),
      logAlert: q(`insert into alert_log (ts, rule, event, title, body, delivery, reason, error, recipients, lang)
                   values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateAlertLog: q('update alert_log set delivery = ?, error = ? where id = ?'),
      alertLog: q('select * from alert_log where id < ? order by id desc limit ?'),
      failedAlerts: q("select * from alert_log where delivery = 'failed' and ts >= ? order by id"),
    };
  }

  tx(fn) {
    this.db.exec('begin');
    try {
      const out = fn();
      this.db.exec('commit');
      return out;
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  // Keeps a response unless it is identical to the previous one for the same call.
  saveRaw(endpoint, params, json) {
    const p = JSON.stringify(params ?? {});
    const text = JSON.stringify(json);
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    if (this.st.lastSha.get(endpoint, p)?.sha === sha) return false;
    this.st.insertRaw.run(Date.now(), endpoint, p, sha, zlib.gzipSync(text));
    return true;
  }

  setKv(key, value) {
    this.st.setKv.run(key, JSON.stringify(value));
  }

  getKv(key) {
    const row = this.st.getKv.get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  saveSignalMeta(deviceDn, id, name, unit) {
    this.st.meta.run(deviceDn, id, name ?? null, unit ?? null);
  }

  saveHistory(deviceDn, signalId, ts, value) {
    this.st.history.run(deviceDn, signalId, ts, value);
  }

  saveSample(ts, row) {
    this.st.sample.run(ts, ...SAMPLE_COLS.map((c) => row[c] ?? null));
  }

  saveRealtime(r) {
    this.st.realtime.run(r.ts, r.pv_kw, r.load_kw, r.grid_kw, r.battery_kw, r.soc, r.inverter_kw);
  }

  saveAlarm(hit) {
    this.st.alarm.run(
      hit.csn,
      hit.nativeMoDn ?? null,
      hit.devTypeStr ?? null,
      String(hit.alarmId ?? ''),
      hit.alarmName ?? null,
      hit.severity ?? null,
      hit.occurUtc ?? null,
      hit.cleared ? (hit.clearUtc ?? null) : null,
      JSON.stringify(hit),
    );
  }

  latestRaw(endpoint, params) {
    const row = this.st.latestRaw.get(endpoint, JSON.stringify(params ?? {}));
    return row ? JSON.parse(zlib.gunzipSync(row.body)) : undefined;
  }

  historyMax(deviceDn, signalId, from, to) {
    return this.st.historyMax.get(deviceDn, signalId, from, to)?.v ?? null;
  }

  saveDaily(day, row) {
    this.st.daily.run(day, ...DAILY_COLS.map((c) => row[c] ?? null));
  }

  days(fromDay, toDay) {
    return this.st.days.all(fromDay, toDay);
  }

  syncedWithoutDaily() {
    return this.st.syncedWithoutDaily.all().map((r) => r.day);
  }

  activeAlarms() {
    return this.st.activeAlarms.all();
  }

  markDay(day, rows, at = Date.now()) {
    this.st.daySync.run(day, at, rows);
  }

  firstDay() {
    return this.st.firstDay.get().v;
  }

  firstSampleTs() {
    return this.st.firstSample.get().v;
  }

  daySyncs(fromDay, toDay) {
    return this.st.daySyncs.all(fromDay, toDay);
  }

  signalHistory(dn, ids, from, to) {
    return ids.flatMap((id) => this.st.sigHistory.all(dn, id, from, to));
  }

  signalSpan(dn, id) {
    return { firstTs: this.st.sigFirst.get(dn, id)?.ts ?? null, lastTs: this.st.sigLast.get(dn, id)?.ts ?? null };
  }

  daySync(day) {
    return this.st.getDaySync.get(day);
  }

  latestRealtime() {
    return this.st.latest.get();
  }

  samples(from, to) {
    return this.st.samples.all(from, to);
  }

  lastSampleTs() {
    return this.st.lastSample.get()?.ts ?? null;
  }

  countSamples(from, to) {
    return this.st.countSamples.get(from, to).n;
  }

  alarms(from, to) {
    return this.st.alarms.all(to, from);
  }

  getAlertState() {
    return new Map(this.st.alertState.all().map((r) => [r.key, JSON.parse(r.value)]));
  }

  saveAlertState(map) {
    this.tx(() => {
      this.st.clearAlertState.run();
      for (const [k, v] of map) this.st.putAlertState.run(k, JSON.stringify(v));
    });
  }

  logAlert(r) {
    const res = this.st.logAlert.run(r.ts, r.rule, r.event, r.title ?? null, r.body ?? null, r.delivery, r.reason ?? null, r.error ?? null,
      r.recipients ? JSON.stringify(r.recipients) : null, r.lang ?? null);
    return Number(res.lastInsertRowid);
  }

  updateAlertLog(id, { delivery, error = null }) {
    this.st.updateAlertLog.run(delivery, error, id);
  }

  alertLog({ limit = 50, before } = {}) {
    return this.st.alertLog.all(before ?? Number.MAX_SAFE_INTEGER, limit).map(logRow);
  }

  failedAlerts(since) {
    return this.st.failedAlerts.all(since).map(logRow);
  }
}
