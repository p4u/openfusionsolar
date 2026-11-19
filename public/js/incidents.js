// Incident texts shared by Now and Incidents (ported from the first UI, without emoji or em dashes).
import { t } from './i18n.js';
import { duration, fmtDate, fmtDateTime, fmtTime, dayOf } from './format.js';
import { esc, icon } from './ui.js';

// [icon, tone]: the tone colours only the icon
const LOOK = {
  gridCut: ['zap-off', 'alarm'],
  overload: ['plug-zap', 'alarm'],
  batteryLow: ['battery-warning', 'warn'],
  noProduction: ['sun', 'warn'],
  noData: ['eye-off', 'warn'],
  network: ['wifi-off', 'muted'],
  networkDay: ['wifi-off', 'muted'],
  other: ['triangle-alert', 'warn'],
};

export function eventTitle(e) {
  if (e.kind === 'gridCut') {
    const cover = { true: 'core.ev.covered', false: 'core.ev.notCovered', overload: 'core.ev.coveredUntilOverload' }[e.batteryCovered];
    return `${t('core.ev.gridCut')}: ${t(cover ?? 'core.ev.unknown')}.`;
  }
  if (e.kind === 'network') return t(e.ongoing ? 'core.ev.networkOngoing' : 'core.ev.networkPast');
  if (e.kind === 'batteryLow') return t('core.ev.batteryLow');
  if (e.kind === 'overload') return t('core.ev.overload');
  if (e.kind === 'noProduction') return t('core.ev.noProduction');
  if (e.kind === 'noData') return t('core.ev.noData');
  return t('core.ev.other', { name: (e.names ?? []).join(', ') });
}

// "2 power cuts (3 h), 1 internet loss (20 min)"
export function summarize(events) {
  const of = (k) => events.filter((e) => e.kind === k);
  const line = (key, kind, withDuration) => {
    const list = of(kind);
    if (!list.length) return null;
    const d = withDuration ? duration(list.reduce((a, e) => a + (e.end - e.start), 0)) : '';
    return t(`core.ev.count.${key}${list.length === 1 ? 'One' : ''}`, { n: list.length, d });
  };
  return [
    line('cut', 'gridCut', true),
    line('stopped', 'noProduction', true),
    line('network', 'network', true),
    line('noData', 'noData', true),
    line('battery', 'batteryLow'),
    line('overload', 'overload'),
    line('other', 'other'),
  ].filter(Boolean).join(', ');
}

// "18 Nov, 11:15 – 15:00" when start and end fall on the same plant day, both dates otherwise.
export function whenText(e) {
  if (e.ongoing) return `${fmtDateTime(e.start)} – ${t('core.ev.ongoing')}`;
  return `${fmtDateTime(e.start)} – ${dayOf(e.start) === dayOf(e.end) ? fmtTime(e.end) : fmtDateTime(e.end)}`;
}

// One list row. networkDay rows come from groupNetwork(); `related` (a power-cut episode) from groupEpisodes().
export function eventItem(e) {
  const [name, tone] = LOOK[e.kind] ?? LOOK.other;
  const mark = `<span class="event-icon event-${tone}">${icon(name, { size: 16 })}</span>`;
  if (e.kind === 'networkDay') {
    const text = t(`core.ev.networkDay${e.recovered ? 'Recovered' : ''}${e.n === 1 ? 'One' : ''}`, { n: e.n, d: duration(e.total) });
    return `<li class="event event-kind-networkDay">${mark}<div class="event-body"><p class="event-when">${esc(fmtDate(e.start))}</p><p class="event-title">${esc(text)}</p></div></li>`;
  }
  const related = e.related?.length
    ? `<p class="event-related">${esc(t('core.ev.during', { list: e.related.map((r) => `${relatedTitle(r)} (${fmtTime(r.start)} – ${fmtTime(r.end)})`).join(', ') }))}</p>`
    : '';
  return `<li class="event event-kind-${esc(e.kind)}">${mark}<div class="event-body">
    <p class="event-when"><span>${esc(whenText(e))}</span><span class="event-duration">${esc(duration(e.end - e.start))}</span></p>
    <p class="event-title">${esc(eventTitle(e))}</p>${related}</div></li>`;
}

const relatedTitle = (r) => t(r.kind === 'overload' ? 'core.ev.short.overload' : r.kind === 'batteryLow' ? 'core.ev.short.batteryLow' : 'core.ev.short.other');

// A power cut, the overload and the low-battery warning it causes are one episode: the cut carries the others as
// `related` (those touching the cut, 5 minutes either side) and they leave the list.
const EPISODE = ['overload', 'batteryLow'];
const EPISODE_MARGIN_MS = 5 * 60e3;
export function groupEpisodes(events) {
  const taken = new Set();
  const out = events.map((e) => {
    if (e.kind !== 'gridCut') return e;
    const related = events.filter((r) => EPISODE.includes(r.kind) && !taken.has(r)
      && r.start <= e.end + EPISODE_MARGIN_MS && r.end >= e.start - EPISODE_MARGIN_MS);
    related.forEach((r) => taken.add(r));
    return related.length ? { ...e, related: related.sort((a, b) => a.start - b.start) } : e;
  });
  return out.filter((e) => !taken.has(e));
}

// Internet losses are many and harmless: one row per plant day; everything else stays one row per event.
// One counting rule everywhere (headline, summary, list): a loss belongs to the day it started, with its full length.
export function groupNetwork(events) {
  const days = new Map();
  const out = [];
  for (const e of events) {
    if (e.kind !== 'network' || e.ongoing) {
      out.push(e);
      continue;
    }
    const day = dayOf(e.start);
    if (!days.has(day)) days.set(day, { kind: 'networkDay', day, start: e.start, end: e.end, total: 0, n: 0, recovered: true });
    const g = days.get(day);
    g.recovered &&= e.recovered === true; // the server's flag: that loss's readings were filled in afterwards
    g.start = Math.min(g.start, e.start);
    g.end = Math.max(g.end, e.end);
    g.total += e.end - e.start;
    g.n += 1;
  }
  return [...out, ...days.values()].sort((a, b) => b.start - a.start);
}
