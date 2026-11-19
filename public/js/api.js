// The only place that talks to /api. A 401 sends the user to the login page and comes back here afterwards.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  // mutating routes require a JSON content type (CSRF check), even without a body
  const headers = method === 'GET' ? {} : { 'content-type': 'application/json' };
  const res = await fetch(path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
    return new Promise(() => {}); // the page is leaving; callers keep their skeleton instead of flashing an error
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  // the service worker answered from its copy: the server cannot be reached (sw.js)
  if (res.headers.get('x-ofs-offline') && data && typeof data === 'object') data.offline = true;
  return data;
}

// query string without null or undefined values; arrays are comma-joined
function q(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

export const getStatus = (opts) => api('/api/status', opts);
export const getSeries = ({ from, to, bucket }, opts) => api(`/api/series${q({ from, to, bucket })}`, opts);
export const getEnergy = ({ from, to, bucket, compare }, opts) => api(`/api/energy${q({ from, to, bucket, compare })}`, opts);
export const getDays = (from, to, opts) => api(`/api/days${q({ from, to })}`, opts);
export const getEvents = ({ from, to, kinds }, opts) => api(`/api/events${q({ from, to, kinds })}`, opts);
export const getSignals = (opts) => api('/api/signals', opts);
export const getSignalHistory = ({ dn, ids, from, to, bucket }, opts) =>
  api(`/api/signals/history${q({ dn, ids, from, to, bucket })}`, opts);
export const getBills = (opts) => api('/api/bills', opts);
export const putBill = (month, amount, opts) => api('/api/bills', { ...opts, method: 'PUT', body: { month, amount } });
export const getAlertsConfig = (opts) => api('/api/alerts/config', opts);
export const putAlertsConfig = (cfg, opts) => api('/api/alerts/config', { ...opts, method: 'PUT', body: cfg });
export const sendTestEmail = (to, opts, lang) => api('/api/alerts/test', { ...opts, method: 'POST', body: to ? { to, ...(lang && { lang }) } : {} });
export const getAlertsHistory = ({ limit, before } = {}, opts) => api(`/api/alerts/history${q({ limit, before })}`, opts);
export const logout = (opts) => api('/api/logout', { ...opts, method: 'POST' });

// Bills and billing (shapes: src/invoices.js, src/billing.js)
const post = (path, body, opts) => api(path, { ...opts, method: 'POST', body: body ?? {} });
export const getInvoices = (opts) => api('/api/invoices', opts);
export const getInvoice = (id, opts) => api(`/api/invoices/get${q({ id })}`, opts);
export const getUploads = (opts) => api('/api/invoices/uploads', opts);
export const createInvoice = (group, opts) => post('/api/invoices/create', group ? { group } : {}, opts);
// revert: columns put back to the value read from the bill (sent only when there are some)
export const saveInvoice = (id, fields, { confirm, force, noNumber, revert } = {}, opts) =>
  post('/api/invoices/save', { id, fields, confirm, force, noNumber, ...(revert?.length && { revert }) }, opts);
export const resolveInvoice = (id, action, opts) => post('/api/invoices/resolve', { id, action }, opts);
export const retryInvoice = (group, opts) => post('/api/invoices/retry', { group }, opts);
export const processGroup = (group, opts) => post('/api/invoices/process', { group }, opts);
export const deleteInvoice = (id, opts) => post('/api/invoices/delete', { id }, opts);
export const deleteAllInvoices = (opts) => post('/api/invoices/delete-all', {}, opts);
export const fileUrl = (fileId) => `/api/invoices/file${q({ id: fileId })}`;
export const getBilling = ({ from, to }, opts) => api(`/api/billing${q({ from, to })}`, opts);
export const getBillingInvoice = (id, opts) => api(`/api/billing/invoice${q({ id })}`, opts);

// Assistant
export const getConversations = (opts) => api('/api/assistant/conversations', opts);
export const getConversation = (id, opts) => api(`/api/assistant/conversation${q({ id })}`, opts);
export const deleteConversation = (id, opts) => post('/api/assistant/conversations/delete', { id }, opts);
export const deleteAllConversations = (opts) => post('/api/assistant/conversations/delete-all', {}, opts);
export const getAiUsage = (opts) => api('/api/assistant/usage', opts);

// NDJSON: one JSON object per line; a line may arrive cut across chunks. Pure, so tests can feed a fake reader.
export async function readNdjson(reader, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (line) => {
    if (line.trim()) onEvent(JSON.parse(line));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(flush);
  }
  flush(buffer + decoder.decode());
}

// POST the question; a JSON error before the stream starts throws ApiError, a 200 streams events to onEvent.
export async function chatStream(body, { signal, onEvent } = {}) {
  const res = await fetch('/api/assistant/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
    return new Promise(() => {});
  }
  if (res.status !== 200) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  }
  await readNdjson(res.body.getReader(), onEvent ?? (() => {}));
  return null;
}
