// Installing the app. installMode and showBanner are pure; the rest keeps the browser's install prompt and
// shows the steps on browsers that have none.
import { t } from './i18n.js';
import { esc, icon, overlay } from './ui.js';

// the modes that show the "Install the app" entry; 'installed' and 'hidden' do not
export const ENTRY_MODES = ['prompt', 'ios', 'firefox-android', 'manual'];

export function installMode({ hasPrompt, ua = '', maxTouchPoints = 0, standalone }) {
  if (standalone) return 'installed';
  if (hasPrompt) return 'prompt';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios'; // iPadOS says Macintosh
  if (/Android/.test(ua) && /Firefox/.test(ua)) return 'firefox-android';
  if (/Android|Mobi/.test(ua)) return 'manual';
  return 'hidden';
}

// today and firstDay are 'YYYY-MM-DD'; the banner waits for the second day the app is opened
export const showBanner = ({ mode, today, firstDay, dismissed, route, toast }) =>
  ENTRY_MODES.includes(mode) && !dismissed && Boolean(firstDay) && today > firstDay && route !== 'login' && !toast;

const STEPS = { ios: 'core.install.ios', 'firefox-android': 'core.install.firefox', manual: 'core.install.manual' };
let deferred = null; // the kept beforeinstallprompt event
let installed = false; // appinstalled fired in this tab, which itself stays a browser tab

const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch { /* asked again next time */ }
};
const changed = () => document.dispatchEvent(new CustomEvent('installchange'));

// Called once at load. Emits 'installchange' on document when the mode may have changed.
export function watchInstall() {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    changed();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    write('install.dismissed', '1');
    document.querySelector('.install-banner')?.remove();
    changed();
  });
}

export function installEntry() {
  const standalone = installed || navigator.standalone === true
    || matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: fullscreen)').matches;
  const mode = installMode({ hasPrompt: Boolean(deferred), ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone });
  return { mode, run: () => run(mode) };
}

function run(mode) {
  if (mode === 'prompt' && deferred) {
    const e = deferred;
    deferred = null; // an event prompts once
    e.prompt()?.catch?.(() => {}); // called in the tap itself: the browser requires the gesture
    changed();
  } else if (STEPS[mode]) {
    showSteps(mode);
  }
}

function showSteps(mode) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.setAttribute('aria-labelledby', 'install-title');
  dialog.innerHTML = `<span class="sheet-handle" aria-hidden="true"></span>
    <h2 id="install-title" class="view-title">${esc(t('core.install.action'))}</h2>
    <p>${esc(t(STEPS[mode]))}</p>
    <button type="button" class="pill pill-outline sheet-close" data-close>${esc(t('core.close'))}</button>`;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  overlay(dialog).open();
}

// Once per load, after the first status (today is the plant's day). Records the first day the app was opened.
export function offerBanner({ today }) {
  const firstDay = read('install.firstDay');
  if (!firstDay && today) write('install.firstDay', today);
  const show = showBanner({
    mode: installEntry().mode,
    today,
    firstDay,
    dismissed: read('install.dismissed') === '1',
    route: location.pathname === '/login' ? 'login' : 'app',
    toast: Boolean(document.querySelector('.toast')),
  });
  if (!show || document.querySelector('.install-banner')) return;
  const el = document.createElement('aside');
  el.className = 'install-banner';
  el.innerHTML = `${icon('download')}<span class="install-banner-text">${esc(t('core.install.banner'))}</span>
    <button type="button" class="pill pill-primary" data-install>${esc(t('core.install.short'))}</button>
    <button type="button" class="icon-btn" data-close aria-label="${esc(t('core.close'))}" title="${esc(t('core.close'))}">${icon('x')}</button>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-install]')) {
      el.remove();
      installEntry().run(); // read again: the browser's prompt may have arrived after the banner
    } else if (e.target.closest('[data-close]')) {
      write('install.dismissed', '1');
      el.remove();
    }
  });
  document.body.append(el);
}
