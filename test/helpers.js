// Starts the server on a free port and logs in; request() sends the session cookie and a matching Origin.
import { once } from 'node:events';
import { startServer } from '../src/server.js';

export async function startTestServer({ store, collector = null, config = {}, alerts, password = 'pw-test', failDelayMs = 0 }) {
  const server = startServer({
    store, collector, config: { ...config, password }, port: 0, host: '127.0.0.1', log: () => {}, alerts, failDelayMs,
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password }),
  });
  if (login.status !== 204) throw new Error(`test login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, init = {}) => {
    const mutating = ['POST', 'PUT'].includes((init.method ?? 'GET').toUpperCase());
    const headers = { cookie, origin: base, ...(mutating && { 'content-type': 'application/json' }), ...init.headers };
    return fetch(base + path, { redirect: 'manual', ...init, headers });
  };
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { base, cookie, request, close };
}
