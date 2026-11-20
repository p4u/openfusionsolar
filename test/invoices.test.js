process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { Store, INVOICE_COLS, LINE_COLS, READING_COLS } from '../src/db.js';
import { createLlm, DEFAULT_MODEL } from '../src/llm.js';
import { createInvoices, sniff, pdfPages } from '../src/invoices.js';
import { normalise, toRow } from '../src/invoice-schema.js';
import { fakeFetch, fixture } from './fixtures/llm/fake.js';
import { startTestServer } from './helpers.js';

const MB = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (pages = 1) => Buffer.concat([
  Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj << /Type /Page >> endobj\n'.repeat(pages)), crypto.randomBytes(16), Buffer.from('\n%%EOF'),
]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(32), Buffer.from([0xff, 0xd9])]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(32)]);

// A recorded extraction answer with its content changed.
function withContent(name, edit) {
  const step = fixture(name);
  const content = JSON.parse(step.response.choices[0].message.content);
  edit(content);
  step.response = structuredClone(step.response);
  step.response.choices[0].message.content = JSON.stringify(content);
  return step;
}

async function setup(t, { steps = [], apiKey = 'test-key', start = true, budgetUsd = 5, extractPerHour, store = new Store(':memory:') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-bills-'));
  const fake = fakeFetch(steps);
  const logs = [];
  const llm = createLlm({ apiKey, store, budgetUsd, fetch: fake.fetch, sleep: async () => {}, log: (m) => logs.push(m) });
  const invoices = createInvoices({ store, llm, dir, model: DEFAULT_MODEL, extractPerHour, log: (m) => logs.push(m) });
  if (start) invoices.start();
  const srv = await startTestServer({ store, routes: invoices.routes });
  t.after(async () => {
    invoices.stop();
    await invoices.idle();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const upload = (body, { group = randomUUID(), pos = 0, type = 'application/pdf', name, headers = {} } = {}) => srv.request(
    `/api/invoices/upload?group=${group}&pos=${pos}&source=upload`,
    { method: 'POST', headers: { 'content-type': type, ...(name && { 'x-filename': encodeURIComponent(name) }), ...headers }, body },
  );
  const post = (p, body = {}) => srv.request(p, { method: 'POST', body: JSON.stringify(body) });
  const get = async (p) => (await srv.request(p)).json();
  // Uploads the files as one group, asks for its extraction and waits for the queue.
  const bill = async (files) => {
    const group = randomUUID();
    for (const [pos, f] of files.entries()) {
      const r = await upload(f.buf ?? f, { group, pos, type: f.type ?? 'application/pdf' });
      assert.equal(r.status, 201);
    }
    const res = await post('/api/invoices/process', { group });
    await invoices.idle();
    return { group, res };
  };
  return { store, dir, fake, logs, invoices, srv, upload, post, get, bill };
}

test('every key toRow returns is an invoice, line or reading column', () => {
  const { row, lines, readings } = toRow(normalise(JSON.parse(fixture('extract-pdf-ok').response.choices[0].message.content)));
  for (const k of Object.keys(row)) assert.ok(INVOICE_COLS.includes(k), k);
  for (const k of Object.keys(lines[0])) assert.ok(LINE_COLS.includes(k), k);
  for (const k of Object.keys(readings[0])) assert.ok(READING_COLS.includes(k), k);
});

test('sniff and pdfPages read the bytes', () => {
  assert.equal(sniff(pdf()), 'pdf');
  assert.equal(sniff(jpeg()), 'jpeg');
  assert.equal(sniff(png()), 'png');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniff(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0')), 'heic');
  assert.equal(sniff(Buffer.from('\0\0\0\x18ftypisom\0\0\0\0')), null);
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniff(Buffer.from('PK\x03\x04')), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.equal(pdfPages(pdf(3)), 3);
  assert.equal(pdfPages(Buffer.from('%PDF-1.4 << /Type /Pages /Count 3 >>')), 0);
});

test('the sample pdf is stored, extracted and auto-confirmed', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-pdf-ok')] });
  const buf = pdf(3);
  const { group, res } = await s.bill([buf]);
  assert.equal(res.status, 202);
  assert.equal(s.fake.calls.length, 1);
  const req = s.fake.calls[0];
  assert.equal(req.max_tokens, 6000);
  assert.equal(req.response_format.json_schema.strict, true);
  assert.equal(req.tools, undefined);
  assert.equal(req.messages[1].content[1].file.file_data, `data:application/pdf;base64,${buf.toString('base64')}`);
  assert.deepEqual(fs.readdirSync(s.dir), [`${sha(buf)}.pdf`]);

  const { invoices, coverage, missing } = await s.get('/api/invoices');
  assert.equal(invoices.length, 1);
  const inv = invoices[0];
  assert.equal(inv.total_eur, 59.15);
  assert.equal(inv.kwh, 159.08);
  assert.equal(inv.surplus_kwh, 24);
  assert.equal(inv.month, '2026-10');
  assert.equal(inv.badge, 'auto');
  assert.equal(inv.auto_confirmed, 1);
  assert.equal(coverage.find((c) => c.month === '2026-10').state, 'ok');
  assert.deepEqual(missing, []);

  const d = await s.get(`/api/invoices/get?id=${inv.id}`);
  assert.equal(d.invoice.contracted_p1_kw, 4.4);
  assert.equal(d.invoice.status, 'confirmed');
  assert.equal(d.invoice.cups, undefined, 'the full CUPS stays on the server');
  assert.equal(d.invoice.contract_number, undefined);
  assert.equal(s.store.invoice(inv.id).cups, 'ES0031000000000001BJ0F');
  assert.equal(d.invoice.cups_masked, 'ES00...BJ0F');
  assert.equal(d.checks.filter((c) => c.hard && c.outcome !== 'pass').length, 0);
  assert.equal(d.lines.length, 12);
  assert.equal(d.readings.length, 6);
  assert.equal(d.states.total_eur, 'verified');
  assert.deepEqual(d.files.map((f) => f.kind), ['pdf']);
  assert.deepEqual(d.extraction, { status: 'done', model: DEFAULT_MODEL, attempt: 1 });

  const [up] = await s.get('/api/invoices/uploads');
  assert.equal(up.groupId, group);
  assert.equal(up.status, 'done');
  assert.equal(up.invoiceId, inv.id);
  assert.equal(s.store.usageCostSince(0) > 0, true);

  // only months measured on 15 days or more can be missing: August (31 days) is, July (10 days) is not
  for (let i = 1; i <= 31; i++) s.store.saveDaily(`2026-08-${String(i).padStart(2, '0')}`, { import_kwh: 1 });
  for (let i = 1; i <= 10; i++) s.store.saveDaily(`2026-07-${String(i).padStart(2, '0')}`, { import_kwh: 1 });
  const after = await s.get('/api/invoices');
  assert.deepEqual(after.measuredMonths, ['2026-08']);
  assert.deepEqual(after.missing, ['2026-08']);
});

test('photos of one bill are one group; a failed check is retried once with the checks named and then confirmed', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-images-fail'), fixture('extract-images-retry-ok')] });
  const files = [{ buf: jpeg(), type: 'image/jpeg' }, { buf: png(), type: 'image/png' }];
  await s.bill(files);
  assert.equal(s.fake.calls.length, 2);
  const [first, second] = s.fake.calls;
  assert.deepEqual(first.messages[1].content.map((p) => p.type), ['text', 'image_url', 'image_url']);
  assert.match(first.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(first.messages[1].content[2].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(second.messages.slice(0, 2), first.messages);
  assert.equal(second.messages[2].role, 'assistant');
  const last = second.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /H4/);
  assert.match(last.content, /H1/);
  const { invoices } = await s.get('/api/invoices');
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].badge, 'auto');
  const d = await s.get(`/api/invoices/get?id=${invoices[0].id}`);
  assert.equal(d.extraction.attempt, 2);
  assert.equal(d.files.length, 2);
});

test('invalid json is retried once, then the bill stays a draft with failing checks visible', async (t) => {
  const s = await setup(t, { steps: [fixture('invalid-json'), fixture('extract-images-fail')] });
  await s.bill([pdf()]);
  assert.equal(s.fake.calls.length, 2);
  assert.match(s.fake.calls[1].messages.at(-1).content, /not complete, valid JSON/);
  const { invoices } = await s.get('/api/invoices');
  assert.equal(invoices[0].status, 'draft');
  assert.equal(invoices[0].badge, 'review');
  const d = await s.get(`/api/invoices/get?id=${invoices[0].id}`);
  assert.deepEqual([...new Set(d.checks.filter((c) => c.outcome === 'fail' && c.hard).map((c) => c.id))].sort(), ['H1', 'H3', 'H4']);
  assert.equal(d.states.energy_eur, 'suspect');
});

test('a second failure never makes a third call', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-images-fail'), fixture('extract-images-fail'), fixture('invalid-json'), fixture('invalid-json')] });
  await s.bill([pdf()]);
  assert.equal(s.fake.calls.length, 2);
  assert.equal((await s.get('/api/invoices')).invoices[0].status, 'draft');

  const { group } = await s.bill([pdf()]);
  assert.equal(s.fake.calls.length, 4);
  const up = (await s.get('/api/invoices/uploads')).find((u) => u.groupId === group);
  assert.equal(up.status, 'failed');
  assert.equal(up.error, 'invalid_json');
  assert.equal(up.files.length, 1); // kept for a retry or a manual entry
});

test('not a bill deletes the files and reports it', async (t) => {
  const s = await setup(t, { steps: [fixture('not-a-bill')] });
  const { group } = await s.bill([pdf()]);
  const [up] = await s.get('/api/invoices/uploads');
  assert.equal(up.groupId, group);
  assert.equal(up.status, 'not_a_bill');
  assert.deepEqual(up.files, []);
  assert.deepEqual(fs.readdirSync(s.dir), []);
  assert.equal(s.store.billFiles(group).length, 0);
  assert.equal((await s.get('/api/invoices')).invoices.length, 0);
});

test('the same file twice is refused with the existing invoice', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-pdf-ok')] });
  const buf = pdf();
  await s.bill([buf]);
  const id = (await s.get('/api/invoices')).invoices[0].id;
  const again = await s.upload(buf);
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'duplicate_file', invoiceId: id, period: '2026-10' });
  assert.equal(fs.readdirSync(s.dir).length, 1);
});

test('the same invoice number becomes a draft marked duplicate', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-pdf-ok'), fixture('extract-pdf-ok')] });
  await s.bill([pdf()]);
  const { group } = await s.bill([pdf()]);
  const { invoices } = await s.get('/api/invoices');
  assert.equal(invoices.length, 2);
  const [older, newer] = invoices;
  assert.equal(older.badge, 'auto');
  assert.equal(newer.status, 'draft');
  assert.equal(newer.duplicate_of, older.id);
  assert.equal(newer.badge, 'duplicate');
  const up = (await s.get('/api/invoices/uploads')).find((u) => u.groupId === group);
  assert.equal(up.duplicateOf, older.id);

  // gate F3: confirming from the form is refused until the duplicate is resolved; saving edits stays allowed
  const confirm = await s.post('/api/invoices/save', { id: newer.id, fields: {}, confirm: true });
  assert.equal(confirm.status, 409);
  assert.deepEqual(await confirm.json(), { error: 'duplicate_unresolved' });
  assert.equal(s.store.invoice(newer.id).status, 'draft');
  assert.equal((await s.post('/api/invoices/save', { id: newer.id, fields: { notes: 'same bill' } })).status, 200);
  assert.equal(s.store.invoice(newer.id).status, 'draft');
});

test('waitFor returns at once when its signal is aborted', async (t) => {
  const s = await setup(t, { start: false });
  const group = randomUUID();
  await s.upload(pdf(), { group });
  await s.post('/api/invoices/process', { group });
  const t0 = Date.now();
  const ex = await s.invoices.waitFor(group, 60e3, AbortSignal.abort());
  assert.equal(ex.status, 'queued');
  assert.ok(Date.now() - t0 < 1000);
});

test('resolve keep marks the older superseded; replace deletes it; discard deletes the draft', async (t) => {
  const s = await setup(t, { steps: Array(5).fill(0).map(() => fixture('extract-pdf-ok')) });
  await s.bill([pdf()]);
  await s.bill([pdf()]);
  let [older, newer] = (await s.get('/api/invoices')).invoices;
  assert.equal((await s.post('/api/invoices/resolve', { id: older.id, action: 'keep' })).status, 409);
  const kept = await s.post('/api/invoices/resolve', { id: newer.id, action: 'keep' });
  assert.equal(kept.status, 200);
  [older, newer] = (await s.get('/api/invoices')).invoices;
  assert.equal(newer.status, 'confirmed');
  assert.equal(newer.duplicate_of, null);
  assert.equal(older.superseded_by, newer.id);

  // a third copy duplicates the live one (the superseded bill no longer counts)
  await s.bill([pdf()]);
  const third = (await s.get('/api/invoices')).invoices.at(-1);
  assert.equal(third.duplicate_of, newer.id);
  assert.equal((await s.post('/api/invoices/resolve', { id: third.id, action: 'replace' })).status, 200);
  const ids = (await s.get('/api/invoices')).invoices.map((i) => i.id);
  assert.deepEqual(ids, [older.id, third.id]);
  // the bill that superseded the oldest is gone, so the oldest comes back
  assert.equal(s.store.invoice(older.id).superseded_by, null);

  await s.bill([pdf()]);
  const fourth = (await s.get('/api/invoices')).invoices.at(-1);
  assert.equal((await s.post('/api/invoices/resolve', { id: fourth.id, action: 'discard' })).status, 204);
  assert.equal(s.store.invoice(fourth.id), undefined);
  assert.equal(fs.readdirSync(s.dir).length, 2);
});

test('uploads are checked by magic bytes, not content type', async (t) => {
  const s = await setup(t);
  const html = await s.upload(Buffer.from('<html><script>alert(1)</script></html>'), { type: 'application/pdf' });
  assert.equal(html.status, 415);
  assert.deepEqual(await html.json(), { error: 'unsupported_type' });
  const svg = await s.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { type: 'image/svg+xml' });
  assert.equal(svg.status, 415);
  const zip = await s.upload(Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(64)]), { type: 'application/octet-stream' });
  assert.equal(zip.status, 415);
  const buf = png();
  const ok = await s.upload(buf, { type: 'application/octet-stream', name: 'foto\u0007 de la factura.png' });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.kind, 'png');
  assert.equal(body.bytes, buf.length);
  assert.equal(s.store.billFile(body.id).name, 'foto de la factura.png');
  assert.deepEqual(fs.readdirSync(s.dir), [`${sha(buf)}.png`]);
  const long = await s.upload(png(), { type: 'image/png', headers: { 'x-filename': `%E0%A4%A${'x'.repeat(400)}` } });
  assert.equal(long.status, 201);
  assert.equal(s.store.billFile((await long.json()).id).name.length, 200);
});

test('upload checks the group: one pdf alone, at most six images, nothing after its extraction', async (t) => {
  const s = await setup(t, { start: false });
  const group = randomUUID();
  assert.equal((await s.upload(pdf(), { group })).status, 201);
  assert.equal((await s.upload(jpeg(), { group, pos: 1, type: 'image/jpeg' })).status, 400);
  const photos = randomUUID();
  for (let pos = 0; pos < 6; pos++) assert.equal((await s.upload(jpeg(), { group: photos, pos, type: 'image/jpeg' })).status, 201);
  assert.equal((await s.upload(jpeg(), { group: photos, pos: 5, type: 'image/jpeg' })).status, 400);
  assert.equal((await s.upload(pdf(), { group: photos, pos: 5 })).status, 400);
  assert.equal((await s.post('/api/invoices/process', { group })).status, 202);
  assert.equal((await s.upload(jpeg(), { group, pos: 1, type: 'image/jpeg' })).status, 409);
  for (const q of ['group=nope&pos=0', `group=${randomUUID()}&pos=6`, `group=${randomUUID()}&pos=0&source=x`]) {
    const r = await s.srv.request(`/api/invoices/upload?${q}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf() });
    assert.equal(r.status, 400, q);
  }
});

test('over 10 MB is 413 with connection close, declared or not', async (t) => {
  const s = await setup(t);
  const { port, host } = new URL(s.srv.base);
  const head = await new Promise((resolve, reject) => {
    let out = '';
    const sock = net.connect(Number(port), '127.0.0.1', () => sock.write([
      `POST /api/invoices/upload?group=${randomUUID()}&pos=0 HTTP/1.1`, `Host: ${host}`, `Cookie: ${s.srv.cookie}`,
      `Origin: ${s.srv.base}`, 'Content-Type: application/pdf', `Content-Length: ${10 * MB + 1}`, '', '',
    ].join('\r\n')));
    sock.on('data', (d) => {
      out += d;
      if (out.includes('\r\n\r\n')) {
        sock.destroy();
        resolve(out);
      }
    }).on('error', reject);
  });
  assert.match(head, /^HTTP\/1.1 413/);
  assert.match(head, /\r\nconnection: close/i);

  const chunk = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MB - 9)]);
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (sent++ < 11) c.enqueue(sent === 1 ? chunk : new Uint8Array(MB));
      else c.close();
    },
  });
  const big = await s.srv.request(`/api/invoices/upload?group=${randomUUID()}&pos=0`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: stream, duplex: 'half',
  });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('connection'), 'close');
  assert.deepEqual(await big.json(), { error: 'too_large' });
  assert.deepEqual(fs.readdirSync(s.dir), []);
});

test('a pdf over 10 pages is refused', async (t) => {
  const s = await setup(t);
  const r = await s.upload(pdf(11));
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: 'too_many_pages' });
  assert.equal((await s.upload(pdf(10))).status, 201);
  assert.equal(fs.readdirSync(s.dir).length, 1);
});

test('wrong origin is 403 and form content type is 415', async (t) => {
  const s = await setup(t);
  const q = `/api/invoices/upload?group=${randomUUID()}&pos=0`;
  const evil = await s.srv.request(q, { method: 'POST', headers: { 'content-type': 'application/pdf', origin: 'http://evil.example' }, body: pdf() });
  assert.equal(evil.status, 403);
  for (const type of ['multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'text/plain']) {
    const r = await s.srv.request(q, { method: 'POST', headers: { 'content-type': type }, body: pdf() });
    assert.equal(r.status, 415, type);
  }
  const json = await s.srv.request('/api/invoices/create', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' });
  assert.equal(json.status, 403);
  assert.deepEqual(fs.readdirSync(s.dir), []);
});

test('everything is 401 without a session', async (t) => {
  const s = await setup(t);
  for (const key of Object.keys(s.invoices.routes)) {
    const [method, p] = key.split(' ');
    const r = await fetch(`${s.srv.base}${p}?id=1&group=${randomUUID()}`, {
      method, headers: { origin: s.srv.base, 'content-type': p.endsWith('upload') ? 'application/pdf' : 'application/json' },
      ...(method === 'POST' && { body: p.endsWith('upload') ? pdf() : '{}' }),
    });
    assert.equal(r.status, 401, key);
  }
  assert.deepEqual(fs.readdirSync(s.dir), []);
});

test('editing records the original value, re-runs the checks and confirm needs force when a hard check fails', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-pdf-ok')] });
  await s.bill([pdf()]);
  const { id } = (await s.get('/api/invoices')).invoices[0];

  const bad = await s.post('/api/invoices/save', { id, fields: { total_eur: 'a lot', period_to: '2026-02-30', kind: null, holder_name: 'x', notes: 'x'.repeat(301) } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys((await bad.json()).fields).sort(), ['holder_name', 'kind', 'notes', 'period_to', 'total_eur']);

  const refused = await s.post('/api/invoices/save', { id, fields: { total_eur: 60 } });
  assert.equal(refused.status, 409);
  const why = await refused.json();
  assert.equal(why.error, 'checks_failed');
  // each failing check says which one, on which fields, with a stable message key and its numbers
  assert.deepEqual(why.checks.map((c) => [c.id, c.key, c.fields, c.expected, c.actual]),
    [['H1', 'invoices.check.sum', ['tax_base_eur', 'vat_eur', 'other_exempt_eur', 'total_eur'], 59.15, 60]]);
  assert.equal(s.store.invoice(id).total_eur, 59.15);
  const rule = await (await s.post('/api/invoices/save', { id, fields: { issue_date: '2026-10-15' } })).json();
  assert.deepEqual(rule.checks.map((c) => [c.id, c.key, c.fields]), [['H5', 'invoices.check.rule', ['issue_date']]]);
  const product = await (await s.post('/api/invoices/save', { id, fields: { energy_p1_eur: 7.4 } })).json();
  assert.deepEqual(product.checks.map((c) => [c.id, c.key]), [['H4', 'invoices.check.product'], ['H4', 'invoices.check.sum']]);

  const forced = await s.post('/api/invoices/save', { id, fields: { total_eur: 60, notes: 'checked by hand' }, force: true });
  assert.equal(forced.status, 200);
  const d = await forced.json();
  assert.equal(d.invoice.total_eur, 60);
  assert.equal(d.invoice.edits.total_eur.from, 59.15);
  assert.equal(d.invoice.edits.notes.from, null);
  assert.equal(d.states.total_eur, 'edited');
  assert.equal(d.checks.find((c) => c.id === 'H1').outcome, 'fail');
  assert.equal(d.invoice.badge, 'warnings');
  assert.equal(d.invoice.auto_confirmed, 0);

  // a second edit keeps the first original
  const again = await (await s.post('/api/invoices/save', { id, fields: { total_eur: 59.15 }, force: true })).json();
  assert.equal(again.invoice.edits.total_eur, undefined, 'typed back to the value read from the bill: no longer an edit');
  // an emptied text field whose bill value was empty is not an edit either (empty and null alike)
  const noted = await (await s.post('/api/invoices/save', { id, fields: { notes: null } })).json();
  assert.equal(noted.invoice.edits.notes, undefined);
  assert.equal((await (await s.post('/api/invoices/save', { id, fields: { notes: 'checked by hand' } })).json()).invoice.edits.notes.from, null);
  assert.equal(again.invoice.badge, 'confirmed');

  // revert: an edited field goes back to the value read from the bill and its edit entry goes; never-edited ones are ignored
  assert.equal((await s.post('/api/invoices/save', { id, fields: { total_eur: 60 }, force: true })).status, 200);
  const reverted = await s.post('/api/invoices/save', { id, revert: ['total_eur', 'supplier'] });
  assert.equal(reverted.status, 200);
  const r = await reverted.json();
  assert.deepEqual([r.invoice.total_eur, r.invoice.edits.total_eur, r.invoice.edits.notes.from, r.invoice.status], [59.15, undefined, null, 'confirmed']);
  assert.equal(r.states.total_eur, 'verified');
  assert.equal(r.invoice.supplier, s.store.invoice(id).supplier);
  // revert and fields together: revert first, so the new edit keeps the bill's value as its original
  const both = await (await s.post('/api/invoices/save', { id, revert: ['notes'], fields: { total_eur: 61 }, force: true })).json();
  assert.deepEqual([both.invoice.notes, both.invoice.edits.notes, both.invoice.total_eur, both.invoice.edits.total_eur.from], [null, undefined, 61, 59.15]);
  // same confirm rules: when the value read from the bill fails a hard check, the revert of a confirmed bill needs force
  s.store.updateInvoice(id, { edits: JSON.stringify({ total_eur: { from: 70, at: 1 } }) });
  const unforced = await s.post('/api/invoices/save', { id, revert: ['total_eur'] });
  assert.equal(unforced.status, 409);
  assert.equal(s.store.invoice(id).total_eur, 61);
  const forcedBack = await (await s.post('/api/invoices/save', { id, revert: ['total_eur'], force: true })).json();
  assert.deepEqual([forcedBack.invoice.total_eur, forcedBack.invoice.edits, forcedBack.invoice.status], [70, {}, 'confirmed']);
  for (const bad of ['total_eur', [1], { total_eur: 1 }]) {
    assert.equal((await s.post('/api/invoices/save', { id, revert: bad })).status, 400, JSON.stringify(bad));
  }

  // a manual draft: confirming needs the required fields, and "no number" stands for the number
  const created = await s.post('/api/invoices/create', {});
  assert.equal(created.status, 201);
  const draft = (await created.json()).id;
  assert.equal((await s.post('/api/invoices/save', { id: draft, fields: { supplier: 'Som' } })).status, 200);
  const missing = await s.post('/api/invoices/save', { id: draft, fields: {}, confirm: true });
  assert.equal(missing.status, 400);
  assert.deepEqual(Object.keys((await missing.json()).fields).sort(), ['invoice_number', 'kwh_p1', 'kwh_p2', 'kwh_p3', 'period_from', 'period_to', 'total_eur']);
  const fields = { period_from: '2026-08-01', period_to: '2026-08-31', total_eur: 10, kwh_p1: 0, kwh_p2: 0, kwh_p3: 0 };
  // checks that cannot run for lack of values (H1-H4 here) need no force; a failing one does
  assert.equal((await s.post('/api/invoices/save', { id: draft, fields: { ...fields, tax_base_eur: 5, vat_eur: 1 }, confirm: true, noNumber: true })).status, 409);
  const noNumber = await s.post('/api/invoices/save', { id: draft, fields: { ...fields, tax_base_eur: null, vat_eur: null }, confirm: true, noNumber: true });
  assert.equal(noNumber.status, 200);
  const saved = await noNumber.json();
  assert.equal(saved.invoice.status, 'confirmed');
  assert.equal(saved.invoice.invoice_number, '');
  assert.equal(saved.invoice.badge, 'confirmed');
  assert.equal(saved.checks.find((c) => c.id === 'H1').outcome, 'missing');
});

test('delete removes rows and bytes; delete-all empties the folder', async (t) => {
  const s = await setup(t, { steps: [fixture('extract-pdf-ok'), fixture('not-a-bill')] });
  await s.bill([pdf()]);
  const { id } = (await s.get('/api/invoices')).invoices[0];
  const groupId = s.store.invoice(id).group_id;
  assert.equal((await s.post('/api/invoices/delete', { id })).status, 204);
  assert.equal(s.store.invoice(id), undefined);
  assert.equal(s.store.invoiceLines(id).length, 0);
  assert.equal(s.store.invoiceReadings(id).length, 0);
  assert.equal(s.store.latestExtraction(groupId), undefined);
  assert.equal(s.store.billFiles(groupId).length, 0);
  assert.deepEqual(fs.readdirSync(s.dir), []);
  assert.equal((await s.post('/api/invoices/delete', { id })).status, 404);
  assert.equal((await s.post('/api/invoices/delete', { id: 'x' })).status, 400);

  await s.bill([pdf()]); // not a bill: extraction row kept
  await s.upload(pdf()); // stored, never processed
  await s.upload(jpeg(), { type: 'image/jpeg' });
  await s.post('/api/invoices/create', {});
  fs.writeFileSync(path.join(s.dir, 'stray.pdf.tmp-1'), 'x');
  fs.mkdirSync(path.join(s.dir, 'lost+found', 'inner'), { recursive: true }); // gate F9
  assert.equal((await s.post('/api/invoices/delete-all')).status, 204);
  assert.deepEqual(fs.readdirSync(s.dir), []);
  assert.deepEqual(s.store.allBillGroups(), []);
  assert.equal(s.store.listInvoices().length, 0);
  assert.equal(s.store.countBillFiles(), 0);
});

test('the file route sends the original with its sandbox headers', async (t) => {
  const s = await setup(t);
  const buf = pdf();
  const { id } = await (await s.upload(buf)).json();
  const r = await s.srv.request(`/api/invoices/file?id=${id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), buf);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), `inline; filename="factura-${id}.pdf"`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const img = await (await s.upload(jpeg(), { type: 'image/jpeg' })).json();
  const ri = await s.srv.request(`/api/invoices/file?id=${img.id}`);
  assert.equal(ri.headers.get('content-type'), 'image/jpeg');
  assert.equal(ri.headers.get('content-disposition'), `inline; filename="factura-${img.id}.jpg"`);

  for (const p of ['/api/invoices', '/api/invoices/uploads', '/api/status']) {
    const o = await s.srv.request(p);
    assert.equal(o.headers.get('x-frame-options'), 'DENY', p);
    assert.match(o.headers.get('content-security-policy'), /^default-src 'self'/, p);
  }
  for (const q of ['../../etc/passwd', '1.5', '', '-1', `${id} `]) {
    assert.equal((await s.srv.request(`/api/invoices/file?id=${encodeURIComponent(q)}`)).status, 400, q);
  }
  assert.equal((await s.srv.request('/api/invoices/file?id=999')).status, 404);
  assert.equal((await s.srv.request('/api/invoices/get?id=999')).status, 404);
  assert.equal((await s.srv.request('/api/invoices/get?id=abc')).status, 400);
});

test('upstream 429 and budget leave the files stored and the extraction failed with the code', async (t) => {
  const store = new Store(':memory:');
  const s = await setup(t, { store, steps: [fixture('upstream-429'), fixture('upstream-429'), fixture('upstream-429')] });
  const { group } = await s.bill([pdf()]);
  assert.equal(s.fake.calls.length, 3); // transport retries, one attempt
  let up = (await s.get('/api/invoices/uploads')).find((u) => u.groupId === group);
  assert.equal(up.status, 'failed');
  assert.equal(up.error, 'rate_limited');
  assert.equal(up.files.length, 1);
  assert.equal(fs.readdirSync(s.dir).length, 1);

  store.addUsage({ ts: Date.now(), job: 'extract', model: DEFAULT_MODEL, tokens_in: 0, tokens_out: 0, cost_usd: 5, ref: 'x' });
  const retry = await s.post('/api/invoices/retry', { group });
  assert.equal(retry.status, 429);
  assert.deepEqual(await retry.json(), { error: 'budget' });
  const g2 = randomUUID();
  await s.upload(pdf(), { group: g2 });
  const proc = await s.post('/api/invoices/process', { group: g2 });
  assert.equal(proc.status, 429);
  assert.deepEqual(await proc.json(), { error: 'budget' });
  up = (await s.get('/api/invoices/uploads')).find((u) => u.groupId === g2);
  assert.equal(up.status, 'failed');
  assert.equal(up.error, 'budget');
  assert.equal(up.files.length, 1);
  assert.equal(s.fake.calls.length, 3);
  assert.ok(s.logs.every((l) => !/test-key/.test(l)));
});

test('process answers 429 after 30 extractions in an hour', async (t) => {
  const s = await setup(t, { start: false });
  for (let i = 0; i < 30; i++) {
    const group = randomUUID();
    await s.upload(pdf(), { group });
    assert.equal((await s.post('/api/invoices/process', { group })).status, 202, `extraction ${i}`);
  }
  const group = randomUUID();
  await s.upload(pdf(), { group });
  const r = await s.post('/api/invoices/process', { group });
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.retryAfter > 0);
  assert.equal(r.headers.get('retry-after'), String(body.retryAfter));
  assert.equal(s.store.latestExtraction(group).error, 'rate_limited');
});

test('process twice starts one extraction; retry only after a failure', async (t) => {
  const s = await setup(t, { start: false });
  const group = randomUUID();
  await s.upload(pdf(), { group });
  const first = await s.post('/api/invoices/process', { group });
  assert.equal(first.status, 202);
  const { extractionId } = await first.json();
  const second = await s.post('/api/invoices/process', { group });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { extractionId });
  assert.equal(s.store.extractionsByStatus(['queued']).length, 1);
  assert.deepEqual(await (await s.post('/api/invoices/retry', { group })).json(), { error: 'not_failed' });
  assert.equal((await s.post('/api/invoices/process', { group: randomUUID() })).status, 404);
  assert.equal((await s.post('/api/invoices/process', { group: 'x' })).status, 400);
});

test('a file stored without ai becomes a manual draft with its original', async (t) => {
  const s = await setup(t, { apiKey: '' });
  const group = randomUUID();
  const buf = pdf();
  const { id: fileId } = await (await s.upload(buf, { group })).json();
  const proc = await s.post('/api/invoices/process', { group });
  assert.equal(proc.status, 409);
  assert.deepEqual(await proc.json(), { error: 'ai_disabled' });
  const [up] = await s.get('/api/invoices/uploads');
  assert.deepEqual({ status: up.status, error: up.error, files: up.files.map((f) => f.id) }, { status: 'failed', error: 'ai_disabled', files: [fileId] });
  const created = await s.post('/api/invoices/create', { group });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await s.post('/api/invoices/create', { group })).status, 409);
  assert.equal((await s.post('/api/invoices/create', { group: randomUUID() })).status, 404);
  const d = await s.get(`/api/invoices/get?id=${id}`);
  assert.deepEqual(d.files, [{ id: fileId, kind: 'pdf', pos: 0 }]);
  assert.equal(d.extraction.status, 'failed');
  assert.equal(d.invoice.badge, 'review');
  assert.deepEqual(Buffer.from(await (await s.srv.request(`/api/invoices/file?id=${fileId}`)).arrayBuffer()), buf);
  // its file now belongs to a bill
  assert.equal((await s.upload(buf)).status, 409);
  assert.equal(s.fake.calls.length, 0);
});

test('a file whose first try was abandoned can be uploaded again', async (t) => {
  const s = await setup(t, { apiKey: '' });
  const buf = pdf();
  const old = randomUUID();
  await s.upload(buf, { group: old });
  assert.equal((await s.post('/api/invoices/process', { group: old })).status, 409);
  const group = randomUUID();
  const again = await s.upload(buf, { group });
  assert.equal(again.status, 201);
  assert.equal(s.store.billFiles(old).length, 0);
  assert.equal(s.store.latestExtraction(old), undefined);
  assert.equal(s.store.billFileBySha(sha(buf)).group_id, group);
  assert.equal(fs.readdirSync(s.dir).length, 1);
  // the same file again in the same group is a duplicate, not a reset
  assert.equal((await s.upload(buf, { group })).status, 409);
  assert.equal(s.store.billFiles(group).length, 1);
});

test('a restart re-queues bills left processing', async (t) => {
  const store = new Store(':memory:');
  const s = await setup(t, { store, start: false, steps: [fixture('extract-pdf-ok')] });
  const group = randomUUID();
  await s.upload(pdf(), { group });
  const exId = store.addExtraction({ group_id: group, status: 'processing', created_at: Date.now() });
  s.invoices.start();
  const ex = await s.invoices.waitFor(group, 5000);
  assert.equal(ex.id, exId);
  assert.equal(ex.status, 'done');
  assert.equal(store.invoice(ex.invoice_id).status, 'confirmed');
});

test('stored rows and responses hold no holder data', async (t) => {
  const step = withContent('extract-pdf-ok', (c) => {
    c.holder_name = 'Maria Exemple Exemple';
    c.iban = 'ES9121000418450200051332';
    c.supply.address = 'Carrer Fals 1';
    c.lines[0].concept = 'Domiciliacio ES91 2100 0418 4502 0005 1332 titular 12345678Z';
    c.notes = 'NIE X1234567L';
  });
  const s = await setup(t, { steps: [step] });
  await s.bill([pdf()]);
  const { id } = (await s.get('/api/invoices')).invoices[0];
  const dump = JSON.stringify(s.store.db.prepare("select name from sqlite_master where type = 'table'").all()
    .map(({ name }) => s.store.db.prepare(`select * from ${name}`).all()));
  const api = JSON.stringify([await s.get('/api/invoices'), await s.get(`/api/invoices/get?id=${id}`), await s.get('/api/invoices/uploads')]);
  for (const text of [dump, api]) {
    for (const bad of ['holder_name', 'Maria Exemple', 'iban', 'ES9121000418450200051332', '2100 0418', '12345678Z', 'X1234567L', 'Carrer Fals']) {
      assert.ok(!text.includes(bad), bad);
    }
  }
  assert.match(dump, /Domiciliacio \[\.\.\.\]/);
});
