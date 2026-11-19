// Bills view: upload and queue, 24-month coverage, list; #/invoices?id=N is the detail (plain words, comparison, review).
import { register, t, getLang } from '../i18n.js';
import dict from '../i18n/invoices.js';
import { esc, icon, badge, emptyState, moneyTabs, loadBlock, every } from '../ui.js';
import { ensureAiNotice } from '../privacy.js';
import { uploadFiles } from '../upload.js';
import {
  getInvoices, getInvoice, getUploads, createInvoice, saveInvoice, resolveInvoice, retryInvoice, deleteInvoice, fileUrl,
  getBillingInvoice,
} from '../api.js';
import { fmtDate, fmtMonth, fmtMonthShort, eur, nf, kwh } from '../format.js';
import {
  fieldGroups, stateLabel, parseField, fieldText, sumText, queueState, uploadErrorKey, ofMonth, missingText, plainWords,
} from './invoices-model.js';

register(dict);

const BADGE = { auto: ['auto', 'ok'], confirmed: ['confirmed', 'ok'], warnings: ['warnings', 'warn'], review: ['review', 'warn'], duplicate: ['duplicate', 'warn'] };
const badgeHtml = (b) => badge(t(`invoices.badge.${BADGE[b]?.[0] ?? 'review'}`), BADGE[b]?.[1] ?? 'warn');
const period = (inv) => (inv.period_from && inv.period_to ? `${fmtDate(inv.period_from, { day: 'numeric', month: 'short', year: 'numeric' })} - ${fmtDate(inv.period_to, { day: 'numeric', month: 'short', year: 'numeric' })}` : t('invoices.noPeriod'));
const go = (hash) => { location.hash = hash; };
const wide = () => globalThis.matchMedia?.('(min-width: 1024px)').matches;

export async function render(root, ctx) {
  const id = ctx.params.get('id');
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('invoices.title'))}</h1></header>${moneyTabs('invoices', ctx.params)}
    <div class="invoices-body"></div>`;
  const body = root.querySelector('.invoices-body');
  return id ? detail(body, ctx, id) : list(body, ctx);
}

// ---------- list: upload, queue, coverage ----------

async function list(body, ctx) {
  const { signal } = ctx;
  const aiOn = Boolean(ctx.status?.ai?.enabled);
  body.innerHTML = `<section class="card invoices-drop" aria-labelledby="inv-drop">
      <h2 class="card-title" id="inv-drop">${esc(t('invoices.drop.title'))}</h2>
      <p class="hint">${esc(t(aiOn ? 'invoices.drop.hint' : 'invoices.drop.hintOff'))}</p>
      <div class="invoices-pick">
        <label class="pill pill-primary">${icon('upload', { size: 16 })}${esc(t('invoices.drop.files'))}
          <input class="sr-only" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" data-files></label>
        <label class="pill pill-outline">${icon('camera', { size: 16 })}${esc(t('invoices.drop.photo'))}
          <input class="sr-only" type="file" accept="image/*" capture="environment" data-photo></label>
        <button type="button" class="pill pill-outline" data-manual>${esc(t('invoices.manual'))}</button>
      </div>
      <label class="invoices-check"><input type="checkbox" data-one> <span>${esc(t('invoices.drop.onePerPhoto'))}</span></label>
      <p class="hint" data-drop-note role="status"></p>
    </section>
    <div data-block="queue" aria-live="polite"></div>
    <div class="card" data-block="coverage"></div>
    <div class="card" data-block="bills"></div>`;
  const q = (n) => body.querySelector(`[data-block="${n}"]`);
  const note = body.querySelector('[data-drop-note]');
  const drop = body.querySelector('.invoices-drop');
  let data = { invoices: [], coverage: [], missing: [] };
  let uploads = [];
  let local = []; // upload errors of this visit: [{ name, key }]
  let sending = false;
  let timer = null;

  const monthOf = (invId) => data.invoices.find((i) => i.id === invId)?.month ?? null;
  const active = () => sending || uploads.some((u) => ['queued', 'processing'].includes(u.status));

  function paintQueue() {
    const rows = uploads.map((u) => {
      const s = queueState({ ...u, badge: data.invoices.find((i) => i.id === u.invoiceId)?.badge });
      const names = u.files.map((x) => x.name || t('invoices.q.unnamed')).join(', ');
      const month = s.duplicate && monthOf(u.duplicateOf) ? ` ${t('invoices.q.have', { month: ofMonth(monthOf(u.duplicateOf), getLang()) })}` : '';
      return `<li class="invoices-q invoices-q-${s.kind}"><span class="invoices-q-name">${esc(names)}</span>
        <span class="invoices-q-state">${badge(t(s.key), s.kind === 'ok' ? 'ok' : s.kind === 'alarm' ? 'alarm' : s.kind === 'warn' ? 'warn' : s.kind === 'busy' ? 'ongoing' : '')}${esc(month)}</span>
        <span class="invoices-q-actions">${u.invoiceId ? `<a class="pill pill-outline" href="#/invoices?id=${u.invoiceId}">${esc(t('invoices.open'))}</a>` : ''}
        ${s.retry ? `<button type="button" class="pill pill-outline" data-retry-group="${esc(u.groupId)}">${icon('refresh-cw', { size: 16 })}${esc(t('core.retry'))}</button>` : ''}
        ${s.manual ? `<button type="button" class="pill pill-outline" data-manual-group="${esc(u.groupId)}">${esc(t('invoices.fillByHand'))}</button>` : ''}</span></li>`;
    });
    const errs = local.map((e) => `<li class="invoices-q invoices-q-alarm"><span class="invoices-q-name">${esc(e.name || t('invoices.q.unnamed'))}</span>
      <span class="invoices-q-state">${badge(t('invoices.q.error'), 'alarm')} ${esc(t(e.key))}</span></li>`);
    q('queue').innerHTML = rows.length || errs.length
      ? `<section class="card"><h2 class="card-title">${esc(t('invoices.queue'))}</h2><ul class="invoices-queue" role="list">${errs.join('')}${rows.join('')}</ul></section>` : '';
  }

  function paintCoverage() {
    const cells = data.coverage.map((c) => `<li class="invoices-cell invoices-cell-${c.state}">
        <span class="invoices-cell-box" aria-hidden="true"></span><span class="invoices-cell-label" aria-hidden="true">${esc(fmtMonthShort(c.month))}</span>
        <span class="sr-only">${esc(fmtMonth(c.month))}: ${esc(t(`invoices.cell.${c.state}`))}</span></li>`).join('');
    const missing = data.missing.length ? t('invoices.missing', { months: missingText(data.missing, getLang()) }) : data.invoices.length ? t('invoices.complete') : '';
    q('coverage').innerHTML = `<h2 class="card-title">${esc(t('invoices.coverage'))}</h2>
      <ul class="invoices-cells" role="list">${cells}</ul>
      <p class="invoices-legend hint"><span class="invoices-key invoices-cell-ok"></span>${esc(t('invoices.cell.ok'))}
        <span class="invoices-key invoices-cell-review"></span>${esc(t('invoices.cell.review'))}
        <span class="invoices-key invoices-cell-missing"></span>${esc(t('invoices.cell.missing'))}</p>
      ${missing ? `<p class="invoices-missing">${esc(missing)}</p>` : ''}`;
  }

  function paintBills() {
    const rows = data.invoices.filter((i) => !i.superseded_by).map((i) => `<li><a class="invoices-row" href="#/invoices?id=${i.id}">
        <span class="invoices-row-main"><strong>${esc(i.month ? fmtMonth(i.month) : period(i))}</strong><span class="hint">${esc(i.supplier ?? '')}${i.month ? ` · ${esc(period(i))}` : ''}</span></span>
        <span class="num invoices-row-total">${esc(eur(i.total_eur))}</span>${badgeHtml(i.badge)}</a></li>`).join('');
    q('bills').innerHTML = `<h2 class="card-title">${esc(t('invoices.list'))}</h2>${rows ? `<ul class="invoices-list" role="list">${rows}</ul>`
      : emptyState({ title: t('invoices.empty'), body: t(aiOn ? 'invoices.emptyBody' : 'invoices.emptyBodyOff') })}`;
  }

  async function refresh() {
    [data, uploads] = await Promise.all([getInvoices({ signal }), getUploads({ signal })]);
    paintQueue();
    paintCoverage();
    paintBills();
  }

  // Polls while something is queued or processing; the interval stops with the view (signal).
  timer = every(2000, () => { if (active() && !sending) refresh().catch(() => {}); }, signal);

  async function send(files) {
    if (!files.length) return;
    if (aiOn && !(await ensureAiNotice())) { // declined: nothing leaves the server, the bill is typed by hand
      const made = await createInvoice(null, { signal });
      return go(`#/invoices?id=${made.id}`);
    }
    sending = true;
    local = [];
    note.textContent = t('invoices.sending', { n: files.length });
    try {
      const results = await uploadFiles(files, { onePerPhoto: body.querySelector('[data-one]').checked, signal });
      for (const g of results) {
        for (const f of g.files) if (f.status === 'error') local.push({ name: f.name, key: uploadErrorKey(f.error) });
        if (g.error && !['ai_disabled', 'rate_limited', 'budget'].includes(g.error)) local.push({ name: g.files[0]?.name, key: uploadErrorKey(g.error) });
      }
      note.textContent = '';
    } catch (err) {
      if (err?.name === 'AbortError') return;
      note.textContent = t('invoices.err.other');
    } finally {
      sending = false;
    }
    await refresh().catch(() => {});
  }

  body.querySelector('[data-files]').addEventListener('change', (e) => { send([...e.target.files]); e.target.value = ''; });
  body.querySelector('[data-photo]').addEventListener('change', (e) => { send([...e.target.files]); e.target.value = ''; });
  body.querySelector('[data-manual]').addEventListener('click', async () => go(`#/invoices?id=${(await createInvoice(null, { signal })).id}`));
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('invoices-over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('invoices-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); send([...(e.dataTransfer?.files ?? [])]); });
  q('queue').addEventListener('click', async (e) => {
    const retry = e.target.closest('[data-retry-group]')?.dataset.retryGroup;
    const manual = e.target.closest('[data-manual-group]')?.dataset.manualGroup;
    try {
      if (retry) {
        await retryInvoice(retry, { signal });
        await refresh();
      } else if (manual) {
        go(`#/invoices?id=${(await createInvoice(manual, { signal })).id}`);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') note.textContent = t(uploadErrorKey(err?.body?.error, err?.status));
    }
  });

  await loadBlock(q('bills'), 160, refresh);
  return () => clearInterval(timer);
}

// ---------- detail ----------

async function detail(body, ctx, id) {
  const { signal } = ctx;
  const lang = getLang();
  const aiOn = Boolean(ctx.status?.ai?.enabled);
  const num = (n) => nf(2).format(n);
  body.innerHTML = '<a class="link" href="#/invoices">' + esc(t('invoices.back')) + '</a><div data-block="detail"></div>';
  await loadBlock(body.querySelector('[data-block="detail"]'), 400, async (el) => {
    let d = await getInvoice(id, { signal });
    const compare = await getBillingInvoice(id, { signal }).catch(() => null);
    const paint = () => { el.innerHTML = view(d, compare); wire(); };

    function comparison(inv, c) {
      if (!c || !inv.period_from || !inv.period_to) return '';
      if (c.verdict === 'nodata') {
        return `<section class="card"><h2 class="card-title">${esc(t('invoices.cmp.title'))}</h2><p>${esc(t('invoices.cmp.nodata', { n: Math.max(c.days - c.daysWithData, 0) }))}</p></section>`;
      }
      const row = (label, billed, measured, fmt) => `<tr><th scope="row">${esc(label)}</th><td class="num">${esc(fmt(billed))}</td><td class="num">${esc(fmt(measured))}</td></tr>`;
      return `<section class="card"><h2 class="card-title">${esc(t('invoices.cmp.title'))}</h2>
        <p class="invoices-verdict">${badge(t(`invoices.cmp.${c.verdict}`), c.verdict === 'ok' ? 'ok' : 'warn')}</p>
        <div class="table-scroll"><table class="table"><thead><tr><th></th><th class="num">${esc(t('invoices.cmp.bill'))}</th><th class="num">${esc(t('invoices.cmp.measured'))}</th></tr></thead><tbody>
          ${row(t('invoices.cmp.bought'), c.kwh.billed.total, c.kwh.measured?.total, kwh)}
          ${c.surplus.billed != null ? row(t('invoices.cmp.sold'), c.surplus.billed, c.surplus.measured, kwh) : ''}</tbody></table></div>
        <p class="hint">${esc(t('invoices.cmp.caveat'))}</p></section>`;
    }

    function field(fd, inv, states, checks, errors) {
      const col = fd.col;
      const st = states[col] ?? 'unverified';
      const label = `${t(`invoices.col.${col}`)}${fd.unit ? ` (${t(`invoices.unit.${fd.unit}`)})` : ''}`;
      const value = fieldText(col, inv[col], lang);
      const input = fd.type === 'kind'
        ? `<select id="f-${col}" data-col="${col}">${['normal', 'rectifying', 'credit'].map((k) => `<option value="${k}"${inv.kind === k ? ' selected' : ''}>${esc(t(`invoices.kind.${k}`))}</option>`).join('')}</select>`
        : fd.type === 'bool'
          ? `<select id="f-${col}" data-col="${col}">${[['', 'unknown'], ['yes', 'yes'], ['no', 'no']].map(([v, k]) => `<option value="${v}"${value === v ? ' selected' : ''}>${esc(t(`invoices.bool.${k}`))}</option>`).join('')}</select>`
          : `<input id="f-${col}" data-col="${col}" value="${esc(value)}"${fd.type === 'date' ? ' type="date"' : fd.type === 'text' ? ' type="text"' : ' type="text" inputmode="decimal" autocomplete="off"'}${errors[col] ? ' aria-invalid="true"' : ''}>`;
      let why = '';
      if (st === 'suspect') {
        const bad = checks.find((c) => c.outcome === 'fail' && c.fields.includes(col));
        why = bad ? sumText(bad, num, lang) : t('invoices.check.unreadable');
      }
      return `<div class="field invoices-field invoices-state-${st}"><label for="f-${col}">${esc(label)}</label>${input}
        <span class="invoices-state">${esc(t(stateLabel(st)))}${why ? ` ${esc(why)}` : ''}</span>
        ${errors[col] ? `<span class="field-error" role="alert">${esc(t(`invoices.err.field.${errors[col]}`))}</span>` : ''}</div>`;
    }

    let errors = {};
    let message = '';
    let forceable = false;
    function view(dd, c) {
      const { invoice: inv, lines, readings, checks, states, files } = dd;
      const words = plainWords(inv, lang);
      const hardFail = checks.some((x) => x.hard && x.outcome === 'fail');
      const dup = inv.status === 'draft' && inv.duplicate_of;
      const groups = fieldGroups().map((g) => {
        if (g.id === 'readings') {
          return readings.length ? `<fieldset class="invoices-group"><legend>${esc(t('invoices.group.readings'))}</legend><div class="table-scroll"><table class="table"><tbody>
            ${readings.map((r) => `<tr><th scope="row">${esc(t(`invoices.reading.${r.kind}`))} ${esc(r.period.toUpperCase())}</th><td>${esc(fmtDate(r.from_date))} - ${esc(fmtDate(r.to_date))}</td><td class="num">${esc(r.start_kwh ?? '')} - ${esc(r.end_kwh ?? '')}</td></tr>`).join('')}
            </tbody></table></div></fieldset>` : '';
        }
        return `<fieldset class="invoices-group"><legend>${esc(t(`invoices.group.${g.id}`))}</legend>${g.fields.map((fd) => field(fd, inv, states, checks, errors)).join('')}
          ${g.id === 'data' ? `<p class="hint">${esc(t('invoices.cups'))} ${esc(inv.cups_masked ?? t('core.unknown'))}</p>` : ''}</fieldset>`;
      }).join('');
      const orig = files.length ? files.map((fl) => {
        const url = fileUrl(fl.id);
        const frame = fl.kind === 'pdf' ? `<iframe class="invoices-frame" src="${esc(url)}" title="${esc(t('invoices.original'))}"></iframe>` : `<img class="invoices-frame" src="${esc(url)}" alt="${esc(t('invoices.original'))}">`;
        return `${wide() ? frame : ''}<a class="pill pill-outline invoices-open" href="${esc(url)}" target="_blank" rel="noopener">${icon('file-text', { size: 16 })}${esc(t('invoices.openOriginal'))}</a>`;
      }).join('') : `<p class="hint">${esc(t('invoices.noOriginal'))}</p>`;
      return `<header class="invoices-detail-head"><h2 class="section-title">${esc(inv.period_from ? period(inv) : t('invoices.manualTitle'))}</h2>${badgeHtml(inv.badge)}</header>
        ${dup ? `<section class="card invoices-dup" role="status"><p>${esc(t('invoices.dup.body'))}</p><div class="actions">
          <button type="button" class="pill pill-outline" data-resolve="discard">${esc(t('invoices.dup.discard'))}</button>
          <button type="button" class="pill pill-outline" data-resolve="replace">${esc(t('invoices.dup.replace'))}</button>
          <button type="button" class="pill pill-outline" data-resolve="keep">${esc(t('invoices.dup.keep'))}</button></div></section>` : ''}
        ${inv.period_from ? `<section class="card"><h2 class="card-title">${esc(t('invoices.plain.title'))}</h2>
          <ul class="invoices-plain">${words.parts.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul>
          <p class="invoices-plain-total">${esc(t('invoices.plain.total', { eur: eur(inv.total_eur) }))}</p></section>` : ''}
        ${comparison(inv, c)}
        <section class="invoices-review" data-tab="data">
          <nav class="segmented invoices-tabs" aria-label="${esc(t('invoices.title'))}">
            <button type="button" data-tab-btn="data" aria-pressed="true">${esc(t('invoices.tab.data'))}</button>
            <button type="button" data-tab-btn="orig" aria-pressed="false">${esc(t('invoices.tab.orig'))}</button></nav>
          <form class="card invoices-form" data-panel="data" novalidate>
            ${groups}
            <label class="invoices-check"><input type="checkbox" data-nonumber${inv.invoice_number === '' ? ' checked' : ''}> <span>${esc(t('invoices.noNumber'))}</span></label>
            <p class="field-error" role="alert"${message ? '' : ' hidden'}><span>${esc(message)}</span></p>
            <div class="actions">
              <button type="submit" class="pill pill-outline" data-act="save">${esc(t('invoices.save'))}</button>
              <button type="submit" class="pill pill-primary" data-act="confirm">${esc(inv.status === 'confirmed' ? t('invoices.confirmed') : t('invoices.confirm'))}</button>
              ${forceable || hardFail ? `<button type="submit" class="pill pill-outline" data-act="force">${esc(t('invoices.force'))}</button>` : ''}
            </div></form>
          <div class="card invoices-orig" data-panel="orig">${orig}</div>
        </section>
        ${lines.length ? `<details class="disclosure card"><summary><span>${esc(t('invoices.lines'))}</span>${icon('chevron-down', { size: 16 })}</summary>
          <div class="table-scroll"><table class="table"><thead><tr><th>${esc(t('invoices.lines.concept'))}</th><th class="num">${esc(t('invoices.lines.qty'))}</th><th class="num">${esc(t('invoices.lines.price'))}</th><th class="num">${esc(t('invoices.lines.amount'))}</th></tr></thead><tbody>
          ${lines.map((l) => `<tr><td>${esc(l.concept)}</td><td class="num">${esc(l.quantity ?? '')} ${esc(l.unit ?? '')}</td><td class="num">${esc(l.unit_price ?? '')}</td><td class="num">${esc(l.amount_eur != null ? eur(l.amount_eur) : '')}</td></tr>`).join('')}
          </tbody></table></div></details>` : ''}
        <div class="actions invoices-foot">
          ${aiOn ? `<a class="pill pill-outline" href="#/assistant?q=${encodeURIComponent(t('invoices.askQuestion'))}&invoice=${inv.id}">${esc(t('invoices.ask'))}</a>` : ''}
          <button type="button" class="pill pill-outline" data-delete>${icon('trash-2', { size: 16 })}${esc(t('invoices.delete'))}</button></div>`;
    }

    // '' is the saved "no number" marker; the bool column is stored as 0/1
    const same = (old, v) => (v == null ? old == null || old === '' : old === v || (typeof v === 'boolean' && old === Number(v)));
    function collect() {
      const fields = {};
      errors = {};
      for (const input of el.querySelectorAll('[data-col]')) {
        const col = input.dataset.col;
        const r = parseField(col, input.value);
        if (r.error) errors[col] = r.error;
        else if (!same(d.invoice[col], r.value)) fields[col] = r.value;
      }
      return fields;
    }

    async function submit(act) {
      const fields = collect();
      message = '';
      if (Object.keys(errors).length) { message = t('invoices.err.fix'); return paint(); }
      try {
        d = await saveInvoice(id, fields, { confirm: act !== 'save', force: act === 'force', noNumber: el.querySelector('[data-nonumber]').checked }, { signal });
        forceable = false;
        message = '';
      } catch (err) {
        if (err?.name === 'AbortError') return;
        const code = err?.body?.error;
        if (err.status === 400 && code === 'invalid') {
          errors = Object.fromEntries(Object.entries(err.body.fields ?? {}).map(([c, m]) => [c, m === 'required' ? 'required' : 'bad']));
          message = t('invoices.err.fix');
        } else if (err.status === 409 && code === 'checks_failed') {
          forceable = true;
          message = t('invoices.err.checks');
        } else message = t('invoices.err.other');
      }
      paint();
    }

    function wire() {
      const review = el.querySelector('.invoices-review');
      for (const b of el.querySelectorAll('[data-tab-btn]')) {
        b.addEventListener('click', () => {
          review.dataset.tab = b.dataset.tabBtn;
          el.querySelectorAll('[data-tab-btn]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        });
      }
      el.querySelector('.invoices-form').addEventListener('submit', (e) => { e.preventDefault(); submit(e.submitter?.dataset.act ?? 'save'); });
      for (const b of el.querySelectorAll('[data-resolve]')) {
        b.addEventListener('click', async () => {
          try {
            const r = await resolveInvoice(id, b.dataset.resolve, { signal });
            if (r) { d = r; paint(); } else go('#/invoices');
          } catch (err) {
            if (err?.name === 'AbortError') return;
            message = t(err?.status === 400 || err?.status === 409 ? 'invoices.err.checks' : 'invoices.err.other');
            paint();
          }
        });
      }
      el.querySelector('[data-delete]').addEventListener('click', () => confirmDelete());
    }

    function confirmDelete() {
      const dialog = document.createElement('dialog');
      dialog.className = 'sheet';
      dialog.setAttribute('aria-labelledby', 'inv-del');
      dialog.innerHTML = `<h2 id="inv-del" class="view-title">${esc(t('invoices.deleteTitle'))}</h2><p>${esc(t('invoices.deleteBody'))}</p>
        <div class="actions"><button type="button" class="pill pill-primary" data-yes>${esc(t('invoices.delete'))}</button>
        <button type="button" class="pill pill-outline" data-no>${esc(t('invoices.cancel'))}</button></div>`;
      dialog.addEventListener('click', async (e) => {
        if (e.target.closest('[data-no]')) dialog.close();
        if (e.target.closest('[data-yes]')) {
          try {
            await deleteInvoice(id, { signal });
            dialog.close();
            go('#/invoices');
          } catch { dialog.close(); message = t('invoices.err.other'); paint(); }
        }
      });
      dialog.addEventListener('close', () => dialog.remove());
      document.body.append(dialog);
      dialog.showModal();
    }

    paint();
  });
}
