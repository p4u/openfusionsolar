// Turns Huawei's raw alarm log into a few understandable events: power cuts, internet losses,
// low battery and island-mode overloads. Same-kind alarms that overlap or are close are merged.
// From the readings themselves: panels stopped (noProduction) and periods without readings (noData).

const KINDS = [
  ['network', /network connection/i],
  ['overload', /off-grid output overload/i],
  ['batteryLow', /dischargeable capacity|battery.*low/i],
  ['gridCut', /grid (under|over)(voltage|frequency)|grid loss|no grid|on-grid\/off-grid|power collector|islanding|abnormal grid/i],
];
const MERGE_GAP_MS = { gridCut: 30 * 60e3 }; // a cut often raises several alarms minutes apart
const DEFAULT_GAP_MS = 10 * 60e3;
const MIN_NETWORK_MS = 5 * 60e3; // shorter losses do not cost a single 5-minute reading

export function classify(name = '') {
  for (const [kind, re] of KINDS) if (re.test(name)) return kind;
  return 'other';
}

// alarms: rows from the alarms table; samples: rows from samples covering the same range.
// range { from, to, since } (ms; since = first stored reading) adds the noData periods of that range.
export function buildEvents(alarms, samples, now = Date.now(), range = null) {
  const byKind = new Map();
  for (const a of [...alarms].sort((x, y) => x.occur_utc - y.occur_utc)) {
    const kind = classify(a.name);
    const start = a.occur_utc;
    const end = a.clear_utc ?? now;
    const list = byKind.get(kind) ?? byKind.set(kind, []).get(kind);
    const last = list.at(-1);
    if (last && start <= last.end + (MERGE_GAP_MS[kind] ?? DEFAULT_GAP_MS)) {
      last.end = Math.max(last.end, end);
      last.ongoing ||= a.clear_utc == null;
      last.names.add(a.name);
    } else {
      list.push({ kind, start, end, ongoing: a.clear_utc == null, names: new Set([a.name]) });
    }
  }
  const events = [...byKind.values(), noProduction(samples), range ? noData(samples, { ...range, now }) : []]
    .flat()
    .filter((e) => e.kind !== 'network' || e.ongoing || e.end - e.start >= MIN_NETWORK_MS)
    .map((e) => ({ ...e, names: [...e.names] }));
  // an internet loss whose 5-minute readings were filled in afterwards lost nothing
  for (const e of events.filter((x) => x.kind === 'network' && !x.ongoing)) e.recovered = recovered(samples, e.start, e.end);
  const overloads = events.filter((e) => e.kind === 'overload');
  for (const e of events.filter((x) => x.kind === 'gridCut')) {
    e.batteryCovered = batteryCovered(samples, e.start, e.end);
    // an island-mode overload during the cut means the home went dark even if the battery started covering it
    if (overloads.some((o) => o.start < e.end && o.end > e.start)) e.batteryCovered = 'overload';
  }
  return events.sort((a, b) => b.start - a.start);
}

// Panels at exactly 0 kW for an hour or more during sun hours: the inverter was not producing
// (clouds and rain still give some power). 10:00-15:00 local keeps it valid in winter too.
const SUN_FROM_H = 10;
const SUN_TO_H = 15;
const MIN_STOP_MS = 60 * 60e3;

export function noProduction(samples) {
  const out = [];
  let run = null;
  const close = () => {
    if (run && run.end - run.start >= MIN_STOP_MS) out.push({ kind: 'noProduction', start: run.start, end: run.end, ongoing: false, names: [] });
    run = null;
  };
  for (const r of [...samples].sort((a, b) => a.ts - b.ts)) {
    const h = new Date(r.ts).getHours();
    if (h >= SUN_FROM_H && h < SUN_TO_H && r.pv_kw === 0) {
      if (run && r.ts - run.end <= 10 * 60e3) run.end = r.ts + 5 * 60e3;
      else {
        close();
        run = { start: r.ts, end: r.ts + 5 * 60e3 };
      }
    } else if (r.pv_kw != null || h >= SUN_TO_H) close();
  }
  close();
  return out;
}

// Periods of an hour or more without a home-consumption reading, within the elapsed part of the range and after the
// first stored reading. A gap still open at `now` is ongoing (the hour minimum also keeps out the last few minutes,
// which may simply not be synced yet).
const MIN_GAP_MS = 60 * 60e3;
const SLOT_MS = 5 * 60e3;

export function noData(samples, { from, to, since, now = Date.now() }) {
  const out = [];
  const end = Math.min(to, now);
  let cursor = Math.max(from, since ?? from);
  if (since == null || cursor >= end) return out;
  const gap = (a, b, ongoing) => {
    if (b - a >= MIN_GAP_MS) out.push({ kind: 'noData', start: a, end: b, ongoing, names: [] });
  };
  for (const r of samples) {
    if (r.load_kw == null) continue;
    if (r.ts >= end) break;
    gap(cursor, r.ts, false);
    cursor = Math.max(cursor, r.ts + SLOT_MS);
  }
  gap(cursor, end, end === now);
  return out;
}

// Share of the 5-minute slots of [start, end) that have a reading: 90 % or more counts as recovered.
function recovered(samples, start, end) {
  const slots = Math.max(1, Math.floor((end - start) / SLOT_MS));
  return samples.filter((r) => r.ts >= start && r.ts < end && r.load_kw != null).length >= 0.9 * slots;
}

// true: the battery was powering the home during the cut; false: it was not; null: no data then.
function batteryCovered(samples, start, end) {
  const during = samples.filter((r) => r.ts >= start - 5 * 60e3 && r.ts <= end && r.battery_kw != null);
  if (!during.length) return null;
  return during.some((r) => r.battery_kw < -0.05);
}
