// Incident texts shared by Now and Incidents (ported from the first UI, without emoji or em dashes).
import { t } from './i18n.js';
import { duration, fmtDate, fmtDateTime, dayOf, dayStart } from './format.js';
import { esc, icon } from './ui.js';

const DAY = 24 * 3600e3;
// [icon, tone]: the tone colours only the icon
const LOOK = {
  gridCut: ['zap-off', 'alarm'],
  overload: ['plug-zap', 'alarm'],
  batteryLow: ['battery-warning', 'warn'],
  noProduction: ['sun', 'warn'],
  network: ['wifi-off', 'muted'],
  networkDay: ['wifi-off', 'muted'],
  other: ['triangle-alert', 'warn'],
};

export function eventTitle(e) {
  if (e.kind === 'gridCut') {
    const cover = { true: 'core.ev.covered', false: 'core.ev.notCovered', overload: 'core.ev.coveredUntilOverload' }[e.batteryCovered];
    return `${t('core.ev.gridCut')}: ${t(cover ?? 'core.ev.unknown')}`;
  }
  if (e.kind === 'network') return t(e.ongoing ? 'core.ev.networkOngoing' : 'core.ev.networkPast');
  if (e.kind === 'batteryLow') return t('core.ev.batteryLow');
  if (e.kind === 'overload') return t('core.ev.overload');
  if (e.kind === 'noProduction') return t('core.ev.noProduction');
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
    line('battery', 'batteryLow'),
    line('overload', 'overload'),
    line('other', 'other'),
  ].filter(Boolean).join(', ');
}

// One list row. networkDay rows come from groupNetwork().
export function eventItem(e) {
  const [name, tone] = LOOK[e.kind] ?? LOOK.other;
  const mark = `<span class="event-icon event-${tone}">${icon(name, { size: 16 })}</span>`;
  if (e.kind === 'networkDay') {
    const text = t(e.n === 1 ? 'core.ev.networkDayOne' : 'core.ev.networkDay', { n: e.n, d: duration(e.total) });
    return `<li class="event event-kind-networkDay">${mark}<div class="event-body"><p class="event-when">${esc(fmtDate(e.start))}</p><p class="event-title">${esc(text)}</p></div></li>`;
  }
  const until = e.ongoing ? t('core.ev.ongoing') : fmtDateTime(e.end);
  return `<li class="event event-kind-${esc(e.kind)}">${mark}<div class="event-body">
    <p class="event-when"><span>${esc(fmtDateTime(e.start))} – ${esc(until)}</span><span class="event-duration">${esc(duration(e.end - e.start))}</span></p>
    <p class="event-title">${esc(eventTitle(e))}</p></div></li>`;
}

// Internet losses are many and harmless: one row per plant day; everything else stays one row per event.
export function groupNetwork(events) {
  const days = new Map();
  const out = [];
  for (const e of events) {
    if (e.kind !== 'network' || e.ongoing) {
      out.push(e);
      continue;
    }
    const day = dayOf(e.start);
    if (!days.has(day)) days.set(day, { kind: 'networkDay', day, start: e.start, end: e.end, total: 0, n: 0 });
    const g = days.get(day);
    g.start = Math.min(g.start, e.start);
    g.end = Math.max(g.end, e.end);
    g.total += Math.min(e.end, dayStart(nextDay(day))) - e.start;
    g.n += 1;
  }
  return [...out, ...days.values()].sort((a, b) => b.start - a.start);
}

function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY).toISOString().slice(0, 10);
}
