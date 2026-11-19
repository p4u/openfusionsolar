// Shell: hash router, navigation, theme and language. Each view is a module with
// `export async function render(root, ctx)` that may return a cleanup function, loaded on demand.
import { LANGS, register, t, translate, getLang, setLang } from './i18n.js';
import core from './i18n/core.js';
import { getStatus, logout } from './api.js';
import { setTimeZone } from './format.js';
import { errorState, getTheme, setTheme, skeleton } from './ui.js';

register(core);

// hash path to view module; Bill keeps the #/money URL
const ROUTES = { '': 'now', energy: 'energy', battery: 'battery', panels: 'panels', money: 'bill', incidents: 'incidents', signals: 'signals', settings: 'settings' };
const PATHS = Object.fromEntries(Object.entries(ROUTES).map(([path, name]) => [name, path]));
const CARRIED = ['r', 'd', 'from', 'to', 'cmp', 'b']; // the time range follows the user across these views
const RANGED = new Set(['energy', 'battery', 'panels', 'bill', 'incidents', 'signals']);
const IN_SHEET = new Set(['panels', 'bill', 'signals', 'settings']);
const STATUS_MS = 60e3;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const main = $('#main');
const sheet = $('#more-sheet');
const menu = $('#more-menu');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

let status = null;
let current = null; // { name, controller, cleanup }

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('?');
  return { path: i < 0 ? raw : raw.slice(0, i), params: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
}

const hashFor = (path, params) => {
  const query = params.toString();
  return `#/${path}${query ? `?${query}` : ''}`;
};

// Merge a patch into the hash query (null deletes a key); the hashchange re-renders the view.
function setParams(patch, { replace = false } = {}) {
  const { path, params } = parseHash();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) params.delete(k);
    else params.set(k, String(v));
  }
  const hash = hashFor(path, params);
  if (hash === location.hash) return;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function updateNav(name, params) {
  const carried = new URLSearchParams(CARRIED.filter((k) => params.has(k)).map((k) => [k, params.get(k)]));
  for (const a of $$('a[data-route]')) {
    const route = a.dataset.route;
    a.href = hashFor(PATHS[route], RANGED.has(route) ? carried : new URLSearchParams());
    if (route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('.tab[data-action="sheet"]').classList.toggle('is-current', IN_SHEET.has(name));
}

function plantName() {
  return status?.plantName || status?.station?.name || t('core.appName');
}

function updatePlant() {
  const el = $('#plant-name');
  el.textContent = plantName();
  el.title = plantName();
}

const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : darkQuery.matches);

// Theme and language buttons show what they will switch to.
function updateActions() {
  const dark = isDark();
  const themeLabel = t(dark ? 'core.theme.toLight' : 'core.theme.toDark');
  const next = nextLang();
  const langLabel = t('core.lang.switchTo', { name: LANGS[next].name });
  for (const b of $$('[data-action="theme"]')) {
    b.querySelector('use').setAttribute('href', `/icons.svg#${dark ? 'sun-medium' : 'moon'}`);
    setLabel(b, themeLabel, themeLabel);
  }
  for (const b of $$('[data-action="lang"]')) setLabel(b, langLabel, LANGS[next].name, next);
}

function setLabel(button, label, text, lang) {
  const span = button.querySelector('.action-label');
  if (span) {
    span.textContent = text;
    if (lang) span.lang = lang;
  } else {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function nextLang() {
  const codes = Object.keys(LANGS);
  return codes[(codes.indexOf(getLang()) + 1) % codes.length];
}

async function refreshStatus() {
  status = await getStatus();
  setTimeZone(status.timeZone ?? status.station?.timeZone);
  updatePlant();
}

async function render({ focus = false } = {}) {
  const { path, params } = parseHash();
  const name = ROUTES[path];
  if (name === undefined) {
    location.replace('#/');
    return;
  }
  if (current) {
    current.controller.abort();
    try {
      current.cleanup?.();
    } catch (err) {
      console.error(err);
    }
  }
  const me = { name, controller: new AbortController(), cleanup: null };
  current = me;
  const { signal } = me.controller;
  updateNav(name, params);
  // a fresh root per render: a slow, superseded render writes into a detached node
  const root = document.createElement('div');
  root.className = `view view-${name}`;
  main.replaceChildren(root);
  if (focus) scrollTo(0, 0);
  try {
    const view = await import(`./views/${name}.js`);
    if (signal.aborted) return;
    const ctx = { status, params, setParams, signal, today: status?.today };
    const cleanup = await view.render(root, ctx);
    if (signal.aborted) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    me.cleanup = typeof cleanup === 'function' ? cleanup : null;
    const h1 = root.querySelector('h1');
    document.title = h1 ? `${h1.textContent} – ${plantName()}` : plantName();
    if (focus && h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  } catch (err) {
    if (signal.aborted || err?.name === 'AbortError') return;
    console.error(err);
    root.innerHTML = errorState(t('core.error.view'));
    root.querySelector('[data-retry]').addEventListener('click', () => render(), { once: true });
  }
}

function closeOverlays() {
  if (sheet.open) sheet.close();
  try {
    if (menu.matches(':popover-open')) menu.hidePopover();
  } catch { /* no popover support: the menu is never open */ }
}

function wireShell() {
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'theme') setTheme(isDark() ? 'light' : 'dark');
    else if (action === 'lang') setLang(nextLang());
    else if (action === 'sheet') sheet.showModal();
    else if (action === 'close-sheet') sheet.close();
    else if (action === 'logout') {
      el.disabled = true;
      try {
        await logout();
      } finally {
        location.assign('/login');
      }
    }
  });
  // a click on the backdrop (the dialog box itself, outside its content) closes the sheet
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  // the skip link must not change the hash (that is the router's)
  $('.skip-link').addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });
  window.addEventListener('hashchange', () => {
    closeOverlays();
    if (!status) return; // boot renders once the status is in
    const before = current?.name;
    render({ focus: ROUTES[parseHash().path] !== before });
  });
  document.addEventListener('langchange', () => {
    translate();
    updatePlant();
    updateActions();
    if (status) render();
  });
  document.addEventListener('themechange', updateActions);
  darkQuery.addEventListener('change', () => {
    if (getTheme() === 'system') document.dispatchEvent(new CustomEvent('themechange', { detail: { mode: 'system' } }));
  });
}

async function boot() {
  main.innerHTML = skeleton(320);
  try {
    await refreshStatus();
  } catch (err) {
    console.error(err);
    main.innerHTML = errorState(t('core.error.server'));
    main.querySelector('[data-retry]').addEventListener('click', boot, { once: true });
    return;
  }
  render();
  setInterval(() => refreshStatus().catch((err) => console.error(err)), STATUS_MS);
}

translate();
updateActions();
wireShell();
boot();
