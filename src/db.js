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
-- Bills (files on disk under <dirname(DB_PATH)>/bills, metadata here), their extractions, the assistant's chats and AI spend.
create table if not exists bill_files (
  id integer primary key, sha text not null unique, kind text not null,  -- pdf|jpeg|png|webp|heic
  bytes integer not null, name text, group_id text not null,             -- name: display only; group = one bill
  pos integer not null default 0, uploaded_at integer not null, source text not null default 'upload' -- upload|chat
);
create index if not exists bill_files_group on bill_files(group_id, pos);
create table if not exists bill_extractions (
  id integer primary key, group_id text not null, status text not null,  -- queued|processing|done|not_a_bill|failed
  attempt integer not null default 0, model text, schema_v integer not null default 1,
  created_at integer not null, finished_at integer, result_json text,    -- the model's validated JSON, verbatim
  checks_json text, error text, invoice_id integer
);
create index if not exists bill_extractions_group on bill_extractions(group_id, id);
create index if not exists bill_extractions_status on bill_extractions(status);
create table if not exists invoices (
  id integer primary key, group_id text, status text not null,           -- draft|confirmed
  auto_confirmed integer not null default 0, duplicate_of integer, superseded_by integer,
  supplier text, supplier_tax_id text, invoice_number text,
  kind text not null default 'normal', rectifies_number text,            -- normal|rectifying|credit
  issue_date text, period_from text, period_to text, days integer, due_date text,
  cups text, contract_number text, tariff text, self_consumption integer,
  contracted_p1_kw real, contracted_p2_kw real, max_demand_p1_kw real, max_demand_p2_kw real,
  power_price_p1 real, power_price_p2 real, power_eur real,              -- EUR per kW and year
  kwh_p1 real, kwh_p2 real, kwh_p3 real, price_p1 real, price_p2 real, price_p3 real,
  energy_p1_eur real, energy_p2_eur real, energy_p3_eur real, adjust_eur real, energy_eur real, -- energy_eur includes adjust
  surplus_p1_kwh real, surplus_p2_kwh real, surplus_p3_kwh real, surplus_price real,
  surplus_eur real, surplus_lost_eur real,                               -- compensated; generated but not compensated
  social_bonus_eur real, meter_rent_eur real, elec_tax_pct real, elec_tax_eur real,
  other_taxed_eur real, other_exempt_eur real, tax_base_eur real, vat_pct real, vat_eur real, total_eur real,
  vat_rates text,                                                        -- JSON [{pct, base, amount}] when several VAT lines
  edits text, notes text, created_at integer not null, updated_at integer not null
);
create index if not exists invoices_period on invoices(period_from, period_to);
create index if not exists invoices_number on invoices(invoice_number);
create table if not exists invoice_lines (
  id integer primary key, invoice_id integer not null, pos integer not null,
  section text not null,   -- power|energy|adjust|surplus|social|elec_tax|meter|vat|discount|other
  concept text not null, period text, quantity real, unit text, unit_price real, amount_eur real,
  vat_pct real, info integer not null default 0  -- 1: breakdown already inside another line (tolls, charges)
);
create index if not exists invoice_lines_invoice on invoice_lines(invoice_id, pos);
create table if not exists invoice_readings (
  invoice_id integer not null, kind text not null, period text not null, -- import|export, p1|p2|p3
  from_date text, to_date text, start_kwh real, end_kwh real, estimated integer,
  primary key (invoice_id, kind, period)
) without rowid;
create table if not exists chat_conversations (
  id integer primary key, title text, created_at integer not null, updated_at integer not null
);
create table if not exists chat_messages (
  id integer primary key, conversation_id integer not null, ts integer not null,
  role text not null, blocks text not null  -- JSON: [{type:'text'|'chart'|'invoice'|'tool_call'|'tool_result', ...}]
);
create index if not exists chat_messages_conv on chat_messages(conversation_id, id);
create table if not exists ai_usage (
  id integer primary key, ts integer not null, job text not null,        -- extract|chat
  model text not null, tokens_in integer, tokens_out integer, cost_usd real, ref text
);
create index if not exists ai_usage_ts on ai_usage(ts);
-- Spanish market prices from REE (src/market.js): past complete days only.
create table if not exists market_prices (ts integer not null, kind text not null, eur_kwh real not null,
  primary key (ts, kind)) without rowid;  -- ts: the hour's start, epoch ms; kind: pvpc | spot
`;

const DAILY_COLS = ['pv_kwh', 'load_kwh', 'import_kwh', 'export_kwh', 'self_use_kwh', 'charge_kwh', 'discharge_kwh',
  'import_p1', 'import_p2', 'import_p3', 'load_p1', 'load_p2', 'load_p3'];
const SAMPLE_COLS = ['pv_kw', 'inverter_kw', 'yield_kwh', 'load_kw', 'self_use_kw', 'grid_kw', 'battery_kw', 'soc'];

// Writable columns of the bill tables (id, invoice_id and timestamps are set by the store).
export const INVOICE_COLS = Object.freeze(['group_id', 'status', 'auto_confirmed', 'duplicate_of', 'superseded_by',
  'supplier', 'supplier_tax_id', 'invoice_number', 'kind', 'rectifies_number',
  'issue_date', 'period_from', 'period_to', 'days', 'due_date',
  'cups', 'contract_number', 'tariff', 'self_consumption',
  'contracted_p1_kw', 'contracted_p2_kw', 'max_demand_p1_kw', 'max_demand_p2_kw',
  'power_price_p1', 'power_price_p2', 'power_eur',
  'kwh_p1', 'kwh_p2', 'kwh_p3', 'price_p1', 'price_p2', 'price_p3',
  'energy_p1_eur', 'energy_p2_eur', 'energy_p3_eur', 'adjust_eur', 'energy_eur',
  'surplus_p1_kwh', 'surplus_p2_kwh', 'surplus_p3_kwh', 'surplus_price',
  'surplus_eur', 'surplus_lost_eur',
  'social_bonus_eur', 'meter_rent_eur', 'elec_tax_pct', 'elec_tax_eur',
  'other_taxed_eur', 'other_exempt_eur', 'tax_base_eur', 'vat_pct', 'vat_eur', 'total_eur', 'vat_rates',
  'edits', 'notes']);
export const LINE_COLS = Object.freeze(['pos', 'section', 'concept', 'period', 'quantity', 'unit', 'unit_price', 'amount_eur',
  'vat_pct', 'info']);
export const READING_COLS = Object.freeze(['kind', 'period', 'from_date', 'to_date', 'start_kwh', 'end_kwh', 'estimated']);
const EXTRACTION_PATCH = ['status', 'attempt', 'model', 'finished_at', 'result_json', 'checks_json', 'error', 'invoice_id'];

// node:sqlite binds neither booleans nor undefined.
const bind = (v) => (typeof v === 'boolean' ? Number(v) : (v ?? null));
// Column names are interpolated into SQL, so they must come from a fixed list.
function knownCols(row, allowed, what) {
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  for (const c of cols) if (!allowed.includes(c)) throw new Error(`${what}: unknown column ${c}`);
  return cols;
}

const logRow = (r) => ({ ...r, recipients: r.recipients ? JSON.parse(r.recipients) : null });
const chatRow = (r) => ({ ...r, blocks: JSON.parse(r.blocks) });

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // added columns (older databases get them here): who an alert email went to, in which language, and grp, shared by
    // the rows (one per address) of one alert event
    const logCols = new Set(this.db.prepare('pragma table_info(alert_log)').all().map((c) => c.name));
    for (const c of ['recipients', 'lang', 'grp']) if (!logCols.has(c)) this.db.exec(`alter table alert_log add column ${c} text`);
    const invCols = new Set(this.db.prepare('pragma table_info(invoices)').all().map((c) => c.name));
    if (!invCols.has('vat_rates')) this.db.exec('alter table invoices add column vat_rates text');
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
      measuredDays: q('select day from daily where import_kwh is not null order by day'),
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
      logAlert: q(`insert into alert_log (ts, rule, event, title, body, delivery, reason, error, recipients, lang, grp)
                   values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateAlertLog: q('update alert_log set delivery = ?, error = ? where id = ?'),
      alertLog: q('select * from alert_log where id < ? order by id desc limit ?'),
      failedAlerts: q("select * from alert_log where delivery = 'failed' and ts >= ? order by id"),
      addBillFile: q(`insert into bill_files (sha, kind, bytes, name, group_id, pos, uploaded_at, source)
                      values (?, ?, ?, ?, ?, ?, ?, ?)`),
      billFile: q('select * from bill_files where id = ?'),
      billFileBySha: q('select * from bill_files where sha = ?'),
      billFiles: q('select * from bill_files where group_id = ? order by pos, id'),
      countBillFiles: q('select count(*) as n from bill_files'),
      billGroupFiles: q('select sha, kind from bill_files where group_id = ? order by pos, id'),
      deleteBillGroup: q('delete from bill_files where group_id = ?'),
      allBillGroups: q(`select group_id from bill_files union select group_id from bill_extractions
                        union select group_id from invoices where group_id is not null`),
      addExtraction: q('insert into bill_extractions (group_id, status, created_at) values (?, ?, ?)'),
      extraction: q('select * from bill_extractions where id = ?'),
      latestExtraction: q('select * from bill_extractions where group_id = ? order by id desc limit 1'),
      extractionsByStatus: q('select * from bill_extractions where status in (select value from json_each(?)) order by id'),
      recentExtractions: q('select * from bill_extractions where finished_at is null or finished_at >= ? order by id'),
      requeueProcessing: q("update bill_extractions set status = 'queued' where status = 'processing'"),
      deleteExtractions: q('delete from bill_extractions where group_id = ?'),
      invoice: q('select * from invoices where id = ?'),
      invoiceLines: q('select * from invoice_lines where invoice_id = ? order by pos, id'),
      invoiceReadings: q('select * from invoice_readings where invoice_id = ? order by kind, period'),
      addLine: q(`insert into invoice_lines (invoice_id, ${LINE_COLS}) values (?, ${LINE_COLS.map(() => '?')})`),
      addReading: q(`insert into invoice_readings (invoice_id, ${READING_COLS}) values (?, ${READING_COLS.map(() => '?')})`),
      deleteLines: q('delete from invoice_lines where invoice_id = ?'),
      deleteReadings: q('delete from invoice_readings where invoice_id = ?'),
      deleteInvoice: q('delete from invoices where id = ?'),
      listInvoices: q(`select * from invoices where (:status is null or status = :status)
                       and (:from is null or period_to >= :from) and (:to is null or period_from <= :to)
                       order by period_from, id`),
      invoicesByNumber: q('select * from invoices where invoice_number = ? order by id'),
      // strict: consecutive bills that share their boundary day (to = next from) are not duplicates
      invoicesOverlapping: q('select * from invoices where cups = ? and period_from < ? and period_to > ? order by period_from, id'),
      createConversation: q('insert into chat_conversations (title, created_at, updated_at) values (?, ?, ?)'),
      touchConversation: q('update chat_conversations set updated_at = ? where id = ?'),
      addChatMessage: q('insert into chat_messages (conversation_id, role, blocks, ts) values (?, ?, ?, ?)'),
      conversations: q('select * from chat_conversations order by updated_at desc, id desc limit ?'),
      chatMessages: q(`select * from (select * from chat_messages where conversation_id = ? order by id desc limit ?)
                       order by id`),
      deleteChatMessages: q('delete from chat_messages where conversation_id = ?'),
      deleteConversation: q('delete from chat_conversations where id = ?'),
      deleteAllChatMessages: q('delete from chat_messages'),
      deleteAllConversations: q('delete from chat_conversations'),
      pruneChatMessages: q(`delete from chat_messages where conversation_id not in
                            (select id from chat_conversations order by updated_at desc, id desc limit ?)`),
      pruneConversations: q(`delete from chat_conversations where id not in
                             (select id from chat_conversations order by updated_at desc, id desc limit ?)`),
      addUsage: q('insert into ai_usage (ts, job, model, tokens_in, tokens_out, cost_usd, ref) values (?, ?, ?, ?, ?, ?, ?)'),
      usageCostSince: q('select coalesce(sum(cost_usd), 0) as v from ai_usage where ts >= ?'),
      countUsage: q('select count(*) as n from ai_usage where job in (select value from json_each(?)) and ts >= ?'),
      marketPrices: q('select ts, kind, eur_kwh from market_prices where ts >= ? and ts < ? order by ts, kind'),
      saveMarketPrice: q('insert or replace into market_prices (ts, kind, eur_kwh) values (?, ?, ?)'),
    };
  }

  tx(fn) {
    if (this.db.isTransaction) return fn(); // nested: the outer tx commits or rolls back
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

  // Days with measured grid import, oldest first (missing months, advice).
  measuredDays() {
    return this.st.measuredDays.all().map((r) => r.day);
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
      r.recipients ? JSON.stringify(r.recipients) : null, r.lang ?? null, r.grp ?? null);
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

  // --- bill files (bytes live on disk, named by sha) ---

  addBillFile({ sha, kind, bytes, name = null, group_id, pos = 0, uploaded_at, source = 'upload' }) {
    return Number(this.st.addBillFile.run(sha, kind, bytes, name, group_id, pos, uploaded_at, source).lastInsertRowid);
  }

  billFile(id) {
    return this.st.billFile.get(id);
  }

  billFileBySha(sha) {
    return this.st.billFileBySha.get(sha);
  }

  billFiles(groupId) {
    return this.st.billFiles.all(groupId);
  }

  countBillFiles() {
    return this.st.countBillFiles.get().n;
  }

  // Deletes the group's bill_files rows only and returns them, so the caller removes the bytes.
  deleteBillGroup(groupId) {
    return this.tx(() => {
      const files = this.st.billGroupFiles.all(groupId).map(({ sha, kind }) => ({ sha, kind }));
      this.st.deleteBillGroup.run(groupId);
      return files;
    });
  }

  allBillGroups() {
    return this.st.allBillGroups.all().map((r) => r.group_id);
  }

  // --- extractions ---

  addExtraction({ group_id, status, created_at }) {
    return Number(this.st.addExtraction.run(group_id, status, created_at).lastInsertRowid);
  }

  updateExtraction(id, patch) {
    const cols = knownCols(patch, EXTRACTION_PATCH, 'extraction');
    if (!cols.length) return;
    this.db.prepare(`update bill_extractions set ${cols.map((c) => `${c} = ?`)} where id = ?`)
      .run(...cols.map((c) => bind(patch[c])), id);
  }

  extraction(id) {
    return this.st.extraction.get(id);
  }

  latestExtraction(groupId) {
    return this.st.latestExtraction.get(groupId);
  }

  extractionsByStatus(statuses) {
    return this.st.extractionsByStatus.all(JSON.stringify(statuses));
  }

  // Not finished yet, or finished at or after sinceTs.
  recentExtractions(sinceTs) {
    return this.st.recentExtractions.all(sinceTs);
  }

  // After a restart nothing is processing any more: those jobs run again.
  requeueProcessing() {
    return Number(this.st.requeueProcessing.run().changes);
  }

  deleteExtractions(groupId) {
    this.st.deleteExtractions.run(groupId);
  }

  // --- invoices, their lines and meter readings ---

  #putChildren(id, lines, readings) {
    if (lines) {
      this.st.deleteLines.run(id);
      lines.forEach((l, i) => {
        knownCols(l, LINE_COLS, 'invoice line');
        const v = { ...l, pos: l.pos ?? i, info: l.info ? 1 : 0 };
        this.st.addLine.run(id, ...LINE_COLS.map((c) => bind(v[c])));
      });
    }
    if (readings) {
      this.st.deleteReadings.run(id);
      for (const r of readings) {
        knownCols(r, READING_COLS, 'invoice reading');
        this.st.addReading.run(id, ...READING_COLS.map((c) => bind(r[c])));
      }
    }
  }

  insertInvoice(row, lines = [], readings = []) {
    // null columns are left out so the table defaults (kind, auto_confirmed) apply
    const cols = knownCols(row, INVOICE_COLS, 'invoice').filter((c) => row[c] !== null);
    const now = Date.now();
    return this.tx(() => {
      const id = Number(this.db.prepare(`insert into invoices (${[...cols, 'created_at', 'updated_at']})
        values (${[...cols, 0, 0].map(() => '?')})`).run(...cols.map((c) => bind(row[c])), now, now).lastInsertRowid);
      this.#putChildren(id, lines, readings);
      return id;
    });
  }

  // patch: any subset of INVOICE_COLS. Lines and readings are replaced when given.
  updateInvoice(id, patch = {}, lines, readings) {
    const cols = knownCols(patch, INVOICE_COLS, 'invoice');
    this.tx(() => {
      this.db.prepare(`update invoices set ${[...cols, 'updated_at'].map((c) => `${c} = ?`)} where id = ?`)
        .run(...cols.map((c) => bind(patch[c])), Date.now(), id);
      this.#putChildren(id, lines, readings);
    });
  }

  invoice(id) {
    return this.st.invoice.get(id);
  }

  invoiceLines(id) {
    return this.st.invoiceLines.all(id);
  }

  invoiceReadings(id) {
    return this.st.invoiceReadings.all(id);
  }

  // from/to (YYYY-MM-DD, inclusive) keep the invoices whose period overlaps them.
  listInvoices({ status = null, from = null, to = null } = {}) {
    return this.st.listInvoices.all({ status, from, to });
  }

  invoicesByNumber(number) {
    return this.st.invoicesByNumber.all(number);
  }

  invoicesOverlapping(cups, from, to) {
    return this.st.invoicesOverlapping.all(cups, to, from);
  }

  deleteInvoice(id) {
    this.tx(() => {
      this.st.deleteLines.run(id);
      this.st.deleteReadings.run(id);
      this.st.deleteInvoice.run(id);
    });
  }

  // --- assistant conversations ---

  createConversation(title, ts) {
    return Number(this.st.createConversation.run(title ?? null, ts, ts).lastInsertRowid);
  }

  touchConversation(id, ts) {
    this.st.touchConversation.run(ts, id);
  }

  addChatMessage(convId, role, blocks, ts) {
    return Number(this.st.addChatMessage.run(convId, role, JSON.stringify(blocks), ts).lastInsertRowid);
  }

  conversations(limit = 50) {
    return this.st.conversations.all(limit);
  }

  // The newest `limit` messages, oldest first.
  chatMessages(convId, limit = 200) {
    return this.st.chatMessages.all(convId, limit).map(chatRow);
  }

  deleteConversation(id) {
    this.tx(() => {
      this.st.deleteChatMessages.run(id);
      this.st.deleteConversation.run(id);
    });
  }

  deleteAllConversations() {
    this.tx(() => {
      this.st.deleteAllChatMessages.run();
      this.st.deleteAllConversations.run();
    });
  }

  // Keeps the `keep` most recently updated conversations and their messages.
  pruneConversations(keep = 50) {
    this.tx(() => {
      this.st.pruneChatMessages.run(keep);
      this.st.pruneConversations.run(keep);
    });
  }

  // --- AI spend ---

  addUsage({ ts, job, model, tokens_in = null, tokens_out = null, cost_usd = null, ref = null }) {
    this.st.addUsage.run(ts, job, model, tokens_in, tokens_out, cost_usd, ref);
  }

  usageCostSince(ts) {
    return this.st.usageCostSince.get(ts).v;
  }

  // Rows of ai_usage with one of the given jobs, at or after `since`.
  countUsage(jobs, since) {
    return this.st.countUsage.get(JSON.stringify(jobs), since).n;
  }

  // --- market prices ---

  // [{ ts, kind, eur_kwh }] with ts in [from, to)
  marketPrices(from, to) {
    return this.st.marketPrices.all(from, to);
  }

  saveMarketDay(rows) {
    this.tx(() => {
      for (const r of rows) this.st.saveMarketPrice.run(r.ts, r.kind, r.eur_kwh);
    });
  }
}
