// Writes screenshots from the invented demo data set (never real household data):
//   node scripts/screenshots.js            the manifest's two (public/icons/screenshot-*.png)
//   node scripts/screenshots.js --readme   the README's (screenshots/*.png)
// Builds a fresh demo DB under ~/.cache/openfusionsolar/shots/, runs the app there (that directory has no .env, so no
// real key or account is read), drives a headless Chromium over the DevTools protocol and writes
// public/icons/screenshot-narrow.png (/, 360x640 at 3x = 1080x1920) and screenshot-wide.png (the assistant with a
// figure, 1920x1080). Chromium: $CHROME, else Playwright's cache, else chromium-browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..');
const DIR = path.join(os.homedir(), '.cache/openfusionsolar/shots');
const PORT = Number(process.env.PORT || 18097);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = path.join(os.homedir(), '.cache/ms-playwright');
  const found = (fs.existsSync(pw) ? fs.readdirSync(pw) : []).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
    .map((d) => path.join(pw, d, 'chrome-linux64/chrome')).find((p) => fs.existsSync(p));
  return found ?? 'chromium-browser';
}

async function until(fn, what, ms = 20e3) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not ready yet */ }
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A minimal DevTools protocol client on one page target.
async function devtools(port) {
  const pages = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((p) => p.type === 'page'), 'a page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method) {
      for (const w of waiters.filter((x) => x.method === m.method)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m.params);
      }
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const go = async (url) => {
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url });
    await loaded;
  };
  return { send, evaluate, go, once, close: () => ws.close() };
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const out = execFileSync(process.execPath, [path.join(REPO, 'scripts/demo-db.js'), path.join(DIR, 'demo.db')], { encoding: 'utf8' });
const demoEnv = Object.fromEntries(out.split('\n').map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const password = randomBytes(12).toString('hex');
// AI_API_KEY is a dummy so the assistant view renders: viewing a stored conversation calls no model.
const server = spawn(process.execPath, [path.join(REPO, 'src/main.js')], {
  cwd: DIR, stdio: 'ignore',
  env: { PATH: process.env.PATH, HOME: os.homedir(), ...demoEnv, APP_PASSWORD: password, AI_API_KEY: 'demo-no-calls', PORT: String(PORT), HOST: '127.0.0.1' },
});
const chrome = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(DIR, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--lang=ca', 'about:blank'], { stdio: 'ignore' });
let cdp = null;
try {
  await until(async () => (await fetch(`${BASE}/login`)).ok, 'the app');
  const port = await until(() => fs.readFileSync(path.join(DIR, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0], 'Chromium');
  cdp = await devtools(port);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.go(`${BASE}/login`);
  const status = await cdp.evaluate(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ password }))} }).then((r) => r.status)`);
  if (status >= 300) throw new Error(`login answered ${status}`);
  const convs = await cdp.evaluate("fetch('/api/assistant/conversations').then((r) => r.json())");
  const conv = convs.find((c) => c.title === 'Estalvi de la casa demo');
  if (!conv) throw new Error('the demo conversation is missing');
  for (const c of convs.filter((x) => x !== conv)) { // the list shows only the demo conversation (the other is the XSS probe)
    await cdp.evaluate(`fetch('/api/assistant/conversations/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":${Number(c.id)}}' })`);
  }

  const shot = async (url, { width, height, scale, mobile, dark = false }, file) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.go('about:blank');
    await cdp.go(url);
    await cdp.evaluate(`localStorage.setItem('theme', '${dark ? 'dark' : 'light'}')`);
    const reloaded = cdp.once('Page.loadEventFired'); // the same url again would be a hash change, with no load event
    await cdp.send('Page.reload', { ignoreCache: true });
    await reloaded;
    await sleep(3000); // data requests and chart drawing
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(path.join(REPO, file)), { recursive: true });
    fs.writeFileSync(path.join(REPO, file), Buffer.from(data, 'base64'));
    console.log(`written ${file}`);
  };
  const desktop = { width: 1440, height: 900, scale: 1, mobile: false };
  const phone = { width: 390, height: 844, scale: 2, mobile: true };
  if (process.argv.includes('--readme')) {
    await shot(`${BASE}/`, desktop, 'screenshots/now-desktop.png');
    await shot(`${BASE}/#/energy`, desktop, 'screenshots/energy-desktop.png');
    await shot(`${BASE}/#/money`, desktop, 'screenshots/billing-desktop.png');
    await shot(`${BASE}/#/assistant?c=${conv.id}`, desktop, 'screenshots/assistant-desktop.png');
    await shot(`${BASE}/`, phone, 'screenshots/now-phone.png');
    await shot(`${BASE}/#/assistant?c=${conv.id}`, phone, 'screenshots/assistant-phone.png');
    await shot(`${BASE}/#/battery`, { ...phone, dark: true }, 'screenshots/battery-phone-dark.png');
  } else {
    await shot(`${BASE}/`, { width: 360, height: 640, scale: 3, mobile: true }, 'public/icons/screenshot-narrow.png');
    await shot(`${BASE}/#/assistant?c=${conv.id}`, { width: 1920, height: 1080, scale: 1, mobile: false }, 'public/icons/screenshot-wide.png');
  }
} finally {
  cdp?.close();
  chrome.kill();
  server.kill();
}
