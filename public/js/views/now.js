// Now view: do I need to act, where the energy goes, the battery, today, this month, the latest incidents.
import { register, t } from '../i18n.js';
import dict from '../i18n/now.js';
import { getStatus, getSeries, getEnergy, getEvents } from '../api.js';
import { esc, icon, statusLine, ledger, emptyState, loadBlock, every } from '../ui.js';
import { kw, kwh, eur, pct, fmtTime, fmtDate, fmtMonth, duration, delta, dayOf, dayStart, isoLocal } from '../format.js';
import { eventItem, groupNetwork, groupEpisodes, summarize } from '../incidents.js';
import { addDays } from '../buckets.js';
import { figure, chart } from '../charts.js';
import { gapBands, eventBands } from '../chart-data.js';
import { headline, flow, autonomyHours, reserveNote, todayTiles } from './now-model.js';

register(dict);

const DAY = 24 * 3600e3;
const REFRESH_MS = 60e3;
const BAT_ACTIVE_KW = 0.05;

// ---------- flow diagram ----------
// a 400-unit-wide box keeps node text near its nominal size on a 390 px phone
const NODES = {
  pv: { x: 200, y: 70, icon: 'sun', name: 'core.entity.sun' },
  grid: { x: 68, y: 210, icon: 'utility-pole', name: 'core.entity.grid' },
  home: { x: 332, y: 210, icon: 'house', name: 'core.entity.home' },
  bat: { x: 200, y: 350, icon: 'battery-medium', name: 'core.entity.battery' },
};
const CENTRE = [200, 210];

// Straight when the nodes share a row or column, else a curve through the middle. Returns the path and an arrow pose.
function linkGeometry(a, b, at = 0.55) {
  const p = NODES[a];
  const q = NODES[b];
  if (p.x === q.x || p.y === q.y) {
    return { d: `M${p.x},${p.y} L${q.x},${q.y}`, x: p.x + (q.x - p.x) * at, y: p.y + (q.y - p.y) * at, deg: (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI };
  }
  const [cx, cy] = CENTRE;
  const u = 1 - at;
  return {
    d: `M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}`,
    x: u * u * p.x + 2 * u * at * cx + at * at * q.x,
    y: u * u * p.y + 2 * u * at * cy + at * at * q.y,
    deg: (Math.atan2(2 * u * (cy - p.y) + 2 * at * (q.y - cy), 2 * u * (cx - p.x) + 2 * at * (q.x - cx)) * 180) / Math.PI,
  };
}

const ALL_LINKS = [['pv', 'home'], ['pv', 'bat'], ['pv', 'grid'], ['grid', 'home'], ['grid', 'bat'], ['bat', 'home']];

function sentence(rt, f) {
  if (rt?.load_kw == null) return t('now.flow.noData');
  const sources = [
    rt.pv_kw > 0.01 && t('now.flow.src.sun', { v: kw(Math.min(rt.pv_kw, rt.load_kw)) }),
    f.give > 0.01 && t('now.flow.src.battery', { v: kw(f.give) }),
    f.imp > 0.01 && t('now.flow.src.grid', { v: kw(f.imp) }),
    f.exp > 0.01 && t('now.flow.src.export', { v: kw(f.exp) }),
  ].filter(Boolean).join(' ');
  return t('now.flow.sentence', { load: kw(rt.load_kw), sources }).trim();
}

function flowCard(status) {
  const rt = status.realtime;
  const f = flow(rt);
  const active = new Map(f.links.map((l) => [`${l.from}-${l.to}`, l]));
  const name = (k) => t(NODES[k].name);
  const links = ALL_LINKS.map(([a, b]) => {
    const g = linkGeometry(a, b);
    const l = active.get(`${a}-${b}`);
    if (!l) return `<path class="now-link" d="${g.d}"/>`;
    return `<path class="now-link now-on now-from-${a}" d="${g.d}"><title>${esc(t('now.flow.link', { from: name(a), to: name(b), v: kw(l.kw) }))}</title></path>
      <path class="now-arrow now-from-${a}" d="M-7,-6 L7,0 L-7,6 Z" transform="translate(${g.x.toFixed(1)} ${g.y.toFixed(1)}) rotate(${g.deg.toFixed(1)})"/>`;
  }).join('');
  const gridVerb = f.exp > 0.01 ? t('now.flow.selling') : f.imp > 0.01 ? t('now.flow.buying') : t('now.flow.idle');
  // value, then up to two short lines: a number and a verb never share a line, so each fits inside the circle
  const batKw = f.give > 0.01 ? f.give : f.charge > BAT_ACTIVE_KW ? f.charge : null;
  const rows = {
    pv: [kw(rt?.pv_kw)],
    home: [kw(rt?.load_kw)],
    grid: [kw(f.exp > 0.01 ? f.exp : f.imp), gridVerb],
    bat: [pct(rt?.soc), ...(batKw == null ? [t('now.flow.idle')] : [kw(batKw), t(f.give > 0.01 ? 'now.flow.giving' : 'now.flow.charging')])],
  };
  const nodes = Object.entries(NODES).map(([k, n]) => `<g class="now-node now-n-${k}" aria-hidden="true">
      <circle cx="${n.x}" cy="${n.y}" r="64"/>
      <svg class="icon" x="${n.x - 10}" y="${n.y - 52}" width="20" height="20" viewBox="0 0 24 24"><use href="/icons.svg#${n.icon}"/></svg>
      <text class="now-node-label" x="${n.x}" y="${n.y - 14}">${esc(name(k))}</text>
      <text class="now-node-value" x="${n.x}" y="${n.y + 8}">${esc(rows[k][0])}</text>
      ${rows[k].slice(1).map((line, i) => `<text class="now-node-sub" x="${n.x}" y="${n.y + 26 + i * 17}">${esc(line)}</text>`).join('')}</g>`).join('');
  const text = sentence(rt, f);
  return `<section class="card span-6 now-flow" aria-labelledby="now-flow-title">
    <div class="card-head"><h2 class="card-title" id="now-flow-title">${esc(t('now.flow.title'))}</h2></div>
    <svg class="now-flow-svg" viewBox="0 0 400 420" role="img" aria-label="${esc(text)}">${links}${nodes}</svg>
    <p class="now-sentence">${esc(text)}</p>
  </section>`;
}

// ---------- battery card ----------
const hoursFloor = (b) => (b.minPct ? t('now.bat.autonomyFloor', { min: b.minPct }) : '');

function batteryCard(status) {
  const rt = status.realtime;
  const b = status.battery ?? {};
  const soc = rt?.soc ?? null;
  const charge = Math.max(rt?.battery_kw ?? 0, 0);
  const give = Math.max(-(rt?.battery_kw ?? 0), 0);
  let state = t('now.bat.idle');
  if (charge > BAT_ACTIVE_KW) state = t((rt.grid_kw ?? 0) > BAT_ACTIVE_KW && (rt.pv_kw ?? 0) < charge ? 'now.bat.chargingGrid' : 'now.bat.chargingSun', { v: kw(charge) });
  else if (give > BAT_ACTIVE_KW) state = t('now.bat.giving', { v: kw(give) });
  // one sentence on the card; why the grid stops short of the reserve goes in the detail below
  const note = reserveNote(soc, b);
  if (note) state += ` ${t('now.bat.reserve.plain', note.vars)}`;
  const why = [note && note.key !== 'plain' && t(`now.bat.reserve.${note.key}`, note.vars), hoursFloor(b)].filter(Boolean);
  const hours = autonomyHours(soc, b, rt?.load_kw);
  const autonomy = hours == null ? '' : hours === 0 ? t('now.bat.autonomyNone') : t('now.bat.autonomy', { hours: duration(hours * 3600e3) });
  const limits = [
    ['capacity', 'capacityKwh', b.capacityKwh != null && kwh(b.capacityKwh, 1), ''],
    ['minPct', 'minPct', b.minPct != null && pct(b.minPct), ''],
    ['reserve', 'reservePct', b.reservePct != null && pct(b.reservePct), b.reserveSince ? t('now.bat.reserveSince', { date: fmtDate(b.reserveSince) }) : ''],
    ['gridCharge', 'gridChargeCutoffPct', b.chargeFromGrid && b.gridChargeCutoffPct != null && pct(b.gridChargeCutoffPct), ''],
    ['maxCharge', 'maxChargeKw', b.maxChargeKw != null && kw(b.maxChargeKw), ''],
    ['maxDischarge', 'maxDischargeKw', b.maxDischargeKw != null && kw(b.maxDischargeKw), ''],
  ].filter((r) => r[2]);
  const reserveName = b.reservePct == null ? '' : t('now.bat.reserveMark', { v: b.reservePct });
  const bar = soc == null ? '' : `<div class="now-soc-bar" role="img" aria-label="${esc([pct(soc), reserveName].filter(Boolean).join(', '))}"><span class="now-soc-fill" style="width:${Math.min(Math.max(soc, 0), 100)}%"></span>${b.reservePct == null ? '' : `<span class="now-soc-reserve" style="left:${b.reservePct}%"></span>`}</div>
    ${reserveName ? `<p class="now-soc-mark${b.reservePct > 80 ? ' at-end' : b.reservePct < 20 ? ' at-start' : ''}" style="--at:${b.reservePct}%" aria-hidden="true">${esc(reserveName)}</p>` : ''}`;
  return `<section class="card span-6 now-bat" aria-labelledby="now-bat-title">
    <div class="card-head"><h2 class="card-title" id="now-bat-title">${esc(t('now.bat.title'))}</h2></div>
    <p class="now-soc">${esc(pct(soc))}</p>${bar}
    <p class="now-bat-state">${esc(soc == null ? t('now.bat.noReading') : state)}</p>
    ${autonomy ? `<p class="now-bat-autonomy">${esc(autonomy)}</p>` : ''}
    ${why.length || limits.length ? `<details class="disclosure now-bat-more"><summary><span>${esc(t('now.bat.more'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      ${why.map((w) => `<p class="hint">${esc(w)}</p>`).join('')}
      ${limits.length ? `<dl class="now-limits">${limits.map(([k, , v, extra]) => `<div class="now-limit"><dt>${esc(t(`now.bat.${k}`))}</dt>
      <dd><span class="num">${esc(v)}</span>${extra ? ` <span class="hint">${esc(extra)}</span>` : ''}</dd></div>`).join('')}</dl>` : ''}</details>` : ''}
  </section>`;
}

// Month and year so far under the headline: savings when prices are set, and this year's production.
// A ledger card, so the headline's orb never sits behind a number.
function heroFacts(status, month, year) {
  const facts = [
    status.pricesConfigured && month?.money && { icon: 'euro', label: t('now.hero.monthSavings'), value: eur(month.money.savings) },
    status.pricesConfigured && year?.money && { icon: 'euro', label: t('now.hero.yearSavings'), value: eur(year.money.savings) },
    year?.days && { icon: 'sun', label: t('now.hero.yearProduced'), value: kwh(year.pv_kwh) },
  ].filter(Boolean);
  return facts.length ? `<section class="now-hero-facts" aria-label="${esc(t('now.hero.label'))}">${ledger(facts)}</section>` : '';
}

// ---------- blocks ----------
async function fillTop(el, ctx, shared) {
  const { signal } = ctx;
  const today = shared.status?.today ?? dayOf(Date.now());
  const [status, events, month, year] = await Promise.all([
    getStatus({ signal }),
    getEvents({ from: addDays(today, -30), to: today }, { signal }),
    getEnergy({ from: `${today.slice(0, 7)}-01`, to: today, bucket: '1mo' }, { signal }),
    getEnergy({ from: `${today.slice(0, 4)}-01-01`, to: today, bucket: '1mo' }, { signal }),
  ]);
  shared.status = status;
  const now = Date.now();
  const h = headline(status, events, now);
  const recent = events.filter((e) => e.end > now - DAY && !e.ongoing);
  const col = status.collector;
  const details = [
    t(h.key, h.vars),
    recent.length && t('now.head.recent', { list: summarize(recent) }),
    col?.backfill && t('now.backfill', { done: col.backfill.done, total: col.backfill.total }),
    col?.authBlockedUntil > now && t('now.authPaused', { time: fmtTime(col.authBlockedUntil) }),
  ].filter(Boolean);
  const link = recent.length ? { href: '#/incidents', label: t('now.head.seeIncidents') } : null;
  el.innerHTML = `${statusLine({ state: h.state, title: t(`${h.key}.title`), details, link })}${heroFacts(status, month.total, year.total)}
    <div class="grid now-grid">${flowCard(status)}${batteryCard(status)}</div>`;
  ctx.fresh.textContent = status.lastSampleTs ? t('now.dataFrom', { time: fmtTime(status.lastSampleTs) }) : '';
}

async function fillTiles(el, ctx, shared) {
  const day = shared.status?.today ?? dayOf(Date.now());
  const e = await getEnergy({ from: day, to: day, bucket: '1d' }, { signal: ctx.signal });
  el.innerHTML = e.total.days ? ledger(todayTiles(e.total, shared.status ?? {})) : emptyState({ title: t('now.tiles.none') });
}

async function fillChart(el, ctx, shared, state) {
  const day = shared.status?.today ?? dayOf(Date.now());
  const [s, events] = await Promise.all([
    getSeries({ from: day, to: day, bucket: '5m' }, { signal: ctx.signal }),
    getEvents({ from: day, to: day }, { signal: ctx.signal }),
  ]);
  const now = Date.now();
  const [from, to] = [dayStart(day), dayStart(addDays(day, 1))];
  const pairs = (a) => s.t.map((ms, i) => [ms, a[i]]);
  const { pv_kw: pv, load_kw: load } = s.series;
  const spec = {
    id: 'now-power', kind: 'time', height: 240, unit: t('core.unit.kw'), x: { min: from, max: to }, y: { min: 0, decimals: 1 },
    coverage: s.coverage, provisional: s.provisional,
    bands: [...gapBands({ t: s.t, coverage: s.coverage, bucketMs: 300e3, now }), ...eventBands(events, from, to)],
    series: [
      { key: 'sun', name: t('core.entity.sun'), type: 'area', entity: 'sun', data: pairs(pv) },
      { key: 'home', name: t('core.entity.home'), type: 'line', entity: 'home', data: pairs(load) },
    ],
  };
  if (!state.fig || !el.contains(state.fig.host)) {
    el.replaceChildren();
    state.fig = figure(el, { title: t('now.chart.title'), csvName: `${t('now.chart.csv')}-${day}` });
    state.chart = chart(state.fig.host, spec);
  } else state.chart.update(spec);
  const peak = pv.reduce((best, v, i) => (v != null && (best < 0 || v > pv[best]) ? i : best), -1);
  state.fig.setCaption(peak >= 0 && pv[peak] > 0 ? t('now.chart.caption', { v: kw(pv[peak]), time: fmtTime(s.t[peak]) }) : s.series.pv_kw.some((v) => v != null) ? t('now.chart.noSun') : t('now.chart.noData'));
  const shown = s.t.map((ms, i) => i).filter((i) => pv[i] != null || load[i] != null);
  state.fig.setTable(
    [{ label: t('now.chart.time') }, { label: t('core.entity.sun'), unit: t('core.unit.kw') }, { label: t('core.entity.home'), unit: t('core.unit.kw') }],
    shown.map((i) => [fmtTime(s.t[i]), pv[i], load[i]]),
    shown.map((i) => isoLocal(s.t[i], '5m')),
  );
}

async function fillMonth(el, ctx, shared) {
  const day = shared.status?.today ?? dayOf(Date.now());
  const e = await getEnergy({ from: `${day.slice(0, 7)}-01`, to: day, bucket: '1mo', compare: 'yoy' }, { signal: ctx.signal });
  if (!e.total.days) {
    el.innerHTML = emptyState({ title: t('now.month.none') });
    return;
  }
  const c = e.compare;
  const vs = (cur, prev) => (c?.comparable ? `${delta(cur, prev).text} ${t('now.month.vs')}` : undefined);
  const list = [
    { icon: 'sun', label: t('now.tiles.produced'), value: kwh(e.total.pv_kwh), delta: vs(e.total.pv_kwh, c?.total.pv_kwh) },
    { icon: 'house', label: t('now.tiles.consumed'), value: kwh(e.total.load_kwh), delta: vs(e.total.load_kwh, c?.total.load_kwh) },
    { icon: 'utility-pole', label: t('now.tiles.bought'), value: kwh(e.total.import_kwh), delta: vs(e.total.import_kwh, c?.total.import_kwh) },
    { icon: 'zap', label: t('now.tiles.sold'), value: kwh(e.total.export_kwh), delta: vs(e.total.export_kwh, c?.total.export_kwh) },
  ];
  el.innerHTML = `${ledger(list)}${c && !c.comparable ? `<p class="hint">${esc(t(`now.month.notComparable.${c.reason}`))}</p>` : ''}`;
}

async function fillIncidents(el, ctx, shared) {
  const day = shared.status?.today ?? dayOf(Date.now());
  const events = await getEvents({ from: addDays(day, -30), to: day }, { signal: ctx.signal });
  const last = groupNetwork(groupEpisodes(events)).slice(0, 3);
  el.innerHTML = `<div class="card">${last.length ? `<ul class="events">${last.map(eventItem).join('')}</ul>` : `<p>${esc(t('now.inc.none'))}</p>`}
    <p class="now-more"><a href="#/incidents">${esc(t('now.inc.all'))}${icon('chevron-right', { size: 16 })}</a></p></div>`;
}

export async function render(root, ctx) {
  const shared = { status: ctx.status };
  const chartState = {};
  const section = (id, title, extra = '') => `<section class="band"><div class="band-head"><h2 class="section-title">${esc(title)}</h2>${extra}</div><div id="${id}"></div></section>`;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('now.title'))}</h1><p class="hint" id="now-fresh"></p></header>
    <div id="now-top"></div>
    ${section('now-tiles', t('now.tiles.title'))}
    <section class="band"><div class="card" id="now-chart"></div>
      <p class="now-more"><a href="#/energy?r=today">${esc(t('now.chart.link'))}${icon('chevron-right', { size: 16 })}</a></p></section>
    ${section('now-month', t('now.month.title'), `<span class="hint">${esc(fmtMonth((ctx.today ?? dayOf(Date.now())).slice(0, 7)))}</span>`)}
    ${section('now-inc', t('now.inc.title'))}`;
  ctx.fresh = root.querySelector('#now-fresh');
  const blocks = [
    ['#now-top', 360, (el) => fillTop(el, ctx, shared)],
    ['#now-tiles', 220, (el) => fillTiles(el, ctx, shared)],
    ['#now-chart', 240, (el) => fillChart(el, ctx, shared, chartState)],
    ['#now-month', 120, (el) => fillMonth(el, ctx, shared)],
    ['#now-inc', 160, (el) => fillIncidents(el, ctx, shared)],
  ].map(([sel, h, fn]) => [root.querySelector(sel), h, fn]);
  // first paint shows a skeleton per block; later refreshes replace the content in place and keep the old one on failure
  await Promise.all(blocks.map(([el, h, fn]) => loadBlock(el, h, fn)));
  every(REFRESH_MS, () => {
    for (const [el, , fn] of blocks) {
      if (el.querySelector('.error')) continue;
      fn(el).catch((err) => err?.name !== 'AbortError' && console.error(err));
    }
  }, ctx.signal);
  return () => chartState.chart?.destroy();
}
