// Jina client: web search (titles, urls and snippets only) and page reading. Built like createLlm: the key
// lives only in this closure and never reaches a log, an error, kv or status(). Error bodies are never read or logged.
// The caller applies src/web-rules.js before any call; read() still sends only a canonical https url.
import { fetchCapped } from './http.js';
import { canonicalUrl, urlRefusal } from './web-rules.js';
import { dayBounds, localDay } from './collector.js';

const SEARCH_URL = 'https://s.jina.ai/';
const READ_URL = 'https://r.jina.ai/';
const TIMEOUT_MS = 15000;
const DAILY_LIMIT = 60;
const JOBS = ['web_search', 'web_read'];
const BY_STATUS = { 401: 'bad_key', 402: 'no_balance' };
const KEY_ERRORS = ['bad_key', 'no_balance'];

const cut = (s, n) => String(s ?? '').slice(0, n);
// results keep only urls read_web_page could read
const httpsUrl = (u) => {
  const c = canonicalUrl(u);
  return c && urlRefusal(c, new Set([c])) === null ? c : null;
};

// Page text for the model: no images, link targets dropped (their text kept), bare urls kept as text.
const pageText = (s) => String(s ?? '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .slice(0, 6000);

export function createWeb({ apiKey, store, fetch = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const lastError = () => store.getKv('web')?.lastError ?? null;

  // One POST to Jina → { data } or { code }.
  async function post(url, body, { auth, extra, signal }) {
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...extra };
    if (auth) headers.authorization = `Bearer ${apiKey}`;
    let res;
    try {
      res = await fetchCapped(url, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: TIMEOUT_MS, signal, fetch });
    } catch {
      return { code: 'error' };
    }
    if (res.status !== 200) return { code: BY_STATUS[res.status] ?? 'error' };
    if (res.text == null) return { code: 'error' }; // over 1 MB
    try {
      return { data: JSON.parse(res.text).data };
    } catch {
      return { code: 'error' };
    }
  }

  const overLimit = () => store.countUsage(JOBS, dayBounds(localDay(now()))[0]) >= DAILY_LIMIT;
  const counted = (job) => store.addUsage({ ts: now(), job, model: 'jina', cost_usd: 0 });
  const remember = (code) => store.setKv('web', { lastError: code ?? null, at: now() });

  async function search(query, { signal } = {}) {
    if (!apiKey) return { unavailable: 'no_key' };
    if (overLimit()) return { unavailable: 'daily_limit' };
    let { data, code } = await post(SEARCH_URL, { q: String(query) }, { auth: true, extra: { 'x-respond-with': 'no-content' }, signal });
    if (!code && !Array.isArray(data)) code = 'error';
    remember(code);
    if (code) {
      log(`web search error ${code}`);
      return { unavailable: code };
    }
    counted('web_search');
    const results = data.map((r) => ({ title: cut(r?.title, 200), url: httpsUrl(r?.url), snippet: cut(r?.description, 400) }))
      .filter((r) => r.url).slice(0, 5);
    return { results };
  }

  async function read(url, { signal } = {}) {
    const target = httpsUrl(url);
    if (!target) return { unavailable: 'error' };
    if (overLimit()) return { unavailable: 'daily_limit' };
    // with the key first; on 401/402 or without a key, keyless (rate-limited but free)
    let r = await post(READ_URL, { url: target }, { auth: Boolean(apiKey), signal });
    remember(r.code); // kv keeps the first attempt's outcome, so a keyless success does not hide a key error
    if (apiKey && KEY_ERRORS.includes(r.code)) r = await post(READ_URL, { url: target }, { auth: false, signal });
    if (!r.code && typeof r.data?.content !== 'string') r = { code: 'error' };
    if (r.code) {
      log(`web read error ${r.code}`);
      return { unavailable: r.code };
    }
    counted('web_read');
    return { title: cut(r.data.title, 200), url: target, text: pageText(r.data.content) };
  }

  function status() {
    const e = lastError();
    return { available: Boolean(apiKey) && !KEY_ERRORS.includes(e), lastError: e };
  }

  return { search, read, status };
}
