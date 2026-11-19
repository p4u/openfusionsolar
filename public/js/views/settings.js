// Settings view: alerts (recipients and their alerts, rules, quiet hours, test email, history), plant, appearance, glossary, about.
import { register, t, getLang, setLang, LANGS } from '../i18n.js';
import dict from '../i18n/settings.js';
import { esc, icon, loadBlock, emptyState, getTheme, setTheme } from '../ui.js';
import { getAlertsConfig, putAlertsConfig, sendTestEmail, getAlertsHistory, ApiError } from '../api.js';
import { kw, nf, pct, fmtDateTime, fmtTime } from '../format.js';
import { ruleSentenceParts, ruleTemplate, splitSentence, fieldErrorsByInput, errorText, authKey, lastFired, deliveryWords, setField, validateAlerts, parseAddresses } from './settings-model.js';
import { GROUPS, DEFAULT_ON, PRESETS, presetOf } from '../alert-catalogue.js';

register(dict);

const PAGE = 50;
const THEMES = ['light', 'dark', 'system'];
const errorLine = (msg, id = '') => `<p class="field-error"${id ? ` id="${id}"` : ''}>${icon('circle-alert', { size: 16 })}<span>${esc(msg)}</span></p>`;

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

  // the header toggle changes the theme too: keep the radios in step
  const syncTheme = () => root.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === getTheme(); });
  document.addEventListener('themechange', syncTheme);
  signal?.addEventListener('abort', () => document.removeEventListener('themechange', syncTheme));

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
      <details class="disclosure" data-key="more-${rule.id}"><summary><span>${esc(t('settings.rule.more'))}</span>${icon('chevron-down', { size: 16 })}</summary>
        <div class="settings-more">${box('bypassQuiet', t('settings.rule.bypassQuiet'))}${box('notifyResolved', t('settings.rule.notifyResolved'))}
          <div class="field"><label for="rep-${rule.id}">${esc(t('settings.rule.repeatHours'))}</label>
            <input id="rep-${rule.id}" class="settings-inline" type="number" min="0" max="720" data-field="${f('repeatHours')}" value="${esc(rule.repeatHours)}"></div></div></details>
    </div></div>`;
}

const ORDER = Object.values(GROUPS).flat();
const PRESET_NAMES = [...Object.keys(PRESETS), 'custom'];

function drawAlerts(el, config, rows, signal) {
  let cfg = structuredClone(config);
  const smtp = config.smtp;
  const hidden = new Set(config.unavailable ?? []);
  const shown = (id) => !hidden.has(id);
  const ruleOf = (id) => cfg.rules.find((r) => r.id === id);
  const fired = lastFired(rows);
  const total = ORDER.filter(shown).length;
  const count = (alerts) => alerts.filter(shown).length;

  // the form holds the state: read it back into cfg before every redraw and before saving
  const read = () => {
    el.querySelectorAll('[data-field]').forEach((i) => {
      const v = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value.trim();
      setField(cfg, i.dataset.field, v);
    });
    el.querySelectorAll('[data-recipient]').forEach((box) => {
      const r = cfg.recipients[Number(box.dataset.recipient)];
      r.lang = box.querySelector('[data-rlang]').value;
      const ticked = new Set([...box.querySelectorAll('[data-alert]:checked')].map((c) => c.dataset.alert));
      // a hidden alert keeps its subscription for when it can be shown again
      r.alerts = [...ORDER.filter((id) => shown(id) && ticked.has(id)), ...r.alerts.filter((id) => !shown(id))];
    });
  };

  const alertBox = (r, i, id) => {
    const rule = ruleOf(id);
    const urgent = rule?.bypassQuiet ? `<span class="settings-urgent">${icon('zap', { size: 16 })}${esc(t('settings.urgent'))}</span>` : '';
    const off = rule && !rule.enabled ? `<span class="settings-off">${esc(t('settings.alert.offForAll'))}</span>` : '';
    return `<label class="settings-alert${off ? ' is-off' : ''}"><input type="checkbox" data-alert="${id}"${r.alerts.includes(id) ? ' checked' : ''}>
      <span class="settings-alert-text"><span class="settings-alert-name">${esc(t(`settings.alert.${id}`))}${urgent}${off}</span>
        <span class="hint">${esc(t(`settings.alert.${id}.desc`))}</span></span></label>`;
  };

  const recipientHtml = (r, i) => {
    const preset = presetOf(r.alerts);
    const testOff = smtp.configured ? '' : ' disabled aria-describedby="settings-test-why"';
    return `<li class="settings-recipient" data-recipient="${i}">
      <div class="settings-recipient-head">
        <h4 class="settings-recipient-email" tabindex="-1" data-err="recipients.${i}">${esc(r.email)}</h4>
        <div class="field settings-recipient-lang"><label for="rcp-${i}-lang">${esc(t('settings.recipients.lang'))}</label>
          <select id="rcp-${i}-lang" data-rlang data-err="recipients.${i}.lang">${Object.entries(LANGS).map(([c, l]) => `<option value="${c}"${c === r.lang ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
        <button type="button" class="pill pill-outline pill-icon" data-remove="${i}" aria-label="${esc(t('settings.recipients.remove', { email: r.email }))}">${icon('x')}</button>
      </div>
      <fieldset class="settings-presets"><legend class="field-label">${esc(t('settings.preset.label'))}</legend>
        <div class="segmented">${PRESET_NAMES.map((p) => `<label><input type="radio" name="preset-${i}" value="${p}"${p === preset ? ' checked' : ''}>${esc(t(`settings.preset.${p}`))}</label>`).join('')}</div>
      </fieldset>
      <details class="disclosure settings-choose" data-key="choose-${esc(r.email.toLowerCase())}"><summary><span data-count>${esc(t('settings.preset.choose', { n: count(r.alerts), total }))}</span>${icon('chevron-down', { size: 16 })}</summary>
        ${Object.entries(GROUPS).map(([g, ids]) => `<fieldset class="settings-group"><legend>${esc(t(`settings.group.${g}`))}</legend>
          <p class="hint">${esc(t(`settings.group.${g}Hint`))}</p>${ids.filter(shown).map((id) => alertBox(r, i, id)).join('')}</fieldset>`).join('')}
      </details>
      <div class="settings-actions"><button type="button" class="pill pill-outline" data-test="${i}" aria-label="${esc(t('settings.test.buttonFor', { email: r.email }))}"${testOff}>${icon('mail', { size: 16 })}${esc(t('settings.test.button'))}</button>
        <span class="hint" role="status" data-test-out="${i}"></span></div>
    </li>`;
  };

  const draw = () => {
    const open = new Set([...el.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
    el.innerHTML = `<form class="settings-form" novalidate>
      <p class="hint">${esc(t('settings.alerts.lead'))}</p>
      <p class="hint settings-limit">${icon('info', { size: 16 })}<span>${esc(t('settings.alerts.limit'))}</span></p>
      <h3 class="card-title">${esc(t('settings.recipients.title'))}</h3>
      ${smtp.configured ? '' : `<p class="hint settings-limit" id="settings-test-why">${icon('info', { size: 16 })}<span>${esc(t('settings.test.noSmtp'))}</span></p>`}
      <div class="field settings-add"><label for="settings-add">${esc(t('settings.recipients.addLabel'))}</label>
        <div class="settings-add-row"><input id="settings-add" class="input" type="text" inputmode="email" autocomplete="email" spellcheck="false" aria-describedby="settings-add-hint settings-add-msg">
          <button type="button" class="pill pill-outline" data-add>${esc(t('settings.recipients.add'))}</button></div>
        <p class="field-hint" id="settings-add-hint">${esc(t('settings.recipients.addHint'))}</p>
        <div id="settings-add-msg" aria-live="polite"></div></div>
      ${cfg.recipients.length ? `<ul class="settings-recipients">${cfg.recipients.map(recipientHtml).join('')}</ul>` : `<p class="hint">${esc(t('settings.recipients.none'))}</p>`}
      <div class="field settings-narrow"><label for="settings-mail-lang">${esc(t('settings.lang.label'))}</label>
        <select id="settings-mail-lang" data-field="lang">${Object.entries(LANGS).map(([c, l]) => `<option value="${c}"${c === cfg.lang ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <h3 class="card-title">${esc(t('settings.rules.title'))}</h3>
      <p class="hint">${esc(t('settings.rules.hint'))}</p>
      ${Object.entries(GROUPS).map(([g, ids]) => `<h4 class="settings-group-title">${esc(t(`settings.group.${g}`))}</h4>
        <div class="settings-rules">${ids.filter(shown).map((id) => ruleHtml(ruleOf(id), fired[id])).join('')}</div>`).join('')}
      <h3 class="card-title">${esc(t('settings.quiet.title'))}</h3>
      <p class="hint">${esc(t('settings.quiet.hint'))}</p>
      <div class="settings-quiet">${['from', 'to'].map((k) => `<div class="field"><label for="settings-q-${k}">${esc(t(`settings.quiet.${k}`))}</label>
        <input id="settings-q-${k}" type="time" data-field="quiet.${k}" value="${esc(cfg.quiet[k])}"></div>`).join('')}</div>
      <div class="settings-errors" role="alert" hidden></div>
      <div class="settings-actions"><button type="submit" class="pill pill-primary">${esc(t('settings.save'))}</button>
        <span class="hint" role="status" data-save></span></div>
    </form>`;
    el.querySelectorAll('details[data-key]').forEach((d) => { if (open.has(d.dataset.key)) d.open = true; });
  };

  const say = (lines) => {
    el.querySelector('#settings-add-msg').innerHTML = lines.map(([ok, text]) => (ok ? `<p class="hint">${esc(text)}</p>` : errorLine(text))).join('');
  };

  const addMails = () => {
    read();
    const typed = el.querySelector('#settings-add').value;
    const p = parseAddresses(typed, cfg.recipients.map((r) => r.email));
    cfg.recipients.push(...p.add.map((email) => ({ email, lang: cfg.lang, alerts: [...DEFAULT_ON] })));
    if (p.add.length) draw();
    const input = el.querySelector('#settings-add');
    const refused = [...p.invalid, ...p.full];
    input.value = refused.join(', '); // what was not added stays in the box to be fixed
    if (p.invalid.length) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    say([
      !typed.trim() && [false, t('settings.recipients.empty')],
      p.add.length && [true, t('settings.recipients.added', { n: p.add.length })],
      p.invalid.length && [false, t('settings.recipients.invalid', { list: p.invalid.join(', ') })],
      p.already.length && [false, t('settings.recipients.already', { list: p.already.join(', ') })],
      p.full.length && [false, t('settings.recipients.full', { list: p.full.join(', ') })],
    ].filter(Boolean));
    input.focus();
  };

  const showErrors = (fields) => {
    const form = el.querySelector('.settings-errors');
    const loose = [];
    let first = null;
    fieldErrorsByInput(fields).forEach((e, n) => {
      const input = el.querySelector(`[data-field="${e.path}"], [data-err="${e.path}"]`);
      if (!input) {
        loose.push(e.message);
        return;
      }
      // the message is tied to its field: read out with it, and the field is marked invalid
      const id = `settings-err-${n}`;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', id);
      (input.closest('.settings-rule-body, .settings-recipient-head, .field, .settings-quiet') ?? input.parentElement).insertAdjacentHTML('beforeend', errorLine(e.message, id));
      first ??= input;
    });
    el.querySelector('[data-save]').textContent = t('settings.saveFailed');
    if (first) {
      first.closest('details')?.setAttribute('open', '');
      first.focus();
    }
    if (loose.length) {
      form.hidden = false;
      form.innerHTML = `<p>${esc(t('settings.formErrors'))}</p>${loose.map((m) => errorLine(m)).join('')}`;
    }
  };

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'settings-add') {
      e.preventDefault(); // Enter adds the address instead of saving the form
      addMails();
    }
  });

  el.addEventListener('change', (e) => {
    // switching a rule off or making it urgent shows in every address's list
    const sw = /^rules\.\w+\.(enabled|bypassQuiet)$/.test(e.target.dataset.field ?? '') && e.target.dataset.field;
    if (sw) {
      read();
      draw();
      el.querySelector(`[data-field="${sw}"]`).focus();
      return;
    }
    const box = e.target.closest('[data-recipient]');
    if (!box) return;
    const checks = [...box.querySelectorAll('[data-alert]')];
    if (e.target.type === 'radio') {
      if (e.target.value === 'custom') box.querySelector('.settings-choose').open = true;
      else checks.forEach((c) => { c.checked = PRESETS[e.target.value].includes(c.dataset.alert); });
    }
    const r = cfg.recipients[Number(box.dataset.recipient)];
    const ids = [...checks.filter((c) => c.checked).map((c) => c.dataset.alert), ...r.alerts.filter((id) => !shown(id))];
    if (e.target.type === 'checkbox') box.querySelector(`input[type="radio"][value="${presetOf(ids)}"]`).checked = true;
    box.querySelector('[data-count]').textContent = t('settings.preset.choose', { n: count(ids), total });
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-add]')) return addMails();
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      read();
      const i = Number(rm.dataset.remove);
      const [gone] = cfg.recipients.splice(i, 1);
      draw();
      say([[true, t('settings.recipients.removed', { email: gone.email })]]);
      (el.querySelector(`[data-recipient="${Math.min(i, cfg.recipients.length - 1)}"] h4`) ?? el.querySelector('#settings-add')).focus();
      return;
    }
    const test = e.target.closest('[data-test]');
    if (!test) return;
    read();
    const r = cfg.recipients[Number(test.dataset.test)];
    const out = el.querySelector(`[data-test-out="${test.dataset.test}"]`);
    test.disabled = true;
    out.textContent = t('settings.test.sending');
    try {
      const res = await sendTestEmail(r.email, { signal }, r.lang);
      out.textContent = res.ok ? t('settings.test.sent') : t('settings.test.failed', { error: res.error });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      out.textContent = t('settings.test.failed', { error: err.body?.fields?.to ? errorText(err.body.fields.to) : err.message });
    }
    test.disabled = false;
  });

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    read();
    draw(); // clears the marks of a previous attempt
    const invalid = validateAlerts(cfg);
    if (Object.keys(invalid).length) return showErrors(invalid); // nothing is sent until every field is valid
    const status = el.querySelector('[data-save]');
    const btn = el.querySelector('[type="submit"]');
    btn.disabled = true;
    status.textContent = t('settings.saving');
    const { smtp: _smtp, unavailable: _u, ...body } = cfg;
    try {
      cfg = structuredClone(await putAlertsConfig(body, { signal }));
      draw();
      el.querySelector('[data-save]').textContent = t('settings.saved');
      el.querySelector('[type="submit"]').focus(); // the redraw replaced the button: keep the keyboard where it was
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
      <p class="hint">${esc(fmtDateTime(r.ts))}, ${esc(text)}${w.detail ? `: ${esc(w.detail)}` : ''}${r.recipients?.length ? `, ${esc(t('settings.history.to', { list: r.recipients.join(', ') }))}` : ''}</p></div></li>`;
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
