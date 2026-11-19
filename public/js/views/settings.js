// Settings view: alerts (rules, recipients, quiet hours, test email, history), plant, appearance, glossary, about.
import { register, t, getLang, setLang, LANGS } from '../i18n.js';
import dict from '../i18n/settings.js';
import { esc, icon, loadBlock, emptyState, getTheme, setTheme } from '../ui.js';
import { getAlertsConfig, putAlertsConfig, sendTestEmail, getAlertsHistory, ApiError } from '../api.js';
import { kw, nf, pct, fmtDateTime, fmtTime } from '../format.js';
import { ruleSentenceParts, ruleTemplate, splitSentence, fieldErrorsByInput, errorText, authKey, lastFired, deliveryWords, setField } from './settings-model.js';

register(dict);

const PAGE = 50;
const THEMES = ['light', 'dark', 'system'];
const errorLine = (msg) => `<p class="field-error">${icon('circle-alert', { size: 16 })}<span>${esc(msg)}</span></p>`;

export async function render(root, ctx) {
  const { status, signal } = ctx;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('settings.title'))}</h1></header>
    <section class="band"><h2 class="section-title">${esc(t('settings.alerts.title'))}</h2>
      <div class="card" data-block="alerts"></div>
      <div class="card" data-block="history"></div></section>
    <section class="band"><h2 class="section-title">${esc(t('settings.plant.title'))}</h2><div class="card">${plantHtml(status)}</div></section>
    <section class="band"><h2 class="section-title">${esc(t('settings.appearance.title'))}</h2><div class="card">${appearanceHtml()}</div></section>
    <section class="band"><h2 class="section-title">${esc(t('settings.glossary.title'))}</h2><div class="card">${glossaryHtml()}</div></section>
    <section class="band"><h2 class="section-title">${esc(t('settings.about.title'))}</h2><div class="card">
      <p>${esc(t('settings.about.version', { version: status.version ?? t('core.unknown') }))}</p>
      <p class="hint">${esc(t('settings.about.text'))}</p></div></section>`;
  const q = (name) => root.querySelector(`[data-block="${name}"]`);

  // appearance
  root.querySelector('.settings-appearance').addEventListener('change', (e) => {
    if (e.target.name === 'theme') setTheme(e.target.value);
    else if (e.target.id === 'settings-lang') setLang(e.target.value);
  });

  // history rows are shared by "last fired" and the history list
  const rows = [];
  let more = true;
  const loadRows = async (before) => {
    const got = await getAlertsHistory({ limit: PAGE, before }, { signal });
    rows.push(...got);
    more = got.length === PAGE;
  };
  let first;
  const ensure = () => (first ??= loadRows().catch((err) => {
    first = undefined; // a retry must ask again
    throw err;
  }));

  loadBlock(q('alerts'), 480, async (el) => {
    const config = await getAlertsConfig({ signal });
    await ensure().catch(() => {}); // history failing must not hide the form; its own block reports it
    drawAlerts(el, config, rows, signal);
  });

  loadBlock(q('history'), 200, async (el) => {
    await ensure();
    drawHistory(el, rows, () => more, () => loadRows(rows.at(-1).id));
  });
}

function plantHtml(status) {
  const b = status.battery ?? {};
  const src = (k) => t(`settings.source.${b.source?.[k] ?? 'none'}`);
  const row = (label, value, source) => `<div class="settings-fact"><dt>${esc(label)}</dt><dd><span class="num">${esc(value ?? t('core.unknown'))}</span>${source ? `<span class="hint">${esc(source)}</span>` : ''}</dd></div>`;
  const s = status.station ?? {};
  const c = status.collector;
  const bf = c?.backfill;
  const lastError = c?.lastError == null ? null : String(c.lastError.message ?? c.lastError);
  return `<dl class="settings-facts">
      ${row(t('settings.plant.name'), status.plantName ?? s.name)}
      ${row(t('settings.plant.capacity'), s.capacity == null ? null : `${nf(2).format(s.capacity)} kWp`)}
      ${row(t('settings.plant.timeZone'), status.timeZone ?? s.timeZone)}
      ${row(t('settings.plant.batteryKwh'), b.capacityKwh == null ? null : `${nf(1).format(b.capacityKwh)} kWh`, src('capacityKwh'))}
      ${row(t('settings.plant.minPct'), b.minPct == null ? null : pct(b.minPct), src('minPct'))}
      ${row(t('settings.plant.reservePct'), b.reservePct == null ? null : pct(b.reservePct), src('reservePct'))}
      ${row(t('settings.plant.maxCharge'), b.maxChargeKw == null ? null : kw(b.maxChargeKw), src('maxChargeKw'))}
      ${row(t('settings.plant.maxDischarge'), b.maxDischargeKw == null ? null : kw(b.maxDischargeKw), src('maxDischargeKw'))}
      ${row(t('settings.plant.prices'), t(status.pricesConfigured ? 'settings.plant.pricesSet' : 'settings.plant.pricesMissing'))}
    </dl>
    <h3 class="card-title">${esc(t('settings.collector.title'))}</h3>
    ${c ? `<dl class="settings-facts">
      ${row(t('settings.collector.lastTick'), c.lastTick == null ? null : fmtDateTime(c.lastTick))}
      ${row(t('settings.collector.lastError'), lastError ?? t('settings.collector.noError'))}
      ${row(t('settings.collector.backfill'), bf && bf.done < bf.total ? t('settings.collector.backfillValue', { done: bf.done, total: bf.total }) : t('settings.collector.backfillDone'))}
      ${row(t('settings.collector.auth'), t(authKey(c), { when: fmtTime(c.authBlockedUntil) }))}
    </dl>` : `<p class="hint">${esc(t('settings.collector.off'))}</p>`}
    <details class="disclosure settings-admin"><summary><span>${esc(t('settings.admin.title'))}</span>${icon('chevron-down', { size: 16 })}</summary>
      ${['intro', 'prices', 'battery', 'email', 'collect'].map((k) => `<p class="hint">${esc(t(`settings.admin.${k}`))}</p>`).join('')}</details>`;
}

function appearanceHtml() {
  const cur = getTheme();
  return `<div class="settings-appearance">
    <div class="field"><span class="field-label" id="settings-theme-l">${esc(t('settings.appearance.theme'))}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="settings-theme-l">${THEMES.map((m) =>
    `<label><input type="radio" name="theme" value="${m}"${m === cur ? ' checked' : ''}>${esc(t(`core.theme.${m}`))}</label>`).join('')}</div></div>
    <div class="field"><label for="settings-lang">${esc(t('settings.appearance.lang'))}</label>
      <select id="settings-lang">${Object.entries(LANGS).map(([c, l]) => `<option value="${c}"${c === getLang() ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div></div>`;
}

const glossaryHtml = () => `<dl class="settings-glossary">${t('settings.glossary').map(([term, text]) => `<div><dt>${esc(term)}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>`;

function sentenceText(rule) {
  return t(`settings.rule.${rule.id}`, rule.params);
}

function ruleHtml(rule, fired) {
  const inputs = new Map(ruleSentenceParts(rule).map((p) => [p.name, p]));
  const label = esc(sentenceText(rule));
  const sentence = splitSentence(ruleTemplate(rule)).map((p) => {
    if (p.text) return esc(p.text);
    const i = inputs.get(p.input);
    if (!i) return '';
    return i.type === 'time'
      ? `<input class="input settings-inline settings-time" type="time" data-field="${i.path}" value="${esc(rule.params[i.name])}" aria-label="${label}">`
      : `<input class="input settings-inline" type="number" inputmode="numeric" data-field="${i.path}" min="${i.min}" max="${i.max}" value="${esc(rule.params[i.name] ?? '')}" aria-label="${label}">`;
  }).join('');
  const f = (name) => `rules.${rule.id}.${name}`;
  const box = (name, text) => `<label class="settings-check"><input type="checkbox" data-field="${f(name)}"${rule[name] ? ' checked' : ''}>${esc(text)}</label>`;
  return `<div class="settings-rule">
    <input type="checkbox" class="switch" data-field="${f('enabled')}"${rule.enabled ? ' checked' : ''} aria-label="${esc(t('settings.rule.enabled'))}: ${label}">
    <div class="settings-rule-body">
      <p class="settings-sentence">${sentence}</p>
      <p class="hint">${esc(fired ? t('settings.rule.lastFired', { when: fmtDateTime(fired) }) : t('settings.rule.never'))}</p>
      <details class="disclosure"><summary><span>${esc(t('settings.rule.more'))}</span>${icon('chevron-down', { size: 16 })}</summary>
        <div class="settings-more">${box('bypassQuiet', t('settings.rule.bypassQuiet'))}${box('notifyResolved', t('settings.rule.notifyResolved'))}
          <div class="field"><label for="rep-${rule.id}">${esc(t('settings.rule.repeatHours'))}</label>
            <input id="rep-${rule.id}" class="settings-inline" type="number" min="0" max="720" data-field="${f('repeatHours')}" value="${esc(rule.repeatHours)}"></div></div></details>
    </div></div>`;
}

function drawAlerts(el, config, rows, signal) {
  let cfg = structuredClone(config);
  let saved = config.recipients.length;
  const smtp = config.smtp;
  const fired = lastFired(rows);

  const read = () => {
    el.querySelectorAll('[data-field]').forEach((i) => {
      const v = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value.trim();
      setField(cfg, i.dataset.field, v);
    });
    cfg.recipients = cfg.recipients.filter((r) => r);
  };

  const draw = () => {
    const mails = cfg.recipients.length ? cfg.recipients : [];
    const why = !smtp.configured ? t('settings.test.noSmtp') : !saved ? t('settings.test.noAddress') : '';
    el.innerHTML = `<form class="settings-form" novalidate>
      <p class="hint">${esc(t('settings.alerts.lead'))}</p>
      <div class="settings-rules">${cfg.rules.map((r) => ruleHtml(r, fired[r.id])).join('')}</div>
      <p class="hint settings-limit">${icon('info', { size: 16 })}<span>${esc(t('settings.alerts.limit'))}</span></p>
      <h3 class="card-title">${esc(t('settings.recipients.title'))}</h3>
      ${mails.length ? '' : `<p class="hint">${esc(t('settings.recipients.none'))}</p>`}
      <div class="settings-mails">${mails.map((m, i) => `<div class="settings-mail">
        <input class="input" type="email" autocomplete="email" data-field="recipients.${i}" value="${esc(m)}" aria-label="${esc(t('settings.recipients.email', { n: i + 1 }))}">
        <button type="button" class="pill pill-outline pill-icon" data-remove="${i}" aria-label="${esc(t('settings.recipients.remove', { n: i + 1 }))}">${icon('x')}</button></div>`).join('')}</div>
      <button type="button" class="pill pill-outline" data-add>${esc(t('settings.recipients.add'))}</button>
      <div class="field settings-narrow"><label for="settings-mail-lang">${esc(t('settings.lang.label'))}</label>
        <select id="settings-mail-lang" data-field="lang">${Object.entries(LANGS).map(([c, l]) => `<option value="${c}"${c === cfg.lang ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <h3 class="card-title">${esc(t('settings.quiet.title'))}</h3>
      <p class="hint">${esc(t('settings.quiet.hint'))}</p>
      <div class="settings-quiet">${['from', 'to'].map((k) => `<div class="field"><label for="settings-q-${k}">${esc(t(`settings.quiet.${k}`))}</label>
        <input id="settings-q-${k}" type="time" data-field="quiet.${k}" value="${esc(cfg.quiet[k])}"></div>`).join('')}</div>
      <div class="settings-errors" role="alert" hidden></div>
      <div class="settings-actions"><button type="submit" class="pill pill-primary">${esc(t('settings.save'))}</button>
        <span class="hint" role="status" data-save></span></div>
      <div class="settings-actions"><button type="button" class="pill pill-outline" data-test${why ? ' disabled aria-describedby="settings-test-out"' : ''}>${icon('mail', { size: 16 })}${esc(t('settings.test.button'))}</button>
        <span class="hint" id="settings-test-out" role="status" data-test-out>${esc(why)}</span></div>
    </form>`;
  };

  const showErrors = (fields) => {
    const form = el.querySelector('.settings-errors');
    const loose = [];
    for (const e of fieldErrorsByInput(fields)) {
      const input = el.querySelector(`[data-field="${e.path}"]`);
      if (!input) {
        loose.push(e.message);
        continue;
      }
      input.setAttribute('aria-invalid', 'true');
      (input.closest('.settings-rule-body, .settings-mail, .field, .settings-quiet') ?? input.parentElement).insertAdjacentHTML('beforeend', errorLine(e.message));
    }
    el.querySelector('[data-save]').textContent = t('settings.saveFailed');
    if (loose.length) {
      form.hidden = false;
      form.innerHTML = `<p>${esc(t('settings.formErrors'))}</p>${loose.map(errorLine).join('')}`;
    }
  };

  el.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    const rm = e.target.closest('[data-remove]');
    if (add || rm) {
      read();
      if (add) cfg.recipients.push('');
      else cfg.recipients.splice(Number(rm.dataset.remove), 1);
      draw();
      if (add) el.querySelector(`[data-field="recipients.${cfg.recipients.length - 1}"]`).focus();
      return;
    }
    const test = e.target.closest('[data-test]');
    if (!test) return;
    const out = el.querySelector('[data-test-out]');
    test.disabled = true;
    out.textContent = t('settings.test.sending');
    try {
      const r = await sendTestEmail(undefined, { signal });
      out.textContent = r.ok ? t('settings.test.sent') : t('settings.test.failed', { error: r.error });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      out.textContent = t('settings.test.failed', { error: err.body?.fields?.to ? errorText(err.body.fields.to) : err.message });
    }
    test.disabled = false;
  });

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    read();
    draw(); // blank addresses are gone, so error indexes match the rows
    const status = el.querySelector('[data-save]');
    const btn = el.querySelector('[type="submit"]');
    btn.disabled = true;
    status.textContent = t('settings.saving');
    const { smtp: _smtp, ...body } = cfg;
    try {
      cfg = structuredClone(await putAlertsConfig(body, { signal }));
      saved = cfg.recipients.length;
      draw();
      el.querySelector('[data-save]').textContent = t('settings.saved');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      btn.disabled = false;
      if (err instanceof ApiError && err.body?.fields) showErrors(err.body.fields);
      else status.textContent = t('settings.saveError', { error: err.message });
    }
  });

  draw();
}

function drawHistory(el, rows, hasMore, loadMore) {
  const item = (r) => {
    const w = deliveryWords(r);
    const text = t(w.key) === w.key ? t(w.fallback) : t(w.key);
    return `<li class="settings-history-row"><div><p class="settings-history-title">${esc(r.title ?? r.rule)}</p>
      <p class="hint">${esc(fmtDateTime(r.ts))}, ${esc(text)}${w.detail ? `: ${esc(w.detail)}` : ''}</p></div></li>`;
  };
  const draw = () => {
    el.innerHTML = `<h3 class="card-title">${esc(t('settings.history.title'))}</h3>
      ${rows.length ? `<ul class="settings-history">${rows.map(item).join('')}</ul>` : emptyState({ title: t('settings.history.none') })}
      ${hasMore() && rows.length ? `<button type="button" class="pill pill-outline" data-more>${esc(t('settings.history.more'))}</button>` : ''}`;
  };
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-more]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t('settings.history.loading');
    try {
      await loadMore();
      draw();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      btn.disabled = false;
      btn.textContent = t('settings.history.more');
    }
  });
  draw();
}
