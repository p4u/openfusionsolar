// Pure helpers of the Billing summary view (no DOM, runs under Node). Input is the /api/billing summary.
import { register, t, LANGS } from '../i18n.js';
import dict from '../i18n/billing.js';
import { eur, kwh, kw, pct, nf, fmtDate, fmtMonthShort } from '../format.js';
import { percents } from './energy-model.js';

register(dict);

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const daysText = (n) => t(n === 1 ? 'billing.days.one' : 'billing.days.other', { n });

// "d’octubre" / "de març" in Catalan, the plain month elsewhere, in the language asked for.
function monthName(month, lang) {
  const locale = LANGS[lang]?.locale ?? LANGS.en.locale;
  const name = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15));
  return { month: name, of: lang === 'ca' ? `${/^[aeiouàèéíòóú]/i.test(name) ? 'd’' : 'de '}${name}` : name };
}

// The first line of the page: how many bills we have and how the latest one fared against the measurements.
// Null without bills (the view shows its empty state instead).
export function statusSentence(summary, lang) {
  const bills = [...(summary?.invoices ?? [])].sort((a, b) => (a.period.to < b.period.to ? -1 : 1));
  if (!bills.length) return null;
  const { bills: n, months: m } = summary.tiles;
  const count = t(m === 12 ? 'billing.status.count' : 'billing.status.countPeriod', { n, m });
  const last = bills.at(-1);
  const c = last.compare;
  const days = c.verdict === 'nodata' ? daysText(Math.max(c.days - c.daysWithData, 0)) : '';
  return `${count} ${t(`billing.status.${c.verdict}`, { ...monthName(last.month, lang), days })}`;
}

// The four parts of B2 as whole percents that add up to 100 (energy is net of the surplus discount; a part below
// zero counts as none). Empty when nothing was paid.
const SEGMENTS = [['energy', 'grid'], ['fixed', 'fixed'], ['taxes', 'muted'], ['other', 'home']];
export function breakdownSegments(summary) {
  const eurs = SEGMENTS.map(([k]) => Math.max(summary?.breakdown?.[k]?.eur ?? 0, 0));
  const shares = percents(eurs);
  if (shares[0] == null) return [];
  return SEGMENTS.map(([key, entity], i) => ({ key, entity, eur: eurs[i], pct: shares[i] }));
}

// One reconciliation row per bill: the verdict, kWh billed and measured, and which of the two causes explains the gap
// in euros (prices changed, kWh differ, or charges the forecast cannot know).
export function reconRows(invoices) {
  return [...(invoices ?? [])].sort((a, b) => (a.period.to < b.period.to ? 1 : -1)).map((b) => {
    const c = b.compare;
    const billed = c.kwh.billed.total;
    const measured = c.kwh.measured?.total ?? null;
    const d = c.diff;
    let reason = null;
    let reasonEur = null;
    if (c.verdict !== 'nodata' && d) {
      const [p, k, o] = [d.prices, d.kwh, d.other].map((v) => Math.abs(v ?? 0));
      if (d.prices == null && d.kwh == null) reason = 'noEstimate';
      else if (Math.max(p, k, o) < 0.5) reason = 'none';
      else if (o > Math.max(p, k)) [reason, reasonEur] = ['other', d.other];
      else [reason, reasonEur] = p >= k ? ['prices', d.prices] : ['kwh', d.kwh];
    }
    return {
      id: b.id, month: b.month, period: b.period, total: b.total, verdict: c.verdict, billed, measured,
      missingDays: c.verdict === 'nodata' ? Math.max(c.days - c.daysWithData, 0) : 0,
      diffPct: num(billed) && num(measured) && measured > 0 ? ((billed - measured) / measured) * 100 : null,
      reason, reasonEur,
    };
  });
}

const per = (v) => `${nf(3).format(v)} €/kWh`;
const trio = (p) => `P1 ${nf(3).format(p.p1)} / P2 ${nf(3).format(p.p2)} / P3 ${nf(3).format(p.p3)}`;
const day = (d) => fmtDate(d, { day: 'numeric', month: 'short', year: 'numeric' });

// A card of /api/billing advice as ready text: { id, state, title, text, how, caveat, lines, period }.
// `lines` (the configuration file lines of the prices card) are API data, never copy.
export function adviceView(card) {
  const n = card.numbers ?? {};
  const k = (key) => `billing.advice.${card.id}.${key}`;
  const range = { from: day(card.period.from), to: day(card.period.to) };
  let text;
  let vars = range;
  let lines = null;
  switch (card.id) {
    case 'power':
      vars = { ...range, kw: kw(n.contractedKw), max: kw(n.maxKw), n: n.daysOver, eur: eur(n.savingsYear) };
      text = t(k(card.state), card.state === 'lower' ? { ...vars, kw: kw(n.suggestedKw) } : vars);
      break;
    case 'peak':
      vars = { pct: pct(n.share * 100), kwh: kwh(n.movedKwhYear), eur: eur(n.savingsYear) };
      text = t(k(card.state), vars);
      break;
    case 'surplus':
      vars = { sp: per(n.surplusPrice), bp: per(n.boughtPrice), ratio: nf(1).format(n.ratio), kwh: kwh(n.surplusKwh), eur: eur(n.lostEur) };
      text = [t(k(card.state), vars), n.lostEur > 0 ? t(k('lost'), vars) : ''].filter(Boolean).join(' ');
      break;
    case 'prices':
      vars = { ...range, env: n.env ? trio(n.env) : '', bill: trio(n.bill) };
      text = t(k(card.state), vars);
      if (card.state !== 'same') lines = n.lines;
      break;
    case 'tariff':
      text = t(k('info'), { price: per(n.allInPerKwh) });
      break;
    default: { // data
      const parts = [];
      if (n.missing?.length) parts.push(t(k('missing'), { list: n.missing.map(fmtMonthShort).join(', ') }));
      if (n.review?.length) parts.push(t(k('review'), { n: n.review.length }));
      if (n.check?.length) parts.push(t(k('check'), { n: n.check.length }));
      text = parts.join(' ') || t(k(card.state));
    }
  }
  return { id: card.id, state: card.state, title: t(k('title')), text, how: t(k('how'), vars), caveat: t(k('caveat')), lines, period: card.period };
}

// "Not compared: October, 12 days of measurements missing." for the bills with too few measured days; '' when all compare.
// bills: invoices with a `label` (the month as written for the reader).
export function notComparedList(bills) {
  const list = bills.filter((b) => b.compare.verdict === 'nodata')
    .map((b) => t('billing.chart.notComparedItem', { month: b.label ?? b.month, days: daysText(Math.max(b.compare.days - b.compare.daysWithData, 0)) }));
  return list.length ? t('billing.chart.notCompared', { list: list.join('; ') }) : '';
}

// How the saving of the bills we could compare splits: electricity not bought, surplus discount, and what neither explains.
export function savingsSplit(invoices) {
  const s = (invoices ?? []).map((b) => b.compare.savings).filter(Boolean);
  const add = (k) => Math.round(s.reduce((a, x) => a + (x[k] ?? 0), 0) * 100) / 100;
  return { bills: s.length, saved: Math.round((add('avoided') + add('surplusDiscount') + add('other')) * 100) / 100, avoided: add('avoided'), surplus: add('surplusDiscount'), other: add('other') };
}
