import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { energy } from '../src/aggregate.js';
import { localDay, shiftDay } from '../src/collector.js';
import { createDemoDb } from '../scripts/demo-db.js';

test('the demo data set is complete, invented and refuses existing or data/ paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-demo-'));
  try {
    const now = Date.now();
    const file = createDemoDb(path.join(dir, 'demo.db'), now);
    assert.throws(() => createDemoDb(file, now), /already exists/);
    assert.throws(() => createDemoDb(path.join(import.meta.dirname, '..', 'data', 'x.db'), now), /data\//);

    const store = new Store(file);
    const today = localDay(now);
    assert.equal(store.getKv('station').name, 'Casa Demo');
    assert.equal(store.days(shiftDay(today, -399), today).length, 400);
    const invoices = store.listInvoices({ status: 'confirmed' });
    assert.equal(invoices.length, 12);
    assert.ok(invoices.every((i) => i.supplier === 'Demo Energia' && i.cups == null));
    const first = store.firstSampleTs();
    assert.ok(now - first > 44 * 864e5 && now - first < 46 * 864e5);
    assert.equal(store.db.prepare('select count(*) as n from samples').get().n, 45 * 288);

    const convs = store.conversations();
    assert.deepEqual(convs.map((c) => c.title).sort(), ['Estalvi de la casa demo', 'Prova de seguretat']);
    const blocks = convs.flatMap((c) => store.chatMessages(c.id)).flatMap((m) => m.blocks).map((b) => b.type);
    for (const t of ['text', 'figure', 'choice', 'sources']) assert.ok(blocks.includes(t), t);

    const e = energy(store, { from: shiftDay(today, -30), to: shiftDay(today, -1), bucket: '1d', now });
    assert.ok(e.total.pv_kwh > 0);
    store.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
