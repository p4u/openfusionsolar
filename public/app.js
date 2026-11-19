// Dashboard for a non-technical owner: what is happening now, how did the day / month go, what did it cost,
// and did anything go wrong. Data comes from our /api (FusionSolar data stored locally).
const $ = (id) => document.getElementById(id);
const COLORS = { pv: '#d97706', load: '#0f766e', imp: '#dc2626', exp: '#7c3aed', charge: '#db2777', discharge: '#0891b2', soc: '#475569', grid: '#2563eb' };
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const STALE_MS = 20 * 60e3;
const EVENTS_SHOWN = 8;

// ---------- formatting ----------
const nf = (digits) => new Intl.NumberFormat(t('_locale'), { minimumFractionDigits: digits, maximumFractionDigits: digits });
const kw = (v) => (v == null ? '–' : `${nf(2).format(v)} kW`);
const kwh = (v, digits = 1) => (v == null ? '–' : `${nf(digits).format(v)} kWh`);
const eur = (v) => (v == null ? '–' : new Intl.NumberFormat(t('_locale'), { style: 'currency', currency: 'EUR' }).format(v));
const pct = (v) => (v == null ? '–' : `${Math.round(v)} %`);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(t('_locale'), { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (ts) => new Date(ts).toLocaleString(t('_locale'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => new Date(d).toLocaleDateString(t('_locale'), { day: 'numeric', month: 'short' });
const duration = (ms) =>
  ms >= 2 * DAY ? t('days', { n: nf(1).format(ms / DAY) }) : ms >= HOUR ? t('hours', { n: nf(1).format(ms / HOUR) }) : t('minutes', { n: Math.max(1, Math.round(ms / 60e3)) });
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoMonth = (d) => isoDay(d).slice(0, 7);
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sum = (rows, f) => (rows.some((r) => f(r) != null) ? rows.reduce((a, r) => a + (f(r) ?? 0), 0) : null);
const col = (k) => (r) => r[k];

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

let status = { battery: {}, pricesConfigured: false };
let recentEvents = [];

// Missing readings stay null (shown as '–'), never as a measured zero.
function derive(r) {
  const grid = r?.grid_kw ?? null;
  const bat = r?.battery_kw ?? null;
  return {
    pv: r?.pv_kw ?? null,
    load: r?.load_kw ?? null,
    imp: grid == null ? null : Math.max(grid, 0),
    exp: grid == null ? null : Math.max(-grid, 0),
    charge: bat == null ? null : Math.max(bat, 0),
    discharge: bat == null ? null : Math.max(-bat, 0),
  };
}

// ---------- now: flow diagram ----------
const NODES = {
  pv: { x: 200, y: 62, label: () => t('nodePv'), color: COLORS.pv },
  grid: { x: 62, y: 200, label: () => t('nodeGrid'), color: COLORS.grid },
  home: { x: 338, y: 200, label: () => t('nodeHome'), color: COLORS.load },
  bat: { x: 200, y: 338, label: () => t('nodeBattery'), color: COLORS.charge },
};

function renderFlow(raw, soc) {
  const d = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v ?? 0])); // drawing only
  const surplus = Math.max(d.pv - d.load, 0);
  const pvBat = Math.min(surplus, d.charge);
  const gridBat = Math.max(d.charge - pvBat, 0);
  const links = [
    ['pv', 'home', Math.min(d.pv, d.load)], ['pv', 'bat', pvBat], ['pv', 'grid', Math.min(Math.max(surplus - pvBat, 0), d.exp)],
    ['grid', 'home', Math.max(d.load - Math.min(d.pv, d.load) - d.discharge, 0)], ['grid', 'bat', gridBat], ['bat', 'home', d.discharge],
  ];
  const path = (a, b) => {
    const [p, q] = [NODES[a], NODES[b]];
    return p.x === q.x || p.y === q.y ? `M${p.x},${p.y} L${q.x},${q.y}` : `M${p.x},${p.y} Q200,200 ${q.x},${q.y}`;
  };
  const lines = links
    .map(([a, b, v]) => (v > 0.01
      ? `<path class="flow" d="${path(a, b)}" stroke="${NODES[a].color}"><title>${NODES[a].label()} → ${NODES[b].label()}: ${kw(v)}</title></path>`
      : `<path class="idle" d="${path(a, b)}"/>`))
    .join('');
  const gridVerb = d.exp > 0.01 ? t('selling') : d.imp > 0.01 ? t('buying') : '';
  const batVerb = d.discharge > 0.01 ? t('discharging') : d.charge > 0.01 ? t('charging') : t('idle');
  const text = {
    pv: [kw(raw.pv)],
    home: [kw(raw.load)],
    grid: [kw(d.exp > 0.01 ? raw.exp : raw.imp), gridVerb],
    bat: [pct(soc), kw(d.discharge > 0.01 ? raw.discharge : raw.charge), batVerb],
  };
  const nodes = Object.entries(NODES)
    .map(([k, n]) => {
      const rows = text[k].filter(Boolean);
      const y0 = n.y - (rows.length - 1) * 8 + 5;
      return `<circle cx="${n.x}" cy="${n.y}" r="54" fill="#fff" stroke="${n.color}" stroke-width="3"/>
        ${rows.map((r, i) => `<text x="${n.x}" y="${y0 + i * 17}" class="${i ? 'small' : ''}">${r}</text>`).join('')}
        <text class="label" x="${n.x}" y="${k === 'pv' ? n.y - 62 : n.y + 74}">${n.label()}</text>`;
    })
    .join('');
  $('flow').innerHTML = lines + nodes;

  const sources = [
    d.pv > 0.01 && t('srcSun', { v: kw(Math.min(d.pv, d.load)) }),
    d.discharge > 0.01 && t('srcBattery', { v: kw(raw.discharge) }),
    d.imp > 0.01 && t('srcGrid', { v: kw(raw.imp) }),
    d.exp > 0.01 && t('srcExport', { v: kw(raw.exp) }),
  ].filter(Boolean).join(' ');
  $('now-sentence').textContent = raw.load == null ? '' : t('nowSentence', { load: kw(raw.load), sources });
}

function renderBattery(raw, soc) {
  const b = status.battery;
  const hasReserve = b.reservePct != null;
  $('soc-value').textContent = pct(soc);
  $('soc-bar').querySelector('.fill').style.width = `${soc ?? 0}%`;
  $('soc-bar').querySelector('.reserve').hidden = !hasReserve;
  if (hasReserve) $('soc-bar').querySelector('.reserve').style.left = `${b.reservePct}%`;
  $('reserve-label').textContent = [
    hasReserve && `▲ ${t('reserveLabel', { v: b.reservePct })}${b.reserveSince ? ` · ${t('reserveSince', { date: fmtDate(parseDay(b.reserveSince)) })}` : ''}`,
    b.chargeFromGrid && b.gridChargeCutoffPct != null && t('gridChargeUpTo', { v: b.gridChargeCutoffPct }),
  ].filter(Boolean).join(' · ');
  let state = t('batIdle');
  if ((raw.charge ?? 0) > 0.05) state = (raw.imp ?? 0) > 0.05 && (raw.pv ?? 0) < raw.charge ? t('batChargingGrid', { v: kw(raw.charge) }) : t('batChargingSun', { v: kw(raw.charge) });
  else if ((raw.discharge ?? 0) > 0.05) state = t('batDischarging', { v: kw(raw.discharge) });
  if (soc != null && hasReserve && soc < b.reservePct) state += ` ${t('batBelowReserve', { reserve: b.reservePct })}`;
  $('bat-state').textContent = soc == null ? '' : state;
  // Autonomy needs the capacity; the floor (end-of-discharge SOC) defaults to 0 when FusionSolar does not report it.
  const usable = soc == null || b.capacityKwh == null ? null : (Math.max(soc - (b.minPct ?? 0), 0) / 100) * b.capacityKwh;
  $('bat-autonomy').textContent = usable == null ? '' : usable < 0.1
    ? t('batAutonomyNone')
    : `${t('batAutonomy', { hours: duration((usable / Math.max(raw.load ?? 0.3, 0.15)) * HOUR) })}${b.minPct ? ` ${t('batAutonomyFloor', { min: b.minPct })}` : ''}`;
}

// ---------- status banner ----------
// The first line always answers "do I need to do anything?"; details follow.
function renderStatus(s, raw, now) {
  const last = s.lastSampleTs;
  const soc = s.realtime?.soc;
  const b = status.battery;
  const heads = []; // [level, text]; 0 ok, 1 info, 2 warn, 3 alarm
  const details = [];
  const ongoing = recentEvents.filter((e) => e.ongoing && !['network', 'noProduction'].includes(e.kind));
  if (ongoing.some((e) => e.kind === 'gridCut')) heads.push([3, t('statusCutNow')]);
  else if (ongoing.length) heads.push([3, t('statusAlarm', { names: [...new Set(ongoing.map(eventTitle))].join(' · ') })]);
  if (!last) heads.push([2, t('statusNoData')]);
  else if (now - last > STALE_MS) heads.push([2, t('headStale', { time: fmtTime(last), ago: duration(now - last) })]);
  const stops = recentEvents.filter((e) => e.kind === 'noProduction');
  const stopped = stops.filter((e) => e.end > now - DAY).reduce((a, e) => a + e.end - e.start, 0);
  if (stopped) heads.push([2, t(stops.length > 1 ? 'headStoppedRepeat' : 'headStopped', { d: duration(stopped), n: stops.length })]);
  if (soc != null && b.reservePct != null && soc < b.reservePct) {
    const recharging = (raw.charge ?? 0) > 0.05;
    heads.push(recharging
      ? [1, t('headRecharging', { soc: Math.round(soc), reserve: b.reservePct })]
      : [2, t('headNotRecharging', { soc: Math.round(soc), reserve: b.reservePct })]);
  }
  const recent = recentEvents.filter((e) => e.end > now - DAY && !e.ongoing);
  if (recent.length) details.push(t('statusRecent', { list: summarize(recent) }));
  if (!heads.length) heads.push([0, t('headOk')]);
  heads.sort((a, b2) => b2[0] - a[0]);
  const level = heads[0][0];
  const el = $('status');
  el.className = `status ${['ok', 'info', 'warn', 'alarm'][level]}`;
  el.innerHTML = [...heads.map(([, text]) => text), ...details].map((text) => `<span>${esc(text)}</span>`).join('');
  $('freshness').textContent = last ? t('lastSample', { time: fmtTime(last) }) : '';
}

// ---------- tiles ----------
const tile = (icon, label, value, hint = '', extra = '') =>
  `<div class="tile ${extra}"><div class="tlabel">${icon} ${label}</div><div class="tvalue">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;

// rows: daily rows (one for a day, many for a month). The energy term of a bill never goes below zero.
function renderTiles(el, rows, { month = false, incomplete = false, stopped = false } = {}) {
  if (!rows.length) {
    el.innerHTML = `<p class="hint">${t('noData')}</p>`;
    return;
  }
  const load = sum(rows, col('load_kwh'));
  const imp = sum(rows, col('import_kwh'));
  const solarUsed = sum(rows, col('self_use_kwh'));
  const self = load && solarUsed != null ? Math.min(1, solarUsed / load) * 100 : null;
  const html = [
    tile('☀️', t('produced'), kwh(sum(rows, col('pv_kwh')))),
    tile('🏠', t('consumed'), kwh(load)),
    tile('🔌', t('bought'), kwh(imp)),
    tile('📤', t('sold'), kwh(sum(rows, col('export_kwh')))),
    tile('🔋', t('storedBattery'), kwh(sum(rows, col('charge_kwh'))), t('storedHint')),
    tile('🏡', t('takenBattery'), kwh(sum(rows, col('discharge_kwh'))), t('takenHint')),
    tile('💪', t('selfSufficiency'), pct(self), t('selfSufficiencyHint')),
  ];
  const money = rows.map((r) => r.money).filter(Boolean);
  if (!status.pricesConfigured) html.push(tile('💶', t('cost'), '–', t('noTariff')));
  else if (money.length) {
    const energy = sum(money, col('energy'));
    const savings = sum(money, col('savings'));
    if (month) {
      const capped = Math.max(energy, 0);
      html.push(tile('💶', t('cost'), eur(capped), t('costHint')));
      html.push(tile('🧾', t('bill'), eur(capped + sum(money, col('fixed'))), `${t('billHint')} ${t('billCompare')}`));
      html.push(tile('🌱', t('savings'), eur(sum(money, col('withoutSolar')) - capped), t('savingsHint'), 'good'));
    } else {
      html.push(energy < 0 ? tile('💶', t('earned'), eur(-energy), t('earnedHint')) : tile('💶', t('cost'), eur(energy), t('costHint')));
      const why = stopped ? t(savings < 0 ? 'savingsStoppedNeg' : 'savingsStopped') : incomplete ? t('savingsIncomplete') : savings < 0 ? t('savingsNegative') : t('savingsHint');
      html.push(tile('🌱', t('savings'), eur(savings), why, savings < 0 ? '' : 'good'));
    }
  }
  el.innerHTML = html.join('');
}

// ---------- events ----------
function eventTitle(e) {
  if (e.kind === 'gridCut') {
    const cover = { true: t('evCovered'), false: t('evNotCovered'), overload: t('evCoveredUntilOverload') }[e.batteryCovered] ?? t('evUnknown');
    return `${t('evGridCut')} — ${cover}`;
  }
  if (e.kind === 'network') return e.ongoing ? t('evNetworkLong') : t('evNetworkPast');
  if (e.kind === 'batteryLow') return t('evBatteryLowLong');
  if (e.kind === 'overload') return t('evOverloadLong');
  if (e.kind === 'noProduction') return t('evNoProduction');
  return t('evOther', { name: e.names.join(', ') });
}

function summarize(events) {
  const total = (k) => events.filter((e) => e.kind === k).reduce((a, e) => a + (e.end - e.start), 0);
  const count = (k) => events.filter((e) => e.kind === k).length;
  const line = (key, kind, withDuration) => {
    const n = count(kind);
    return n && t(n === 1 ? `${key}One` : key, { n, d: withDuration ? duration(total(kind)) : '' });
  };
  return [
    line('evCountCut', 'gridCut', true),
    line('evCountStopped', 'noProduction', true),
    line('evCountNetwork', 'network', true),
    line('evCountBattery', 'batteryLow'),
    line('evCountOverload', 'overload'),
    line('evCountOther', 'other'),
  ].filter(Boolean).join(' · ');
}

function eventItem(e) {
  if (e.kind === 'networkDay') {
    return `<li class="ev-network"><span class="when">${esc(fmtDate(e.start))}</span><span>${esc(t(e.n === 1 ? 'networkDayOne' : 'networkDay', { n: e.n, d: duration(e.total) }))}</span></li>`;
  }
  const when = `${fmtDateTime(e.start)} → ${e.ongoing ? t('eventOngoing') : fmtDateTime(e.end)}`;
  return `<li class="ev-${e.kind}"><span class="when">${esc(when)} · ${esc(duration(e.end - e.start))}</span><span>${esc(eventTitle(e))}</span></li>`;
}

// Internet losses are many and harmless: one line per day; everything else stays one line per event.
function groupNetwork(events) {
  const days = new Map();
  const out = [];
  for (const e of events) {
    if (e.kind !== 'network' || e.ongoing) {
      out.push(e);
      continue;
    }
    const day = isoDay(new Date(e.start));
    const g = days.get(day) ?? days.set(day, { kind: 'networkDay', start: e.start, end: e.end, total: 0, n: 0 }).get(day);
    g.start = Math.min(g.start, e.start);
    g.end = Math.max(g.end, e.end);
    g.total += Math.min(e.end, parseDay(day).getTime() + DAY) - e.start;
    g.n += 1;
  }
  return [...out, ...days.values()].sort((a, b) => b.start - a.start);
}

function renderEvents(all) {
  $('events-summary').textContent = all.length ? t('eventsSummary', { list: summarize(all) }) : t('eventsNone');
  const events = groupNetwork(all);
  // most recent first; the rest stays collapsed so the page does not become endless on a phone
  const important = events.filter((e) => e.kind !== 'networkDay');
  const minor = events.filter((e) => e.kind === 'networkDay');
  const shown = [...important.slice(0, EVENTS_SHOWN), ...minor.slice(0, Math.max(0, EVENTS_SHOWN - important.length))].sort((a, b) => b.start - a.start);
  const rest = events.filter((e) => !shown.includes(e));
  $('events').innerHTML = shown.map(eventItem).join('');
  $('events-more').hidden = !rest.length;
  $('events-more-label').textContent = $('events-more').open ? t('evLess') : t('evMore', { n: events.length });
  $('events-rest').innerHTML = rest.map(eventItem).join('');
}

// ---------- charts ----------
const fmtY = (f) => ({ formatter: (v) => (v == null ? '–' : f(v)) });
const baseChart = (height, extra = {}) => ({
  chart: { type: 'line', height, animations: { enabled: false }, toolbar: { show: false }, zoom: { enabled: false }, ...extra },
  xaxis: { type: 'datetime', labels: { datetimeUTC: false, format: 'HH:mm' } },
  tooltip: { shared: true, x: { format: 'dd/MM HH:mm' } },
  stroke: { width: 2, curve: 'straight' },
  legend: { position: 'bottom', horizontalAlign: 'center', fontSize: '13px', clusterGroupedSeries: false },
  dataLabels: { enabled: false },
  noData: { text: t('noData') },
  series: [],
  responsive: [{ breakpoint: 560, options: { chart: { height: Math.round(height * 0.8) }, legend: { position: 'bottom', horizontalAlign: 'left', fontSize: '12px', clusterGroupedSeries: false } } }],
});
const charts = {};

function initCharts() {
  charts.day = new ApexCharts($('chart-day'), {
    ...baseChart(340),
    colors: [COLORS.pv, COLORS.load, COLORS.charge, COLORS.discharge, COLORS.soc],
    fill: { type: ['gradient', 'solid', 'solid', 'solid', 'solid'], gradient: { opacityFrom: 0.45, opacityTo: 0.05 } },
    // charge solid, discharge dotted, battery % dashed: distinguishable without colour
    stroke: { width: [1.5, 2.5, 2, 2, 2], dashArray: [0, 0, 0, 2, 6], curve: 'straight' },
    tooltip: { shared: true, x: { format: 'HH:mm' }, y: [fmtY(kw), fmtY(kw), fmtY(kw), fmtY(kw), fmtY(pct)] },
    // one axis entry per series (the four power series share the first, hidden copies); this keeps a normal legend
    yaxis: [
      { seriesName: t('pv'), title: { text: 'kW' }, min: 0, labels: { formatter: (v) => nf(1).format(v) } },
      ...[1, 2, 3].map(() => ({ seriesName: t('pv'), show: false, min: 0 })),
      { seriesName: t('soc'), opposite: true, min: 0, max: 100, tickAmount: 5, title: { text: '%' }, labels: { formatter: (v) => Math.round(v) } },
    ],
  });
  charts.cum = new ApexCharts($('chart-cum'), {
    ...baseChart(220),
    colors: [COLORS.pv],
    fill: { type: 'gradient', gradient: { opacityFrom: 0.5, opacityTo: 0.1 } },
    tooltip: { x: { format: 'HH:mm' }, y: fmtY((v) => kwh(v, 2)) },
    yaxis: { min: 0, title: { text: 'kWh' }, labels: { formatter: (v) => nf(1).format(v) } },
  });
  charts.month = new ApexCharts($('chart-month'), {
    ...baseChart(320, { type: 'bar' }),
    colors: [COLORS.pv, COLORS.load, COLORS.imp, COLORS.exp],
    plotOptions: { bar: { columnWidth: '70%' } },
    xaxis: { type: 'category', title: { text: t('pickDay') }, labels: { rotate: 0, formatter: (v) => (window.innerWidth < 560 && Number(v) % 5 !== 1 ? '' : v) } },
    tooltip: { shared: true, intersect: false, y: fmtY((v) => kwh(v)) },
    yaxis: { title: { text: 'kWh' }, labels: { formatter: (v) => nf(0).format(v) } },
  });
  for (const c of Object.values(charts)) c.render();
}

const pts = (rows, f) => rows.map((r) => [r.ts, f(r)]);
const bat = (f) => (r) => (r.battery_kw == null ? null : f(r.battery_kw));

// Shaded bands: yellow where readings are really missing (the dongle often uploads late data after an
// internet loss, so the alarm log overstates gaps), red for power cuts.
function bands(samples, events, from, to) {
  const have = new Set(samples.filter((r) => r.load_kw != null).map((r) => r.ts));
  const out = [];
  let gap = null;
  for (let ts = from; ts < Math.min(to, Date.now() - 15 * 60e3); ts += 5 * 60e3) {
    if (!have.has(ts)) gap ? (gap.x2 = ts + 5 * 60e3) : (gap = { x: ts, x2: ts + 5 * 60e3 });
    else if (gap) out.push(gap), (gap = null);
  }
  if (gap) out.push(gap);
  const yellow = out.filter((g) => g.x2 - g.x >= 15 * 60e3).map((g) => ({ ...g, fillColor: '#fbbf24', opacity: 0.25 }));
  const red = events
    .filter((e) => e.kind === 'gridCut' && e.end > from && e.start < to)
    .map((e) => ({ x: Math.max(e.start, from), x2: Math.min(e.end, to), fillColor: '#f87171', opacity: 0.3 }));
  const grey = events
    .filter((e) => e.kind === 'noProduction' && e.end > from && e.start < to)
    .map((e) => ({ x: Math.max(e.start, from), x2: Math.min(e.end, to), fillColor: '#64748b', opacity: 0.2 }));
  return [...yellow, ...red, ...grey];
}

// ---------- loaders ----------
async function loadDay() {
  const start = parseDay($('day').value);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const day = isoDay(start);
  const [samples, days, events] = await Promise.all([
    get(`/api/samples?from=${start.getTime()}&to=${end.getTime()}`),
    get(`/api/days?from=${day}&to=${day}`),
    get(`/api/events?from=${start.getTime()}&to=${end.getTime()}`),
  ]);
  const cov = days[0]?.coverage;
  const missing = cov == null ? null : (1 - cov) * (Math.min(end.getTime(), Date.now()) - start.getTime());
  const incomplete = missing != null && missing > HOUR;
  const stopped = events.filter((e) => e.kind === 'noProduction').reduce((a, e) => a + Math.min(e.end, end) - Math.max(e.start, start), 0);
  renderTiles($('day-tiles'), days, { incomplete, stopped: stopped > 0 });
  const cuts = events.filter((e) => e.kind === 'gridCut');
  $('day-warning').textContent = [
    ...cuts.map((e) => `${t('dayCut', { time: fmtTime(e.start), d: duration(e.end - e.start) })} ${eventTitle(e).split(' — ')[1] ?? ''}.`),
    stopped > 0 && (days[0]?.pv_kwh === 0 ? t('dayStoppedAll') : t('dayStopped', { d: duration(stopped) })),
    incomplete && t('incompleteDay', { missing: duration(missing) }),
  ].filter(Boolean).join(' ');
  $('day-starting').textContent = day === isoDay(new Date()) && samples.length < 12 ? t('dayStarting') : '';

  const b = status.battery;
  const showReserve = b.reservePct != null && (!b.reserveSince || day >= b.reserveSince);
  charts.day.updateOptions({
    xaxis: { min: start.getTime(), max: end.getTime() },
    annotations: {
      xaxis: bands(samples, events, start.getTime(), end.getTime()),
      yaxis: showReserve ? [{ y: b.reservePct, yAxisIndex: 4, borderColor: COLORS.soc, strokeDashArray: 3, label: { text: t('reserveLabel', { v: b.reservePct }), style: { background: '#f1f5f9' } } }] : [],
    },
  });
  charts.day.updateSeries(samples.length ? [
    { name: t('pv'), type: 'area', data: pts(samples, (r) => r.pv_kw) },
    { name: t('load'), type: 'line', data: pts(samples, (r) => r.load_kw) },
    { name: t('charge'), type: 'line', data: pts(samples, bat((v) => Math.max(v, 0))) },
    { name: t('discharge'), type: 'line', data: pts(samples, bat((v) => Math.max(-v, 0))) },
    { name: t('soc'), type: 'line', data: pts(samples, (r) => r.soc) },
  ] : []);
  // Integrated 5-minute samples give the shape; scale it to Huawei's day total, which matches the bill.
  let acc = 0;
  const raw = samples.map((r) => [r.ts, r.pv_kw == null ? null : (acc += r.pv_kw / 12)]);
  const total = days[0]?.pv_kwh ?? acc;
  const k = acc > 0 ? total / acc : 1;
  charts.cum.updateOptions({ xaxis: { min: start.getTime(), max: end.getTime() }, noData: { text: day === isoDay(new Date()) ? t('noSunYet') : days[0]?.pv_kwh === 0 ? t('noProductionDay') : t('noData') } });
  charts.cum.updateSeries(acc > 0 ? [{ name: t('cumPv', { kwh: nf(2).format(total) }), type: 'area', data: raw.map(([x, y]) => [x, y == null ? null : y * k]) }] : []);
  $('next-day').disabled = day >= isoDay(new Date());
}

function fillMonths() {
  const now = new Date();
  const opts = [];
  for (let i = 0; i < 36; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString(t('_locale'), { month: 'long', year: 'numeric' });
    opts.push(`<option value="${isoMonth(d)}">${label.charAt(0).toUpperCase()}${label.slice(1)}</option>`);
  }
  $('month').innerHTML = opts.join('');
}

async function loadMonth() {
  const [y, m] = $('month').value.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const rows = await get(`/api/days?from=${$('month').value}-01&to=${$('month').value}-${pad(last)}`);
  renderTiles($('month-tiles'), rows, { month: true });
  const today = isoDay(new Date());
  const elapsed = Array.from({ length: last }, (_, i) => `${$('month').value}-${pad(i + 1)}`).filter((d) => d < today);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const gaps = elapsed.filter((d) => !byDay.has(d) || byDay.get(d).coverage < 0.95);
  $('month-warning').textContent = gaps.length
    ? t('incompleteMonth', { n: gaps.length, days: gaps.map((d) => Number(d.slice(8))).join(', ') })
    : '';
  const cats = Array.from({ length: last }, (_, i) => String(i + 1));
  const series = (k) => cats.map((c) => byDay.get(`${$('month').value}-${pad(Number(c))}`)?.[k] ?? null);
  const monthName = new Date(y, m - 1, 1).toLocaleDateString(t('_locale'), { month: 'short' });
  charts.month.updateOptions({ xaxis: { categories: cats }, tooltip: { x: { formatter: (v) => `${v} ${monthName}` } } });
  charts.month.updateSeries(rows.length ? [
    { name: t('pv'), data: series('pv_kwh') },
    { name: t('load'), data: series('load_kwh') },
    { name: t('import'), data: series('import_kwh') },
    { name: t('export'), data: series('export_kwh') },
  ] : []);
  $('next-month').disabled = $('month').value >= isoMonth(new Date());
  $('prev-month').disabled = $('month').selectedIndex === $('month').options.length - 1;
  const p = status.prices;
  $('prices-used').textContent = p
    ? t('pricesFull', { p1: nf(3).format(p.p1), p2: nf(3).format(p.p2), p3: nf(3).format(p.p3), adj: nf(3).format(p.adjust ?? 0), iee: nf(2).format((p.iee ?? 0) * 100), vat: nf(0).format((p.vat ?? 0) * 100), exp: nf(2).format(p.export) })
    : '';
}

async function loadEvents() {
  const now = Date.now();
  recentEvents = await get(`/api/events?from=${now - 30 * DAY}&to=${now + HOUR}`);
  renderEvents(recentEvents);
}

async function refreshNow() {
  const s = await get('/api/status');
  status = { ...status, ...s, battery: s.battery ?? status.battery };
  $('plant').textContent = s.plantName || s.station?.name || 'OpenFusionSolar';
  const raw = derive(s.realtime);
  renderStatus(s, raw, Date.now());
  renderFlow(raw, s.realtime?.soc);
  renderBattery(raw, s.realtime?.soc);
}

function showError(err) {
  $('status').className = 'status alarm';
  $('status').textContent = t('error', { msg: err.message });
}

function shift(input, unit, n) {
  const [y, m, d = 1] = input.value.split('-').map(Number);
  const date = unit === 'day' ? new Date(y, m - 1, d + n) : new Date(y, m - 1 + n, 1);
  input.value = unit === 'day' ? isoDay(date) : isoMonth(date);
}

// ---------- start ----------
translatePage();
$('glossary').innerHTML = t('glossary').map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
initCharts();
const today = new Date();
$('day').value = $('day').max = isoDay(today);
fillMonths();
$('month').value = isoMonth(today);
$('events-more').addEventListener('toggle', () => renderEvents(recentEvents));
$('day').addEventListener('change', () => loadDay().catch(showError));
$('month').addEventListener('change', () => loadMonth().catch(showError));
$('prev-day').addEventListener('click', () => { shift($('day'), 'day', -1); loadDay().catch(showError); });
$('next-day').addEventListener('click', () => { shift($('day'), 'day', 1); loadDay().catch(showError); });
$('today').addEventListener('click', () => { $('day').value = isoDay(new Date()); loadDay().catch(showError); });
$('prev-month').addEventListener('click', () => { shift($('month'), 'month', -1); loadMonth().catch(showError); });
$('next-month').addEventListener('click', () => { shift($('month'), 'month', 1); loadMonth().catch(showError); });

// Events first: the status banner uses them.
loadEvents().then(refreshNow).then(() => Promise.all([loadDay(), loadMonth()])).catch(showError);
setInterval(() => {
  const now = new Date();
  const tasks = [loadEvents().then(refreshNow)];
  if ($('day').value === isoDay(now)) tasks.push(loadDay());
  if ($('month').value === isoMonth(now)) tasks.push(loadMonth());
  Promise.all(tasks).catch(showError);
}, 60e3);
