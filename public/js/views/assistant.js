// Assistant view: a chat about the bills and the installation. The server streams steps (status, chart, figure,
// choice, sources, invoice, text, done, error); preset charts are drawn by reference with the Facturació presets,
// figures from the data the server resolved; attached bills go through the bills upload (source 'chat').
// #/assistant?c=ID opens a conversation; ?q=...&invoice=ID prefills without sending. The view is a column as tall as
// the visible viewport (assistant.css): the thread scrolls inside it and the composer is its last child.
import { register, t, getLang } from '../i18n.js';
import dict from '../i18n/assistant.js';
import invoicesDict from '../i18n/invoices.js';
import { esc, icon, badge, emptyState, statusLine, loadBlock, confirmDialog, overlay } from '../ui.js';
import { ensureAiNotice } from '../privacy.js';
import { uploadFiles, groupFiles } from '../upload.js';
import { ApiError, chatStream, getConversations, getConversation, deleteConversation, getAiUsage, getInvoice } from '../api.js';
import { renderPreset, drawModel } from '../chart-presets.js';
import { fmtDate, fmtDateTime, eur } from '../format.js';
import { renderSafe, blocksToView, ndjsonError, statusKey, prefill, answered, figureModel, MAX_TEXT, MAX_ATTACHMENTS } from './assistant-model.js';
import { uploadErrorKey } from './invoices-model.js';

register(dict);
register(invoicesDict); // upload error messages

const DAY = { day: 'numeric', month: 'short', year: 'numeric' };
const periodText = (p) => (p?.from && p?.to ? `${fmtDate(p.from, DAY)} - ${fmtDate(p.to, DAY)}` : null);
const head = () => `<header class="view-head"><h1 class="view-title">${esc(t('assistant.title'))}</h1></header>`;
const idOf = (v) => (/^[1-9]\d{0,15}$/.test(v ?? '') ? Number(v) : null);

const invoiceCard = (b) => {
  const ok = b.status === 'confirmed';
  return `<div class="assistant-invoice">${icon('receipt', { size: 20 })}
    <div class="assistant-invoice-body"><p class="assistant-invoice-title">${esc(periodText(b.period) ?? t('assistant.invoice.noPeriod'))}</p>
      <p class="assistant-invoice-meta"><span class="num">${esc(eur(b.total))}</span>${badge(t(`assistant.invoice.${ok ? 'confirmed' : 'draft'}`), ok ? 'ok' : 'warn')}</p></div>
    <a class="pill pill-outline" href="#/invoices?id=${Number(b.id)}">${esc(t('assistant.invoice.review'))}</a></div>`;
};

export async function render(root, ctx) {
  const { signal } = ctx;
  if (!ctx.status?.ai?.enabled) {
    root.innerHTML = `${head()}${emptyState({ title: t('assistant.off.title'), body: t('assistant.off.body'), action: { label: t('assistant.off.action'), href: '#/invoices' } })}`;
    return null;
  }

  let convId = idOf(ctx.params.get('c'));
  const pre = prefill(ctx.params);
  let invoiceId = pre.invoiceId;
  let files = [];
  let busy = null; // the AbortController of the turn in flight
  let known = null; // ids in the last painted list
  let epoch = 0; // bumped when the thread starts over, so a turn that ends late does not adopt a conversation
  const charts = [];

  const listBox = `<div data-list></div>`;
  root.innerHTML = `<div class="assistant">
    <aside class="assistant-side" aria-labelledby="as-side-h"><h2 class="card-title" id="as-side-h">${esc(t('assistant.conversations'))}</h2>${listBox}</aside>
    <section class="assistant-main">
      <header class="view-head"><h1 class="view-title">${esc(t('assistant.title'))}</h1>
        <div class="assistant-head-actions">
          <button type="button" class="pill pill-outline assistant-list-btn" data-open-list aria-haspopup="dialog">${icon('message-circle', { size: 16 })}${esc(t('assistant.conversations'))}</button>
          <a class="pill pill-outline" href="#/assistant" data-new>${esc(t('assistant.new'))}</a></div></header>
      <div data-banner></div>
      <div class="assistant-thread" data-thread></div>
      <p class="assistant-status" role="status" data-status></p>
      <p class="sr-only" aria-live="polite" data-live></p>
      <form class="assistant-composer" data-form novalidate>
        <div class="assistant-context" data-context hidden></div>
        <ul class="assistant-files" role="list" data-files hidden></ul>
        <p class="field-error" role="alert" data-error hidden>${icon('circle-alert', { size: 16 })}<span></span></p>
        <div class="assistant-row">
          <label class="icon-btn assistant-attach" title="${esc(t('assistant.attach'))}">${icon('paperclip', { label: t('assistant.attach') })}
            <input class="sr-only" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" data-pick></label>
          <label class="sr-only" for="as-input">${esc(t('assistant.input'))}</label>
          <textarea id="as-input" class="assistant-input" rows="1" maxlength="${MAX_TEXT}" enterkeyhint="send" autocomplete="off"
            placeholder="${esc(t('assistant.placeholder'))}" aria-describedby="as-keys as-count"></textarea>
          <button type="button" class="icon-btn assistant-send" data-send></button>
        </div>
        <p class="assistant-foot"><span id="as-keys">${esc(t('assistant.keys'))}</span><span id="as-count" data-count></span></p>
      </form>
    </section>
    <dialog class="sheet assistant-sheet" aria-labelledby="as-sheet-h"><span class="sheet-handle" aria-hidden="true"></span>
      <h2 class="card-title" id="as-sheet-h">${esc(t('assistant.conversations'))}</h2>${listBox}
      <button type="button" class="pill pill-outline sheet-close" data-close-list>${esc(t('assistant.close'))}</button></dialog>
  </div>`;
  const $ = (sel) => root.querySelector(sel);
  const thread = $('[data-thread]');
  const input = $('#as-input');
  const sendBtn = $('[data-send]');
  const sheet = $('.assistant-sheet');
  const statusEl = $('[data-status]');
  const errorEl = $('[data-error]');

  // ---------- composer ----------
  const fit = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    $('[data-count]').textContent = t('assistant.counter', { n: input.value.length, max: MAX_TEXT });
  };
  const showError = (text) => {
    errorEl.hidden = !text;
    errorEl.querySelector('span').textContent = text ?? '';
  };
  const setBusy = (ctl) => {
    busy = ctl;
    const label = t(ctl ? 'assistant.stop' : 'assistant.send');
    sendBtn.innerHTML = icon(ctl ? 'x' : 'send', { size: 20 });
    sendBtn.setAttribute('aria-label', label);
    sendBtn.title = label;
    sendBtn.classList.toggle('assistant-stop', Boolean(ctl));
  };
  const setStatus = (tool) => {
    statusEl.innerHTML = tool ? `<span class="assistant-dot" aria-hidden="true"></span>${esc(t(statusKey(tool)))}` : '';
  };

  function paintFiles() {
    const list = $('[data-files]');
    list.hidden = !files.length;
    list.innerHTML = files.map((f, i) => `<li class="assistant-file">${icon('file-text', { size: 16 })}<span>${esc(f.name)}</span>
      <button type="button" class="icon-btn" data-unpick="${i}" aria-label="${esc(t('assistant.removeFile', { name: f.name }))}">${icon('x', { size: 16 })}</button></li>`).join('');
  }

  async function paintContext() {
    const box = $('[data-context]');
    box.hidden = invoiceId == null;
    if (invoiceId == null) return;
    let label = t('assistant.contextAny');
    try {
      const d = await getInvoice(invoiceId, { signal });
      const p = periodText({ from: d.invoice.period_from, to: d.invoice.period_to });
      if (p) label = t('assistant.context', { period: p });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (err instanceof ApiError && err.status === 404) { // gone: the server would refuse the question
        invoiceId = null;
        box.hidden = true;
        return;
      }
    }
    box.innerHTML = `${icon('receipt', { size: 16 })}<span>${esc(label)}</span>
      <button type="button" class="icon-btn" data-unctx aria-label="${esc(t('assistant.contextRemove'))}" title="${esc(t('assistant.contextRemove'))}">${icon('x', { size: 16 })}</button>`;
  }

  // ---------- thread ----------
  const intro = () => `<div class="assistant-intro" data-intro><p class="assistant-lead">${esc(t('assistant.lead'))}</p>
    <p class="hint assistant-privacy">${esc(t('assistant.privacy'))} <a class="link" href="#/settings?card=ai">${esc(t('assistant.privacyLink'))}</a></p>
    <h2 class="card-title">${esc(t('assistant.suggest.title'))}</h2>
    <ul class="assistant-suggest" role="list">${t('assistant.suggest').map((s, i) => `<li><button type="button" class="assistant-chip" data-suggest="${i}">${esc(s)}</button></li>`).join('')}</ul></div>`;

  function addMessage(role) {
    $('[data-intro]')?.remove();
    const el = document.createElement('div');
    el.className = `assistant-msg assistant-msg-${role === 'user' ? 'user' : 'bot'}`;
    el.innerHTML = `<p class="sr-only">${esc(t(role === 'user' ? 'assistant.you' : 'assistant.bot'))}:</p>`;
    thread.append(el);
    return el;
  }

  // Options of an ask_user question: each sends its text as the next question; "something else" goes to the input.
  function choiceGroup(item) {
    const el = document.createElement('div');
    el.className = 'assistant-choice';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', t('assistant.choice.label'));
    for (const option of item.options) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'assistant-chip', textContent: option, disabled: Boolean(item.answered) });
      b.addEventListener('click', () => send(option));
      el.append(b);
    }
    const other = Object.assign(document.createElement('button'), { type: 'button', className: 'assistant-chip assistant-chip-other', textContent: t('assistant.choice.other'), disabled: Boolean(item.answered) });
    other.addEventListener('click', () => input.focus());
    el.append(other);
    return el;
  }

  // Pages the server read or found this turn: https links only (assistant-model), text set as text.
  function sourceList(item) {
    const el = document.createElement('div');
    el.className = 'assistant-sources';
    el.innerHTML = `<p class="assistant-sources-title">${icon('book-open', { size: 16 })}<span>${esc(t('assistant.sources'))}</span></p><ul role="list"></ul>`;
    for (const s of item.items) {
      const li = document.createElement('li');
      const a = Object.assign(document.createElement('a'), { className: 'link', href: s.url, rel: 'noopener noreferrer', target: '_blank', textContent: s.title });
      a.append(Object.assign(document.createElement('span'), { className: 'sr-only', textContent: ` ${t('assistant.newTab')}` }));
      li.append(a, Object.assign(document.createElement('span'), { className: 'assistant-source-host', textContent: s.host }));
      el.querySelector('ul').append(li);
    }
    return el;
  }

  function addItem(msg, item) {
    let el;
    if (item.kind === 'question') {
      el = document.createElement('p');
      el.className = 'assistant-q';
      el.textContent = item.text;
    } else if (item.kind === 'text') {
      el = document.createElement('div');
      el.className = 'assistant-text';
      el.innerHTML = item.html;
    } else if (item.kind === 'chart') {
      el = document.createElement('div');
      el.className = 'assistant-chart';
      msg.append(el);
      charts.push(renderPreset(el, item.chart, { signal }));
      return el;
    } else if (item.kind === 'figure') {
      el = document.createElement('div');
      el.className = 'assistant-chart';
      msg.append(el);
      charts.push(drawModel(el, figureModel(item.figure)));
      return el;
    } else if (item.kind === 'choice') {
      el = choiceGroup(item);
    } else if (item.kind === 'sources') {
      el = sourceList(item);
    } else if (item.kind === 'invoice') {
      el = document.createElement('div');
      el.innerHTML = invoiceCard(item);
      el = el.firstElementChild;
    } else return null;
    msg.append(el);
    return el;
  }

  const note = (msg, text, cls = 'assistant-note') => {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    msg.append(p);
    return p;
  };

  function paintMessages(messages) {
    const done = answered(messages);
    messages.forEach((m, i) => {
      const view = blocksToView(m);
      if (!view.items.length) return;
      const el = addMessage(view.role);
      for (const item of view.items) addItem(el, item.kind === 'choice' ? { ...item, answered: done.has(i) } : item);
    });
  }

  function resetThread() {
    epoch++;
    charts.splice(0).forEach((c) => c.destroy());
    thread.innerHTML = intro();
  }

  // ---------- conversations ----------
  async function paintList() {
    const convs = await getConversations({ signal });
    const html = convs.length
      ? `<ul class="assistant-convs" role="list">${convs.map((c) => {
        const title = c.title || t('assistant.untitled');
        return `<li class="assistant-conv"><a href="#/assistant?c=${Number(c.id)}"${c.id === convId ? ' aria-current="page"' : ''}>
          <span class="assistant-conv-title">${esc(title)}</span><span class="assistant-conv-when">${esc(fmtDateTime(c.updated_at))}</span></a>
          <button type="button" class="icon-btn" data-del="${Number(c.id)}" aria-label="${esc(t('assistant.deleteOne', { title }))}" title="${esc(t('assistant.deleteOne', { title }))}">${icon('trash-2', { size: 16 })}</button></li>`;
      }).join('')}</ul>`
      : `<p class="hint">${esc(t('assistant.noConversations'))}</p>`;
    root.querySelectorAll('[data-list]').forEach((el) => { el.innerHTML = html; });
    known = new Set(convs.map((c) => c.id));
    return convs;
  }
  const refreshList = () => paintList().catch((err) => { if (err?.name !== 'AbortError') console.error(err); });

  function showBudget() {
    $('[data-banner]').innerHTML = statusLine({ state: 'warn', title: t('assistant.budget.title'), details: [t('assistant.budget.body')] });
  }

  // ---------- one turn ----------
  async function send(raw) {
    const text = String(raw ?? '').trim().slice(0, MAX_TEXT);
    if (busy) return;
    if (!text) {
      input.focus();
      return;
    }
    showError(null);
    if (!(await ensureAiNotice())) {
      showError(t('assistant.declined'));
      return;
    }
    // a question sent (tapped or typed) answers any open choice
    thread.querySelectorAll('.assistant-choice button').forEach((b) => { b.disabled = true; });
    const ctl = new AbortController();
    const leave = () => ctl.abort();
    signal.addEventListener('abort', leave, { once: true });
    setBusy(ctl);
    const lang = getLang();
    const before = known;
    const mine = epoch;
    let finished = false;
    const picked = files;
    files = [];
    paintFiles();
    input.value = '';
    fit();
    if (convId == null) history.replaceState(history.state, '', '#/assistant'); // the prefill is used: a re-render must not repeat it

    const asked = addMessage('user');
    addItem(asked, { kind: 'question', text });
    if (picked.length) note(asked, t('assistant.attached', { names: picked.map((f) => f.name).join(', ') }), 'assistant-attached');
    const bot = addMessage('bot');
    bot.setAttribute('aria-busy', 'true');
    asked.scrollIntoView({ block: 'nearest' });

    const fail = (message) => {
      note(bot, message, 'assistant-error').setAttribute('role', 'alert');
    };
    try {
      let attachments = [];
      if (picked.length) {
        setStatus('uploading');
        const results = await uploadFiles(picked, { source: 'chat', signal: ctl.signal });
        for (const g of results) {
          for (const f of g.files) if (f.status === 'error') fail(`${f.name}: ${t(uploadErrorKey(f.error))}`);
          if (g.files.every((f) => f.status === 'ok')) attachments.push(g.groupId);
          if (g.error === 'budget') showBudget();
        }
        attachments = attachments.slice(0, MAX_ATTACHMENTS);
      }
      setStatus('thinking');
      await chatStream({ text, lang, conversationId: convId ?? undefined, invoiceId: invoiceId ?? undefined, attachments: attachments.length ? attachments : undefined }, {
        signal: ctl.signal,
        onEvent: (ev) => {
          if (ev?.type === 'status') setStatus(ev.tool);
          else if (ev?.type === 'error') {
            finished = true;
            fail(ndjsonError(ev.code, lang));
            if (ev.code === 'budget') showBudget();
          } else if (ev?.type === 'done') {
            finished = true;
            if (convId == null && Number.isInteger(ev.conversationId)) {
              convId = ev.conversationId;
              history.replaceState(history.state, '', `#/assistant?c=${convId}`);
            }
          } else {
            for (const item of blocksToView({ role: 'assistant', blocks: [ev] }).items) addItem(bot, item)?.scrollIntoView({ block: 'nearest' });
            if (ev?.type === 'text') $('[data-live]').textContent = String(ev.text).replace(/\*\*/g, '');
          }
        },
      });
      if (!finished) fail(ndjsonError('internal', lang)); // the stream ended without done or error
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (!signal.aborted) fail(ndjsonError('stopped', lang));
      } else if (err instanceof ApiError) {
        const code = err.body?.error;
        fail(ndjsonError(code, lang, { retryAfter: err.body?.retryAfter }));
        if (code === 'budget') showBudget();
      } else {
        console.error(err);
        fail(ndjsonError(err instanceof TypeError || globalThis.navigator?.onLine === false ? 'offline' : 'internal', lang));
      }
    } finally {
      signal.removeEventListener('abort', leave);
      if (!signal.aborted) {
        setBusy(null);
        setStatus(null);
        bot.removeAttribute('aria-busy');
        if (bot.children.length <= 1) bot.remove(); // only its label: nothing came back
        const convs = await paintList().catch(() => null);
        // a failed first turn still created its conversation on the server: keep asking in it
        if (convId == null && mine === epoch && before && convs?.[0] && !before.has(convs[0].id)) {
          convId = convs[0].id;
          history.replaceState(history.state, '', `#/assistant?c=${convId}`);
          await refreshList();
        }
      }
    }
  }

  // ---------- wiring ----------
  sendBtn.addEventListener('click', () => (busy ? busy.abort() : send(input.value)));
  $('[data-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!busy) send(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (!busy) send(input.value);
  });
  input.addEventListener('input', fit);
  $('[data-pick]').addEventListener('change', (e) => {
    const next = [...files, ...e.target.files];
    e.target.value = '';
    if (groupFiles(next).length > MAX_ATTACHMENTS || next.length > groupFiles(next).flat().length) {
      showError(t('assistant.tooManyFiles', { max: MAX_ATTACHMENTS }));
      return;
    }
    showError(null);
    files = next;
    paintFiles();
  });
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-unpick], [data-unctx], [data-suggest], [data-del], [data-open-list], [data-close-list], [data-new]');
    if (!el) return;
    if (el.dataset.unpick != null) {
      files.splice(Number(el.dataset.unpick), 1);
      paintFiles();
      input.focus();
    } else if (el.dataset.unctx != null) {
      invoiceId = null;
      $('[data-context]').hidden = true;
      input.focus();
    } else if (el.dataset.suggest != null) {
      send(t('assistant.suggest')[Number(el.dataset.suggest)]);
    } else if (el.dataset.openList != null) {
      overlay(sheet).open();
    } else if (el.dataset.closeList != null) {
      sheet.close();
    } else if (el.dataset.new != null && location.hash === '#/assistant') {
      e.preventDefault(); // already here (a new conversation not saved yet): start over without a reload
      if (busy) busy.abort();
      resetThread();
      input.focus();
    } else if (el.dataset.del != null) {
      const id = Number(el.dataset.del);
      if (sheet.open) sheet.close();
      const yes = await confirmDialog({ title: t('assistant.deleteTitle'), body: t('assistant.deleteBody'), yes: t('assistant.delete'), no: t('assistant.cancel') });
      if (!yes) return;
      try {
        await deleteConversation(id, { signal });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (!(err instanceof ApiError && err.status === 404)) return showError(t('assistant.err.internal'));
      }
      if (id === convId) location.hash = '#/assistant';
      else refreshList();
    }
  });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

  // the keyboard shrinks the column (--vvh): keep the end of the last message in sight (viewport.js emits this)
  const toEnd = () => { thread.scrollTop = thread.scrollHeight; };
  document.addEventListener('keyboardopen', toEnd);
  let stick = null;

  // ---------- first paint ----------
  setBusy(null);
  input.value = pre.text;
  fit();
  paintContext();
  refreshList();
  getAiUsage({ signal }).then((u) => { if (u?.budgetUsd > 0 && u.spentUsd >= u.budgetUsd) showBudget(); }).catch(() => {});
  if (convId == null) resetThread();
  else {
    await loadBlock(thread, 240, async (el) => {
      try {
        const conv = await getConversation(convId, { signal });
        el.replaceChildren();
        paintMessages(conv.messages);
        if (!el.children.length) resetThread();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        convId = null;
        history.replaceState(history.state, '', '#/assistant');
        resetThread();
        $('[data-intro]').insertAdjacentHTML('afterbegin', `<p class="hint">${esc(t('assistant.notFound'))}</p>`);
      }
    });
    // the end of the conversation, so an unanswered choice is in view; charts draw after this and grow the thread,
    // so the end stays in view until the user scrolls it
    toEnd();
    if (globalThis.ResizeObserver) {
      stick = new ResizeObserver(toEnd);
      for (const m of thread.children) stick.observe(m);
      for (const type of ['pointerdown', 'wheel', 'keydown']) thread.addEventListener(type, () => stick.disconnect(), { once: true, passive: true });
    }
  }
  if (pre.text) input.focus({ preventScroll: true });

  return () => {
    busy?.abort();
    charts.splice(0).forEach((c) => c.destroy());
    document.removeEventListener('keyboardopen', toEnd);
    stick?.disconnect();
  };
}
