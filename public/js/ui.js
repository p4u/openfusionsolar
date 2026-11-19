// Shared markup builders (they return HTML strings; every value is escaped) and small DOM helpers.
import { t } from './i18n.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Line icon from the sprite. Decorative unless a label is given.
export function icon(name, { size = 20, label } = {}) {
  const use = `<use href="/icons.svg#${esc(name)}"/>`;
  return label
    ? `<svg class="icon icon-${size}" role="img"><title>${esc(label)}</title>${use}</svg>`
    : `<svg class="icon icon-${size}" aria-hidden="true">${use}</svg>`;
}

// Placeholder with the final height, so nothing jumps when the data arrives.
export const skeleton = (height) =>
  `<div class="skeleton" style="height:${Number(height) || 0}px"><span class="sr-only">${esc(t('core.loading'))}</span></div>`;

// action: { label, href } (a link) or { label, id } (a button the caller wires up).
export function emptyState({ title, body, action } = {}) {
  const act = !action ? '' : action.href
    ? `<a class="pill pill-outline" href="${esc(action.href)}">${esc(action.label)}</a>`
    : `<button type="button" class="pill pill-outline" id="${esc(action.id ?? '')}">${esc(action.label)}</button>`;
  return `<div class="empty"><span class="orb orb-lavender" aria-hidden="true"></span>
    <p class="empty-title">${esc(title ?? t('core.empty.title'))}</p>
    ${body ? `<p class="empty-body">${esc(body)}</p>` : ''}${act}</div>`;
}

// The retry button carries data-retry; loadBlock wires it, other callers do it themselves.
export const errorState = (message = t('core.error.load')) => `<div class="error" role="alert">
    ${icon('circle-alert', { size: 24 })}
    <div class="error-text"><p class="error-title">${esc(message)}</p><p>${esc(t('core.error.nothingLost'))}</p></div>
    <button type="button" class="pill pill-outline" data-retry>${icon('refresh-cw', { size: 16 })}${esc(t('core.retry'))}</button>
  </div>`;

// kind: provisional | ongoing | ok | warn | alarm (status kinds add a coloured dot)
export const badge = (text, kind = '') => `<span class="badge${kind ? ` badge-${esc(kind)}` : ''}">${esc(text)}</span>`;

// Tiles in one card divided by hairlines. delta: a string or format.delta() output; status: ok | warn | alarm.
export function ledger(tiles) {
  const tile = ({ icon: name, label, value, hint, delta, status, title }) => `<div class="tile"${title ? ` title="${esc(title)}"` : ''}>
      <dt class="tile-label">${name ? icon(name, { size: 16 }) : ''}<span>${esc(label)}</span></dt>
      <dd class="tile-value">${status ? `<span class="status-dot status-${esc(status)}" aria-hidden="true"></span>` : ''}${esc(value ?? t('core.unknown'))}</dd>
      ${delta != null ? `<dd class="tile-delta">${esc(typeof delta === 'string' ? delta : delta.text)}</dd>` : ''}
      ${hint ? `<dd class="tile-hint">${esc(hint)}</dd>` : ''}
    </div>`;
  return `<dl class="ledger" style="--cols:${ledgerColumns(tiles.length, 5)};--cols-md:${ledgerColumns(tiles.length, 4)}">${tiles.map(tile).join('')}</dl>`;
}

// Columns that fill every row of the card when they can (9 tiles: 3 by 3, not 5 and 4 with a hole), at most `max`.
export function ledgerColumns(n, max) {
  if (n <= max) return Math.max(n, 1);
  const options = Array.from({ length: max - 2 }, (_, i) => max - i); // max down to 3
  return options.find((c) => n % c === 0) ?? options.reduce((a, c) => (n % c > n % a ? c : a));
}

const STATES = {
  ok: ['circle-check', 'mint'],
  info: ['info', 'sky'],
  warn: ['triangle-alert', 'peach'],
  alarm: ['circle-alert', 'rose'],
  waiting: ['clock', 'lavender'],
};

// The headline that answers "do I need to act?": icon plus words; the orb hue is decoration only.
// link: { href, label } shown after the details.
export function statusLine({ state = 'ok', title, details = [], link = null }) {
  const [name, hue] = STATES[state] ?? STATES.info;
  return `<div class="status-line status-${esc(state)}" role="status">
    <span class="orb orb-${hue}" aria-hidden="true"></span>
    ${icon(name, { size: 24 })}
    <div class="status-text"><p class="headline">${esc(title)}</p>
    ${[].concat(details).filter(Boolean).map((d) => `<p class="status-detail">${esc(d)}</p>`).join('')}
    ${link ? `<p class="status-detail"><a class="link" href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}</div>
  </div>`;
}

// Skeleton while fn runs; on failure an error with a retry that runs fn again. fn fills el itself.
export async function loadBlock(el, height, fn) {
  el.innerHTML = skeleton(height);
  el.setAttribute('aria-busy', 'true');
  try {
    await fn(el);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    el.innerHTML = errorState();
    el.querySelector('[data-retry]').addEventListener('click', () => loadBlock(el, height, fn), { once: true });
  } finally {
    el.removeAttribute('aria-busy');
  }
}

// setInterval that stops when the signal aborts (the view was left).
export function every(ms, fn, signal) {
  const id = setInterval(fn, ms);
  signal?.addEventListener('abort', () => clearInterval(id), { once: true });
  return id;
}

// Theme: 'light' | 'dark' saved in localStorage; absent means follow the device ('system').
export function getTheme() {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(mode) {
  const root = document.documentElement;
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem('theme', mode);
    else localStorage.removeItem('theme');
  } catch { /* still applied to this page */ }
  const fixed = mode === 'light' || mode === 'dark';
  if (fixed) root.dataset.theme = mode;
  else delete root.dataset.theme;
  document.dispatchEvent(new CustomEvent('themechange', { detail: { mode: fixed ? mode : 'system' } }));
}
