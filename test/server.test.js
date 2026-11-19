import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startServer } from '../src/server.js';

test('a malformed request target gets 400 and the server keeps running', async () => {
  const store = { getKv: () => null, setKv: () => {}, latestRealtime: () => null, lastSampleTs: () => null };
  const server = startServer({ store, config: { password: 'x' }, port: 0, log: () => {} });
  await once(server, 'listening');
  const { port } = server.address();
  const raw = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.end('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let out = '';
    s.on('data', (d) => (out += d)).on('end', () => resolve(out)).on('error', reject);
  });
  assert.match(raw, /^HTTP\/1.1 400/);
  const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(ok.status, 200);
  server.close();
});
