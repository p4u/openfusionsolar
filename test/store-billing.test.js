import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, INVOICE_COLS, LINE_COLS, READING_COLS } from '../src/db.js';

const cols = (store, table) => store.db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
const file = (over = {}) => ({ sha: 'a'.repeat(64), kind: 'pdf', bytes: 10, name: 'f.pdf', group_id: 'g1', pos: 0, uploaded_at: 1, source: 'upload', ...over });

test('an existing database gains the new tables and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-store-'));
  try {
    const dbPath = path.join(dir, 'old.db');
    let store = new Store(dbPath);
    store.saveDaily('2026-11-01', { pv_kwh: 12.5, import_kwh: 3 });
    store.setKv('realBills', { '2026-10': 41.2 });
    store.db.close();
    for (let i = 0; i < 2; i++) { // reopening twice is idempotent
      store = new Store(dbPath);
      assert.equal(store.days('2026-11-01', '2026-11-01')[0].pv_kwh, 12.5);
      assert.deepEqual(store.getKv('realBills'), { '2026-10': 41.2 });
      assert.ok(cols(store, 'invoices').includes('total_eur'));
      for (const t of ['bill_files', 'bill_extractions', 'invoice_lines', 'invoice_readings', 'chat_conversations', 'chat_messages', 'ai_usage']) {
        assert.ok(cols(store, t).length > 0, t);
      }
      store.db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('column constants match the tables', () => {
  const store = new Store(':memory:');
  assert.deepEqual(cols(store, 'invoices').filter((c) => !['id', 'created_at', 'updated_at'].includes(c)), INVOICE_COLS);
  assert.deepEqual(cols(store, 'invoice_lines').filter((c) => !['id', 'invoice_id'].includes(c)), LINE_COLS);
  assert.deepEqual(cols(store, 'invoice_readings').filter((c) => c !== 'invoice_id'), READING_COLS);
});

test('invoice insert, update and delete keep lines and readings in step', () => {
  const store = new Store(':memory:');
  const lines = [{ section: 'power', concept: 'Potència P1', amount_eur: 10.5 }, { section: 'energy', concept: 'Energia P1', amount_eur: 20, info: true }];
  const readings = [{ kind: 'import', period: 'p1', start_kwh: 100, end_kwh: 150, estimated: false }];
  const id = store.insertInvoice({ status: 'draft', kind: null, period_from: '2026-09-15', period_to: '2026-10-14', cups: 'ES0031000000000001BJ0F', self_consumption: true }, lines, readings);
  const inv = store.invoice(id);
  assert.equal(inv.kind, 'normal'); // null falls back to the column default
  assert.equal(inv.auto_confirmed, 0);
  assert.equal(inv.self_consumption, 1);
  assert.ok(inv.created_at > 0 && inv.updated_at === inv.created_at);
  assert.deepEqual(store.invoiceLines(id).map((l) => [l.pos, l.concept, l.info]), [[0, 'Potència P1', 0], [1, 'Energia P1', 1]]);
  assert.equal(store.invoiceReadings(id)[0].estimated, 0);

  store.updateInvoice(id, { total_eur: 57.56, status: 'confirmed' });
  assert.equal(store.invoice(id).total_eur, 57.56);
  assert.equal(store.invoiceLines(id).length, 2, 'lines kept when not given');
  store.updateInvoice(id, {}, [{ section: 'other', concept: 'Donació', amount_eur: 1.59 }], []);
  assert.deepEqual(store.invoiceLines(id).map((l) => l.concept), ['Donació']);
  assert.equal(store.invoiceReadings(id).length, 0);
  assert.throws(() => store.updateInvoice(id, { holder_name: 'x' }), /unknown column/);
  assert.throws(() => store.insertInvoice({ status: 'draft', iban: 'x' }), /unknown column/);

  const other = store.insertInvoice({ status: 'draft', invoice_number: 'FE0000000001', period_from: '2026-10-14', period_to: '2026-11-13', cups: 'ES0031000000000001BJ0F' }, lines, readings);
  assert.deepEqual(store.invoicesByNumber('FE0000000001').map((r) => r.id), [other]);
  assert.deepEqual(store.invoicesOverlapping('ES0031000000000001BJ0F', '2026-10-01', '2026-10-20').map((r) => r.id), [id, other]);
  assert.deepEqual(store.invoicesOverlapping('ES0031000000000001BJ0F', '2026-10-14', '2026-11-13').map((r) => r.id), [other], 'shared boundary day is not an overlap');
  assert.deepEqual(store.listInvoices({ status: 'confirmed' }).map((r) => r.id), [id]);
  assert.deepEqual(store.listInvoices({ from: '2026-11-01', to: '2026-11-30' }).map((r) => r.id), [other]);
  assert.deepEqual(store.listInvoices().map((r) => r.id), [id, other]);

  store.deleteInvoice(id);
  assert.equal(store.invoice(id), undefined);
  assert.equal(store.invoiceLines(id).length, 0);
  assert.equal(store.invoiceReadings(id).length, 0);
  assert.equal(store.invoiceLines(other).length, 2);
  assert.equal(store.invoiceReadings(other).length, 1);
});

test('bill files are unique by sha', () => {
  const store = new Store(':memory:');
  const id = store.addBillFile(file());
  assert.equal(store.billFile(id).group_id, 'g1');
  assert.equal(store.billFileBySha('a'.repeat(64)).id, id);
  assert.throws(() => store.addBillFile(file({ group_id: 'g2' })), /UNIQUE/);
  store.addBillFile(file({ sha: 'c'.repeat(64), kind: 'jpeg', pos: 1 }));
  store.addBillFile(file({ sha: 'b'.repeat(64), kind: 'jpeg', group_id: 'g2' }));
  assert.equal(store.countBillFiles(), 3);
  assert.deepEqual(store.billFiles('g1').map((f) => f.pos), [0, 1]);
  assert.deepEqual(store.allBillGroups().sort(), ['g1', 'g2']);
});

test('deleting a group\'s files leaves its extraction row', () => {
  const store = new Store(':memory:');
  store.addBillFile(file());
  store.addBillFile(file({ sha: 'c'.repeat(64), kind: 'png', pos: 1 }));
  const ex = store.addExtraction({ group_id: 'g1', status: 'not_a_bill', created_at: 5 });
  assert.deepEqual(store.deleteBillGroup('g1'), [{ sha: 'a'.repeat(64), kind: 'pdf' }, { sha: 'c'.repeat(64), kind: 'png' }]);
  assert.equal(store.billFiles('g1').length, 0);
  assert.equal(store.extraction(ex).status, 'not_a_bill');
  store.deleteExtractions('g1');
  assert.equal(store.extraction(ex), undefined);
  // the delete methods also work inside a caller's transaction
  store.addBillFile(file());
  store.tx(() => {
    store.deleteBillGroup('g1');
    store.deleteExtractions('g1');
  });
  assert.equal(store.countBillFiles(), 0);
});

test('extractions update, list and select by status', () => {
  const store = new Store(':memory:');
  const a = store.addExtraction({ group_id: 'g1', status: 'queued', created_at: 1 });
  const b = store.addExtraction({ group_id: 'g1', status: 'queued', created_at: 2 });
  store.updateExtraction(a, { status: 'done', attempt: 2, finished_at: 100, result_json: '{}', checks_json: '[]', invoice_id: 7 });
  assert.equal(store.extraction(a).invoice_id, 7);
  assert.equal(store.latestExtraction('g1').id, b);
  assert.deepEqual(store.extractionsByStatus(['queued', 'processing']).map((e) => e.id), [b]);
  assert.deepEqual(store.recentExtractions(50).map((e) => e.id), [a, b]);
  assert.deepEqual(store.recentExtractions(101).map((e) => e.id), [b]);
  assert.throws(() => store.updateExtraction(a, { group_id: 'x' }), /unknown column/);
});

test('requeueProcessing moves processing back to queued', () => {
  const store = new Store(':memory:');
  const a = store.addExtraction({ group_id: 'g1', status: 'processing', created_at: 1 });
  const b = store.addExtraction({ group_id: 'g2', status: 'processing', created_at: 1 });
  const c = store.addExtraction({ group_id: 'g3', status: 'done', created_at: 1 });
  assert.equal(store.requeueProcessing(), 2);
  assert.deepEqual([a, b, c].map((id) => store.extraction(id).status), ['queued', 'queued', 'done']);
  assert.equal(store.requeueProcessing(), 0);
});

test('usage cost sums since a timestamp', () => {
  const store = new Store(':memory:');
  assert.equal(store.usageCostSince(0), 0);
  store.addUsage({ ts: 100, job: 'extract', model: 'm', tokens_in: 10, tokens_out: 5, cost_usd: 0.25, ref: 'extract:1' });
  store.addUsage({ ts: 200, job: 'chat', model: 'm', cost_usd: 0.5 });
  store.addUsage({ ts: 300, job: 'chat', model: 'm', cost_usd: 1 });
  assert.equal(store.usageCostSince(0), 1.75);
  assert.equal(store.usageCostSince(200), 1.5);
  assert.equal(store.usageCostSince(301), 0);
});

test('conversations prune to the newest 50 with their messages', () => {
  const store = new Store(':memory:');
  const ids = [];
  for (let i = 0; i < 55; i++) {
    const id = store.createConversation(`c${i}`, i);
    store.addChatMessage(id, 'user', [{ type: 'text', text: `q${i}` }], i);
    ids.push(id);
  }
  store.touchConversation(ids[0], 1000); // the oldest becomes the newest
  store.pruneConversations();
  const kept = store.conversations(100).map((c) => c.id);
  assert.equal(kept.length, 50);
  assert.equal(kept[0], ids[0]);
  for (const id of ids.slice(1, 6)) {
    assert.ok(!kept.includes(id));
    assert.equal(store.chatMessages(id).length, 0);
  }
  assert.deepEqual(store.chatMessages(ids[0])[0].blocks, [{ type: 'text', text: 'q0' }]);
  assert.equal(store.db.prepare('select count(*) as n from chat_messages').get().n, 50);
});

test('chat messages come oldest first, limited to the newest; deletes remove messages', () => {
  const store = new Store(':memory:');
  const id = store.createConversation('t', 1);
  for (let i = 0; i < 5; i++) store.addChatMessage(id, i % 2 ? 'assistant' : 'user', [{ type: 'text', text: String(i) }], i);
  assert.deepEqual(store.chatMessages(id, 3).map((m) => m.blocks[0].text), ['2', '3', '4']);
  const other = store.createConversation('u', 2);
  store.addChatMessage(other, 'user', [], 2);
  store.deleteConversation(id);
  assert.equal(store.chatMessages(id).length, 0);
  assert.deepEqual(store.conversations().map((c) => c.id), [other]);
  store.deleteAllConversations();
  assert.equal(store.conversations().length, 0);
  assert.equal(store.chatMessages(other).length, 0);
});
