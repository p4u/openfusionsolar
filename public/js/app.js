// Shell: hash router, navigation, theme and language. Each view is a module with
// `export async function render(root, ctx)` that may return a cleanup function, loaded on demand.
import { LANGS, register, t, translate, getLang, setLang } from './i18n.js';
import core from './i18n/core.js';
import { getStatus, logout } from './api.js';
import { setTimeZone } from './format.js';
import { esc, errorState, getTheme, setTheme, skeleton, overlay } from './ui.js';
import { watchViewport } from './viewport.js';
import { ENTRY_MODES, installEntry, offerBanner, watchInstall } from './install.js';
import { resetLegends } from './charts.js';
import { ROUTES, PATHS, CARRIED, RANGED, IN_SHEET, PARENT } from './routes.js';

register(core);

const STATUS_MS = 60e3;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const main = $('#main');
const sheet = $('#more-sheet');
const menu = $('#more-menu');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

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
    if (route === name || route === PARENT[name]) a.setAttribute('aria-current', 'page');
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
  updateAsk();
}

// the Ask button exists only while the assistant is on (re-evaluated on every status refresh)
function updateAsk() {
  $('#ask-btn').hidden = !status?.ai?.enabled;
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
  const changed = current != null && current.name !== name;
  if (current?.name !== name) resetLegends(); // hidden legend series do not follow the user to another view
  const me = { name, controller: new AbortController(), cleanup: null };
  current = me;
  const { signal } = me.controller;
  updateNav(name, params);
  // set at once from the route, so the tab title never names the previous view while this one loads
  document.title = `${t(`core.nav.${name}`)} – ${plantName()}`;
  // a fresh root per render: a slow, superseded render writes into a detached node
  const root = document.createElement('div');
  root.className = `view view-${name}`;
  const swap = () => main.replaceChildren(root);
  // a cross-fade between views only; the root is in the page before the view draws into it (charts measure it)
  if (changed && document.startViewTransition && !reducedMotion.matches) {
    await document.startViewTransition(swap).updateCallbackDone.catch(() => {});
    if (signal.aborted) return;
  } else swap();
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

// the install row shows only where installing is possible and not done yet
function updateInstall() {
  const show = ENTRY_MODES.includes(installEntry().mode);
  for (const b of $$('[data-action="install"]')) b.hidden = !show;
}

function wireShell() {
  overlay(sheet);
  overlay(menu); // pushes its history entry on the popover's toggle event
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'theme') setTheme(isDark() ? 'light' : 'dark');
    else if (action === 'lang') setLang(nextLang());
    else if (action === 'sheet') overlay(sheet).open();
    else if (action === 'install') {
      closeOverlays();
      installEntry().run();
    }
    else if (action === 'close-sheet') sheet.close();
    else if (action === 'logout') {
      el.disabled = true;
      try {
        await logout();
        await globalThis.caches?.delete('ofs-data'); // the last status copy (sw.js) leaves with the session
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
  document.addEventListener('installchange', updateInstall);
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
  offerBanner({ today: status.today });
  setInterval(() => refreshStatus().catch((err) => console.error(err)), STATUS_MS);
}

// Installable app: the worker keeps the shell and the last status offline (sw.js). A new version waits until the
// user accepts it in a toast, so a reload never happens in the middle of reading a page.
function registerWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  let accepted = false;
  const offer = (worker) => {
    if (!worker || !navigator.serviceWorker.controller || $('.toast')) return; // first install: nothing to update
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `<span>${esc(t('core.update.available'))}</span>
      <button type="button" class="pill pill-primary">${esc(t('core.update.action'))}</button>`;
    toast.querySelector('button').addEventListener('click', () => {
      accepted = true;
      worker.postMessage('skipWaiting');
    }, { once: true });
    document.body.append(toast);
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (accepted) location.reload();
  });
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => worker.state === 'installed' && offer(worker));
    });
    // an installed app can stay open for days: look for a new version when it comes back to the foreground
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {}));
  }).catch((err) => console.error(err));
}

watchViewport();
watchInstall();
translate();
updateActions();
wireShell();
updateInstall();
boot();
registerWorker();
