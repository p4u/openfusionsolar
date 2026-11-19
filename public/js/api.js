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
export const sendTestEmail = (to, opts) => api('/api/alerts/test', { ...opts, method: 'POST', body: to ? { to } : {} });
export const getAlertsHistory = ({ limit, before } = {}, opts) => api(`/api/alerts/history${q({ limit, before })}`, opts);
export const logout = (opts) => api('/api/logout', { ...opts, method: 'POST' });
