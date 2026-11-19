process.env.TZ = 'Europe/Madrid';
// Live OpenRouter check, skipped unless AI_SMOKE=1. Prints only cost and timing, never bill values or the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';
import { createLlm, DEFAULT_MODEL } from '../src/llm.js';
import { createInvoices } from '../src/invoices.js';
import { validCups } from '../src/invoice-schema.js';
import { startTestServer } from './helpers.js';

const REPO = '/volumes/repos/fusionsolar/openfusionsolar';
const skip = process.env.AI_SMOKE !== '1';

test('the sample bill is extracted live and auto-confirmed', { skip, timeout: 240e3 }, async (t) => {
  process.loadEnvFile(path.join(REPO, '.env'));
  const pdfPath = process.env.AI_SMOKE_PDF || path.join(REPO, '.delivery/2026-11-19-billing-assistant/sample-bill.pdf');
  const store = new Store(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-smoke-'));
  const llm = createLlm({ apiKey: process.env.AI_API_KEY, store, budgetUsd: 0.05 });
  const model = process.env.AI_MODEL_EXTRACT || DEFAULT_MODEL;
  const invoices = createInvoices({ store, llm, dir, model });
  invoices.start();
  const srv = await startTestServer({ store, routes: invoices.routes });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const t0 = Date.now();
  const group = randomUUID();
  const up = await srv.request(`/api/invoices/upload?group=${group}&pos=0`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: fs.readFileSync(pdfPath),
  });
  assert.equal(up.status, 201);
  assert.equal((await srv.request('/api/invoices/process', { method: 'POST', body: JSON.stringify({ group }) })).status, 202);
  const ex = await invoices.waitFor(group, 200e3);
  console.log(`smoke extract: ${model}, ${ex.attempt} call(s), ${store.usageCostSince(0).toFixed(4)} USD, ${Date.now() - t0} ms`);
  assert.equal(ex.status, 'done', `extraction ${ex.status} ${ex.error ?? ''}`);

  const d = await (await srv.request(`/api/invoices/get?id=${ex.invoice_id}`)).json();
  const inv = d.invoice;
  assert.deepEqual(d.checks.filter((c) => c.hard && c.outcome !== 'pass').map((c) => c.id), []);
  assert.equal(inv.auto_confirmed, 1);
  assert.equal(inv.status, 'confirmed');
  assert.deepEqual([inv.period_from, inv.period_to, inv.days, inv.issue_date], ['2026-10-01', '2026-10-31', 31, '2026-11-12']);
  assert.equal(inv.tariff, '2.0TD');
  assert.deepEqual([inv.contracted_p1_kw, inv.contracted_p2_kw], [4.4, 4.4]);
  assert.deepEqual([inv.max_demand_p1_kw, inv.max_demand_p2_kw], [4.952, 3.572]);
  assert.deepEqual([inv.kwh_p1, inv.kwh_p2, inv.kwh_p3], [25.704, 29.651, 103.725]);
  assert.deepEqual([inv.price_p1, inv.price_p2, inv.price_p3], [0.249, 0.169, 0.15]);
  assert.equal(inv.adjust_eur, 4.62);
  assert.deepEqual([inv.surplus_p1_kwh, inv.surplus_p2_kwh, inv.surplus_p3_kwh, inv.surplus_price, inv.surplus_eur], [0, 11.47, 12.53, 0.03, 0.72]);
  assert.equal(inv.total_eur, 59.15);
  assert.ok(validCups(inv.cups), 'the CUPS has valid control letters');
});
