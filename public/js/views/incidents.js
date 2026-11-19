// Incidents view: what happened to the plant, and whether the house kept its power.
import { register, t, locale } from '../i18n.js';
import dict from '../i18n/incidents.js';
import { esc, icon, emptyState, loadBlock, every } from '../ui.js';
import { getEvents } from '../api.js';
import { parseRange, rangeLabel } from '../range.js';
import { renderRangeBar } from '../range-bar.js';
import { figure, chart } from '../charts.js';
import { addDays } from '../buckets.js';
import { duration, fmtDate, fmtTime, fmtMonthShort, dayOf } from '../format.js';
import { eventItem, summarize, groupNetwork, groupEpisodes } from '../incidents.js';
import { filterKinds, hoursPerMonth } from './incidents-model.js';

register(dict);

const SHOWN = 8; // rows before "Show all"
const MAX_DAYS = 800; // /api/events limit
const KINDS = ['gridCut', 'noProduction', 'network', 'batteryLow', 'overload', 'other'];
// one chart series per group of kinds; colour is status here. Internet losses last far longer than the rest and
// would flatten them, so they get their own small chart.
const GROUPS = [
  { key: 'cut', kinds: ['gridCut'], entity: 'alarm' },
  { key: 'stopped', kinds: ['noProduction'], entity: 'warn' },
  { key: 'other', kinds: ['batteryLow', 'overload', 'other'], entity: 'home' },
];
const NETWORK = [{ key: 'network', kinds: ['network'], entity: 'muted' }];

// One list row as a <details>: the shared row markup is the summary, the raw alarm names and the link to the day are the body.
function row(e, all) {
  const tpl = document.createElement('template');
  tpl.innerHTML = eventItem(e).trim();
  const li = tpl.content.firstElementChild;
  const body = li.querySelector('.event-body');
  const members = e.kind === 'networkDay' ? all.filter((x) => x.kind === 'network' && !x.ongoing && dayOf(x.start) === e.day) : [];
  const names = [...new Set((e.kind === 'networkDay' ? members.flatMap((x) => x.names ?? []) : [...(e.names ?? []), ...(e.related ?? []).flatMap((r) => r.names ?? [])]))];
  const day = e.day ?? dayOf(e.start);
  const det = document.createElement('details');
  det.className = 'incidents-row';
  const summary = document.createElement('summary');
  const text = document.createElement('div');
  text.append(...body.childNodes);
  summary.append(text);
  summary.insertAdjacentHTML('beforeend', icon('chevron-down', { size: 16 }));
  det.append(summary);
  det.insertAdjacentHTML('beforeend', `<div class="incidents-detail">
    ${names.length
      ? `<p class="hint">${esc(t('incidents.alarmNames'))}</p><ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
      : `<p class="hint">${esc(t('incidents.noNames'))}</p>`}
    ${members.length > 1 ? `<ul>${members.map((x) => `<li class="num">${esc(t('incidents.loss', { from: fmtTime(x.start), to: fmtTime(x.end), d: duration(x.end - x.start) }))}</li>`).join('')}</ul>` : ''}
    <a class="link" href="#/energy?r=custom&amp;from=${esc(day)}&amp;to=${esc(day)}">${esc(t('incidents.seeDay'))}</a></div>`);
  body.replaceChildren(det);
  return li;
}

export async function render(root, ctx) {
  const { status, signal } = ctx;
  const rctx = { today: status.today, firstDay: status.firstDay };
  const range = parseRange(ctx.params, rctx, '30d');
  const picked = (ctx.params.get('kinds') ?? '').split(',').filter((k) => KINDS.includes(k));
  const from = [range.from, addDays(range.to, -(MAX_DAYS - 1))].reduce((a, b) => (b > a ? b : a));
  const clamped = from > range.from;

  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('incidents.title'))}</h1></header>
    <div class="incidents-range"></div>
    <div class="incidents-main"></div>
    <details class="disclosure incidents-more"><summary><span>${esc(t('incidents.more'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      <div class="card incidents-month"></div></details>`;
  const q = (s) => root.querySelector(s);
  const bar = renderRangeBar(q('.incidents-range'), { range, ctx: rctx, compare: false, onChange: (p) => ctx.setParams(p) });

  let eventsP = null;
  const events = () => (eventsP ??= getEvents({ from, to: range.to }, { signal }).catch((e) => {
    eventsP = null;
    throw e;
  }));

  async function main(el) {
    const all = await events();
    const events_ = filterKinds(all, picked);
    el.replaceChildren();
    const label = rangeLabel(clamped ? { ...range, r: 'custom', from } : range, locale());
    const present = KINDS.filter((k) => all.some((e) => e.kind === k));
    const chips = present.length
      ? `<div class="incidents-chips" role="group" aria-label="${esc(t('incidents.filter'))}">${present.map((k) => {
        const on = picked.includes(k);
        return `<button type="button" class="pill pill-outline incidents-chip" data-kind="${k}" aria-pressed="${on}">${esc(t(`incidents.kind.${k}`))} <span class="num">${all.filter((e) => e.kind === k).length}</span></button>`;
      }).join('')}</div>` : '';
    const summary = events_.length ? t('incidents.summary', { period: label, list: summarize(events_) }) : t(picked.length ? 'incidents.noneFiltered' : 'incidents.none');
    el.innerHTML = `<p class="lead incidents-summary">${esc(summary)}</p>${chips}${clamped ? `<p class="hint">${esc(t('incidents.clamped', { date: fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' }) }))}</p>` : ''}`;
    if (!events_.length) {
      el.insertAdjacentHTML('beforeend', emptyState({ title: t('core.empty.title'), body: t('incidents.noneHint') }));
      return;
    }
    // network losses are one row per day; the rest stays one row per event, most recent first
    const items = groupNetwork(groupEpisodes(events_));
    const important = items.filter((e) => e.kind !== 'networkDay');
    const minor = items.filter((e) => e.kind === 'networkDay');
    const shown = [...important.slice(0, SHOWN), ...minor.slice(0, Math.max(0, SHOWN - important.length))].sort((a, b) => b.start - a.start);
    const rest = items.filter((e) => !shown.includes(e));
    const card = document.createElement('div');
    card.className = 'card incidents-card';
    const list = (es) => {
      const ul = document.createElement('ul');
      ul.className = 'incidents-list';
      ul.append(...es.map((e) => row(e, events_)));
      return ul;
    };
    card.append(list(shown));
    if (rest.length) {
      const more = document.createElement('details');
      more.className = 'disclosure incidents-rest';
      more.innerHTML = `<summary><span>${esc(t('incidents.showAll', { n: items.length }))}</span>${icon('chevron-down', { size: 16 })}</summary>`;
      more.append(list(rest));
      more.addEventListener('toggle', () => { more.querySelector('summary span').textContent = t(more.open ? 'incidents.hide' : 'incidents.showAll', { n: items.length }); });
      card.append(more);
    }
    el.append(card);
  }

  q('.incidents-main').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-kind]');
    if (!chip) return;
    const next = picked.includes(chip.dataset.kind) ? picked.filter((k) => k !== chip.dataset.kind) : [...picked, chip.dataset.kind];
    ctx.setParams({ kinds: next.length ? next.join(',') : null });
  });

  let handle = null;
  async function month(el) {
    const rows = hoursPerMonth(await events(), picked);
    handle?.destroy();
    handle = null;
    el.replaceChildren();
    if (!rows.length) {
      el.innerHTML = emptyState({ title: t('core.empty.title'), body: t('incidents.none') });
      return;
    }
    const data = (g) => rows.map((r) => g.kinds.reduce((a, k) => a + (r.hours[k] ?? 0), 0));
    const names = Object.fromEntries([...GROUPS, ...NETWORK].map((g) => [g.key, t(`incidents.month.${g.key}`)]));
    const cats = rows.map((r) => fmtMonthShort(r.month));
    const parts = [];
    const draw = (id, groups, title, caption) => {
      if (!groups.some((g) => data(g).some((v) => v > 0))) return;
      const fig = figure(el, { title, csvName: `${id}-${from}_${range.to}` });
      fig.setCaption(caption);
      fig.setTable([t('incidents.month.col'), ...groups.map((g) => ({ label: names[g.key], unit: 'h', decimals: 1 }))],
        rows.map((r, i) => [cats[i], ...groups.map((g) => data(g)[i])]), rows.map((r) => r.month));
      const c = chart(fig.host, {
        id, kind: 'category', unit: 'h', stacked: true, y: { min: 0, decimals: 1 }, x: { categories: cats },
        ...(groups === NETWORK && { height: 'strip' }),
        series: groups.map((g) => ({ key: g.key, name: names[g.key], type: 'bar', entity: g.entity, data: data(g) })),
      });
      parts.push(c, fig);
    };
    draw('incidents-month', GROUPS, t('incidents.month.title'), t('incidents.month.caption'));
    draw('incidents-month-network', NETWORK, t('incidents.month.networkTitle'), t('incidents.month.networkCaption'));
    if (!parts.length) el.innerHTML = emptyState({ title: t('core.empty.title'), body: t('incidents.none') });
    handle = { destroy: () => parts.forEach((p) => p.destroy()) };
  }

  const blocks = [[q('.incidents-main'), main]];
  loadBlock(q('.incidents-main'), 200, main);
  // the chart needs a visible box, so it is drawn when the section is first opened
  const more = q('.incidents-more');
  more.addEventListener('toggle', () => {
    if (!more.open || more.dataset.loaded) return;
    more.dataset.loaded = '1';
    blocks.push([q('.incidents-month'), month]);
    loadBlock(q('.incidents-month'), 300, month);
  });

  if (range.to === status.today) {
    every(60000, () => {
      eventsP = null;
      for (const [el, fn] of blocks) fn(el).catch(() => {}); // a failed refresh keeps what is on screen
    }, signal);
  }

  return () => {
    bar.destroy();
    handle?.destroy();
  };
}
