// Bill uploads (bytes on disk named by sha, rows in bill_files), the extraction queue and the review routes.
// The model sees the files only through llm.complete (no tools, strict schema); what it answers goes through
// normalise (unknown keys such as holder data are dropped) before anything is stored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBody } from './server.js';
import { createLimiter } from './auth.js';
import { localDay } from './collector.js';
import { LlmError } from './llm.js';
import {
  BILL_SCHEMA, SYSTEM_PROMPT, normalise, toRow, checks, retryText, fieldStates, maskCups, isDate, RETRY_PATHS,
  coverageMonths, missingMonths, measuredMonths,
} from './invoice-schema.js';
import { billMonth } from '../public/js/buckets.js';

const MB = 1024 * 1024;
const MAX_FILE = 10 * MB;
const MAX_PAGES = 10;
const MAX_FILES = 500;
const MAX_IMAGES = 6;
const DAY_MS = 24 * 3600e3;
const EXT = { pdf: 'pdf', jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic' };
const MIME = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
const RAW_TYPES = ['application/pdf', 'image/', 'application/octet-stream'];
const FINISHED = new Set(['done', 'not_a_bill', 'failed']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The file type from its first bytes; the declared content type is never trusted.
export function sniff(buf) {
  const ascii = (a, b) => buf.subarray(a, b).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(8, 12))) return 'heic';
  return null;
}

// shortcut: page objects counted by regex; PDFs with object streams give 0 (unknown) and are accepted.
export const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

const sum = (...v) => (v.some((x) => typeof x === 'number') ? Math.round(v.reduce((s, x) => s + (x ?? 0), 0) * 1000) / 1000 : null);
const hardOk = (list) => list.filter((c) => c.hard).every((c) => c.outcome === 'pass');
// a check that cannot run (a value left empty) does not block a person's confirmation; a wrong sum does
const hardFailed = (list) => [...new Set(list.filter((c) => c.hard && c.outcome === 'fail').map((c) => c.id))];
// The failing hard checks as the 409 answer sends them: the check with its fields and a stable message key.
const CHECK_KEY = { '+': 'invoices.check.sum', '×': 'invoices.check.product' };
const failedChecks = (list) => list.filter((c) => c.hard && c.outcome === 'fail').map((c) => ({ ...c, key: CHECK_KEY[c.op] ?? 'invoices.check.rule' }));
const intId = (v) => (Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : null);
const cleanName = (raw) => {
  if (typeof raw !== 'string') return null;
  let s = raw;
  try { s = decodeURIComponent(raw); } catch { /* shown as sent */ }
  return s.replace(/\p{Cc}/gu, '').slice(0, 200).trim() || null;
};

// Editable columns and their validation (save route).
const STRINGS = new Set(['supplier', 'supplier_tax_id', 'invoice_number', 'rectifies_number', 'cups', 'contract_number', 'tariff', 'notes']);
const DATE_COLS = new Set(['issue_date', 'period_from', 'period_to', 'due_date']);
function fieldError(col, v) {
  if (!Object.hasOwn(RETRY_PATHS, col)) return 'not an editable field';
  if (col === 'kind') return ['normal', 'rectifying', 'credit'].includes(v) ? null : 'normal, rectifying or credit';
  if (v === null) return null;
  if (col === 'self_consumption') return typeof v === 'boolean' ? null : 'true, false or null';
  if (DATE_COLS.has(col)) return isDate(v) ? null : 'a date YYYY-MM-DD or null';
  if (STRINGS.has(col)) {
    const max = col === 'notes' ? 300 : 200; // notes: the length normalise keeps
    return typeof v === 'string' && v.length <= max ? null : `text up to ${max} characters or null`;
  }
  if (col === 'days') return Number.isInteger(v) && v >= 0 && v <= 366 ? null : 'a whole number of days or null';
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? null : 'a number or null';
}

export function createInvoices({ store, llm, dir, now = Date.now, log = () => {}, model, concurrency = 2, extractPerHour = 30 }) {
  const limiter = createLimiter({ perIp: extractPerHour, global: extractPerHour, windowMs: 3600e3, now });
  const running = new Map(); // extraction id -> promise
  let started = false;
  const fileOf = (f) => path.join(dir, `${f.sha}.${EXT[f.kind]}`);
  const today = () => localDay(now());
  const groupInvoices = (groupId) => store.listInvoices().filter((i) => i.group_id === groupId);

  // ---- deletion ------------------------------------------------------------------------------------

  // References to deleted bills are cleared, so an older bill comes back when its replacement goes.
  function dropRefs(ids) {
    for (const inv of store.listInvoices()) {
      const patch = {};
      if (ids.includes(inv.superseded_by)) patch.superseded_by = null;
      if (ids.includes(inv.duplicate_of)) patch.duplicate_of = null;
      if (Object.keys(patch).length) store.updateInvoice(inv.id, patch);
    }
  }

  function unlinkAll(files) {
    for (const f of files) fs.rmSync(fileOf(f), { force: true });
  }

  // Invoices, lines, readings, extractions, file rows and bytes of one group.
  function deleteGroup(groupId) {
    const files = store.tx(() => {
      const ids = groupInvoices(groupId).map((i) => i.id);
      ids.forEach((id) => store.deleteInvoice(id));
      store.deleteExtractions(groupId);
      dropRefs(ids);
      return store.deleteBillGroup(groupId);
    });
    unlinkAll(files);
  }

  function deleteInvoice(inv) {
    if (inv.group_id) return deleteGroup(inv.group_id);
    store.tx(() => {
      store.deleteInvoice(inv.id);
      dropRefs([inv.id]);
    });
  }

  function deleteAll() {
    store.tx(() => {
      for (const g of store.allBillGroups()) deleteGroup(g);
      for (const inv of store.listInvoices()) store.deleteInvoice(inv.id);
    });
    // also any bytes left by a crash between rename and insert
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
  }

  // ---- extraction queue ----------------------------------------------------------------------------

  // The confirmed, live bill just before this one on the same supply, with its readings (for S5).
  function previousOf(row, exceptId) {
    if (!row.cups || !isDate(row.period_from)) return undefined;
    const prev = store.listInvoices({ status: 'confirmed' })
      .filter((i) => i.id !== exceptId && !i.superseded_by && i.cups === row.cups && isDate(i.period_to) && i.period_to <= row.period_from)
      .at(-1);
    return prev && { ...prev, readings: store.invoiceReadings(prev.id) };
  }

  // Duplicates are looked for among confirmed, non-superseded bills only (preflight F24).
  function duplicateOf(row, exceptId) {
    const live = (i) => i.id !== exceptId && i.status === 'confirmed' && !i.superseded_by;
    if (row.invoice_number) {
      const hit = store.invoicesByNumber(row.invoice_number).find(live);
      if (hit) return hit;
    }
    if (row.cups && isDate(row.period_from) && isDate(row.period_to)) {
      return store.invoicesOverlapping(row.cups, row.period_from, row.period_to).find(live);
    }
    return undefined;
  }

  const part = (f, buf) => (f.kind === 'pdf'
    ? { type: 'file', file: { filename: 'bill.pdf', file_data: `data:application/pdf;base64,${buf.toString('base64')}` } }
    : { type: 'image_url', image_url: { url: `data:${MIME[f.kind]};base64,${buf.toString('base64')}` } });

  async function job(ex) {
    const finish = (patch) => {
      if (!store.extraction(ex.id)) return false; // deleted while it ran
      store.updateExtraction(ex.id, { finished_at: now(), ...patch });
      log(`invoices extraction ${ex.id} ${patch.status}${patch.error ? ` ${patch.error}` : ''}`);
      return true;
    };
    store.updateExtraction(ex.id, { status: 'processing', model });
    const files = store.billFiles(ex.group_id);
    if (!files.length) return finish({ status: 'failed', error: 'no_files' });
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [{ type: 'text', text: 'Extract this bill.' }, ...files.map((f) => part(f, fs.readFileSync(fileOf(f))))] },
    ];
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!store.extraction(ex.id)) return false;
      store.updateExtraction(ex.id, { attempt });
      let res;
      try {
        res = await llm.complete({ job: 'extract', model, messages, schema: BILL_SCHEMA, maxTokens: 6000, timeoutMs: 90e3, ref: `extract:${ex.id}` });
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        const heic = err.code === 'upstream' && err.status >= 400 && err.status < 500 && files.some((f) => f.kind === 'heic');
        return finish({ status: 'failed', error: heic ? 'heic_unsupported' : err.code });
      }
      const content = typeof res.message.content === 'string' ? res.message.content : '';
      let raw = null;
      if (res.finishReason !== 'length') try { raw = JSON.parse(content); } catch { /* invalid: retried below */ }
      let problem = 'The previous answer was not complete, valid JSON.';
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.is_electricity_bill === false) {
          if (!finish({ status: 'not_a_bill' })) return false;
          unlinkAll(store.deleteBillGroup(ex.group_id));
          return true;
        }
        const bill = normalise(raw);
        const { row, lines, readings } = toRow(bill);
        const list = checks(row, { readings, today: today(), previous: previousOf(row) });
        result = { bill, row, lines, readings, list };
        const failed = retryText(list);
        if (!failed) break;
        problem = `The previous answer failed these checks:\n${failed}`;
      }
      messages.push({ role: 'assistant', content }, { role: 'user', content: `${problem}\nFix only what is wrong and return the full JSON again.` });
    }
    if (!result) return finish({ status: 'failed', error: 'invalid_json' });

    const { bill, row, lines, readings, list } = result;
    return store.tx(() => {
      if (!store.extraction(ex.id)) return false;
      const dup = duplicateOf(row);
      const auto = !dup && hardOk(list);
      const invoiceId = store.insertInvoice({
        ...row, group_id: ex.group_id, status: auto ? 'confirmed' : 'draft', auto_confirmed: auto ? 1 : 0, duplicate_of: dup?.id ?? null,
      }, lines, readings);
      return finish({ status: 'done', result_json: JSON.stringify(bill), checks_json: JSON.stringify(list), invoice_id: invoiceId });
    });
  }

  function pump() {
    if (!started) return;
    for (const ex of store.extractionsByStatus(['queued'])) {
      if (running.size >= concurrency) break;
      if (running.has(ex.id)) continue;
      const p = job(ex)
        .catch((err) => {
          log(`invoices extraction ${ex.id} error ${err.name}`);
          if (store.extraction(ex.id)) store.updateExtraction(ex.id, { status: 'failed', error: 'internal', finished_at: now() });
        })
        .finally(() => {
          running.delete(ex.id);
          pump();
        });
      running.set(ex.id, p);
    }
  }

  async function idle() {
    while (running.size) await Promise.allSettled([...running.values()]);
  }

  async function waitFor(groupId, ms = 120e3, signal) {
    const end = Date.now() + ms;
    for (;;) {
      const ex = store.latestExtraction(groupId);
      if (!ex || FINISHED.has(ex.status) || Date.now() >= end || signal?.aborted) return ex ?? null;
      await sleep(100);
    }
  }

  // A new extraction row for a group: queued, or failed with the reason AI cannot run now (so it shows with Retry).
  function admit(groupId) {
    let refusal = null;
    const retryAfter = limiter.retryAfter('extract');
    if (!llm.enabled) refusal = [409, { error: 'ai_disabled' }];
    else if (retryAfter > 0) refusal = [429, { error: 'rate_limited', retryAfter }, { 'retry-after': String(retryAfter) }];
    else if (!(llm.monthSpend() < llm.budgetUsd)) refusal = [429, { error: 'budget' }];
    const id = store.addExtraction({ group_id: groupId, status: refusal ? 'failed' : 'queued', created_at: now() });
    if (refusal) {
      store.updateExtraction(id, { error: refusal[1].error, finished_at: now() });
      return refusal;
    }
    limiter.fail('extract'); // counts one extraction in the hour
    pump();
    return [202, { extractionId: id }];
  }

  // ---- route helpers -------------------------------------------------------------------------------

  function badge(inv) {
    if (inv.status !== 'confirmed') return inv.duplicate_of ? 'duplicate' : 'review';
    if (inv.auto_confirmed) return 'auto';
    return hardFailed(checks(inv, { today: today() })).length ? 'warnings' : 'confirmed';
  }

  function detail(inv) {
    const lines = store.invoiceLines(inv.id);
    const readings = store.invoiceReadings(inv.id);
    const list = checks(inv, { readings, today: today(), previous: previousOf(inv, inv.id) });
    const ex = inv.group_id ? store.latestExtraction(inv.group_id) : null;
    const edits = inv.edits ? JSON.parse(inv.edits) : {};
    const unreadable = ex?.result_json ? JSON.parse(ex.result_json).unreadable ?? [] : [];
    const { cups, contract_number: _contract, ...shown } = inv;
    // the supply number and contract never leave the server, also not as an edit's original or a check's term
    const hide = (col, v) => (col === 'cups' ? maskCups(v) : col === 'contract_number' ? null : v);
    const shownEdits = Object.fromEntries(Object.entries(edits).map(([c, e]) => [c, { ...e, from: hide(c, e.from) }]));
    return {
      invoice: { ...shown, edits: shownEdits, cups_masked: maskCups(cups), badge: badge(inv) },
      lines,
      readings,
      checks: list.map((c) => ({ ...c, terms: c.terms?.map((x) => ({ ...x, value: hide(x.col, x.value) })) })),
      states: fieldStates(inv, list, { unreadable, edits }),
      files: inv.group_id ? store.billFiles(inv.group_id).map(({ id, kind, pos }) => ({ id, kind, pos })) : [],
      extraction: ex ? { status: ex.status, model: ex.model, attempt: ex.attempt } : null,
    };
  }

  const findInvoice = (id) => {
    const n = intId(id);
    if (n == null) return [null, [400, { error: 'invalid', fields: { id: 'an invoice id' } }]];
    const inv = store.invoice(n);
    return inv ? [inv, null] : [null, [404, { error: 'not found' }]];
  };
  const badGroup = (g) => (typeof g === 'string' && UUID_V4.test(g) ? null : [400, { error: 'invalid', fields: { group: 'a uuid v4' } }]);
  const busy = (groupId) => groupInvoices(groupId)[0]
    ?? (['queued', 'processing'].includes(store.latestExtraction(groupId)?.status) ? {} : null);

  // Confirming (save, resolve): required fields present, failing hard checks only with force.
  function confirmError(row, list, force) {
    const h7 = list.find((c) => c.id === 'H7');
    if (h7.outcome !== 'pass') return [400, { error: 'invalid', fields: Object.fromEntries(h7.fields.map((f) => [f, 'required'])) }];
    if (!force && hardFailed(list).length) return [409, { error: 'checks_failed', checks: failedChecks(list) }];
    return null;
  }

  // ---- routes --------------------------------------------------------------------------------------

  const routes = {
    'POST /api/invoices/upload': {
      body: 'raw', types: RAW_TYPES, maxBytes: MAX_FILE,
      handler: async ({ req, query }) => {
        const groupId = query.get('group');
        const pos = Number(query.get('pos') ?? 0);
        const source = query.get('source') ?? 'upload';
        const fields = {};
        if (badGroup(groupId)) fields.group = 'a uuid v4';
        if (!Number.isInteger(pos) || pos < 0 || pos > MAX_IMAGES - 1) fields.pos = 'a whole number from 0 to 5';
        if (!['upload', 'chat'].includes(source)) fields.source = 'upload or chat';
        if (Object.keys(fields).length) return [400, { error: 'invalid', fields }];

        const buf = await readBody(req, MAX_FILE);
        if (buf == null) return [413, { error: 'too_large' }];
        const kind = sniff(buf);
        if (!kind) return [415, { error: 'unsupported_type' }];
        if (kind === 'pdf' && pdfPages(buf) > MAX_PAGES) return [413, { error: 'too_many_pages' }];
        const sha = crypto.createHash('sha256').update(buf).digest('hex');

        // From here to the insert everything is synchronous, so two uploads cannot interleave.
        const same = store.billFileBySha(sha);
        if (same) {
          const owner = busy(same.group_id);
          if (owner || same.group_id === groupId) {
            const inv = owner?.id ? owner : null;
            const period = inv && isDate(inv.period_from) && isDate(inv.period_to) ? billMonth(inv.period_from, inv.period_to) : null;
            return [409, { error: 'duplicate_file', invoiceId: inv?.id ?? null, period }];
          }
          deleteGroup(same.group_id); // an abandoned try (no bill, nothing running): start again
        }
        if (store.latestExtraction(groupId) || groupInvoices(groupId).length) return [409, { error: 'group_closed' }];
        const group = store.billFiles(groupId);
        if (group.length && (kind === 'pdf' || group.some((f) => f.kind === 'pdf'))) return [400, { error: 'pdf_alone' }];
        if (group.length >= MAX_IMAGES) return [400, { error: 'too_many_images' }];
        if (store.countBillFiles() >= MAX_FILES) return [409, { error: 'too_many_files' }];

        const file = { sha, kind };
        const tmp = `${fileOf(file)}.tmp-${crypto.randomBytes(6).toString('hex')}`;
        let renamed = false;
        try {
          fs.writeFileSync(tmp, buf, { mode: 0o600 });
          fs.renameSync(tmp, fileOf(file));
          renamed = true;
          const id = store.addBillFile({
            sha, kind, bytes: buf.length, name: cleanName(req.headers['x-filename']), group_id: groupId, pos, uploaded_at: now(), source,
          });
          return [201, { id, groupId, kind, bytes: buf.length }];
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          if (renamed) fs.rmSync(fileOf(file), { force: true });
          throw err;
        }
      },
    },

    'POST /api/invoices/process': ({ body }) => {
      const groupId = body?.group;
      const bad = badGroup(groupId);
      if (bad) return bad;
      if (!store.billFiles(groupId).length) return [404, { error: 'not found' }];
      const ex = store.latestExtraction(groupId);
      if (ex) return [200, { extractionId: ex.id }];
      return admit(groupId);
    },

    'POST /api/invoices/retry': ({ body }) => {
      const groupId = body?.group;
      const bad = badGroup(groupId);
      if (bad) return bad;
      if (!store.billFiles(groupId).length) return [404, { error: 'not found' }];
      if (store.latestExtraction(groupId)?.status !== 'failed') return [409, { error: 'not_failed' }];
      return admit(groupId);
    },

    'GET /api/invoices/uploads': () => [200, store.recentExtractions(now() - DAY_MS).map((ex) => {
      const inv = ex.invoice_id ? store.invoice(ex.invoice_id) : null;
      return {
        id: ex.id,
        groupId: ex.group_id,
        status: ex.status,
        files: store.billFiles(ex.group_id).map(({ id, name, kind }) => ({ id, name, kind })),
        invoiceId: inv ? inv.id : null,
        duplicateOf: inv?.duplicate_of ?? null,
        error: ex.error ?? null,
      };
    })],

    'GET /api/invoices': () => {
      const all = store.listInvoices();
      const day = today();
      const measured = store.measuredDays();
      return [200, {
        invoices: all.map((i) => ({
          id: i.id, status: i.status, auto_confirmed: i.auto_confirmed, period_from: i.period_from, period_to: i.period_to,
          month: isDate(i.period_from) && isDate(i.period_to) && i.period_from <= i.period_to ? billMonth(i.period_from, i.period_to) : null,
          supplier: i.supplier, total_eur: i.total_eur, kwh: sum(i.kwh_p1, i.kwh_p2, i.kwh_p3),
          surplus_kwh: sum(i.surplus_p1_kwh, i.surplus_p2_kwh, i.surplus_p3_kwh),
          duplicate_of: i.duplicate_of, superseded_by: i.superseded_by, badge: badge(i),
        })),
        coverage: coverageMonths(all, day),
        missing: missingMonths(all, day, measured),
        measuredMonths: measuredMonths(measured),
      }];
    },

    'GET /api/invoices/get': ({ query }) => {
      const [inv, err] = findInvoice(query.get('id'));
      return err ?? [200, detail(inv)];
    },

    'POST /api/invoices/create': ({ body }) => {
      const groupId = body?.group ?? null;
      if (groupId !== null) {
        const bad = badGroup(groupId);
        if (bad) return bad;
        if (!store.billFiles(groupId).length) return [404, { error: 'not found' }];
        if (busy(groupId)) return [409, { error: 'group_has_invoice' }];
      }
      return [201, { id: store.insertInvoice({ group_id: groupId, status: 'draft' }) }];
    },

    'POST /api/invoices/save': ({ body }) => {
      const [inv, err] = findInvoice(body?.id);
      if (err) return err;
      const input = body.fields ?? {};
      if (typeof input !== 'object' || Array.isArray(input)) return [400, { error: 'invalid', fields: { fields: 'an object' } }];
      const revert = body.revert ?? [];
      if (!Array.isArray(revert) || !revert.every((c) => typeof c === 'string')) return [400, { error: 'invalid', fields: { revert: 'a list of field names' } }];
      const fields = {};
      for (const [col, v] of Object.entries(input)) {
        const e = fieldError(col, v);
        if (e) fields[col] = e;
      }
      if (Object.keys(fields).length) return [400, { error: 'invalid', fields }];

      const values = { ...input };
      if (Object.hasOwn(values, 'self_consumption') && values.self_consumption !== null) values.self_consumption = values.self_consumption ? 1 : 0;
      if (body.noNumber === true && (values.invoice_number ?? inv.invoice_number) == null) values.invoice_number = ''; // explicit "no number"
      const edits = inv.edits ? JSON.parse(inv.edits) : {};
      const patch = {};
      const base = { ...inv };
      // revert first: an edited column goes back to the value read from the bill; columns never edited are ignored
      for (const col of revert) {
        if (!Object.hasOwn(edits, col)) continue;
        patch[col] = base[col] = edits[col].from;
        delete edits[col];
      }
      for (const [col, v] of Object.entries(values)) {
        if (v === base[col]) continue;
        patch[col] = v;
        if (!Object.hasOwn(edits, col)) edits[col] = { from: base[col], at: now() };
        // typed back to what the bill said (empty and null alike): no longer an edit; '' invoice_number means "no number"
        if (col !== 'invoice_number' && (edits[col].from ?? '') === (v ?? '')) delete edits[col];
      }
      const row = { ...inv, ...patch };
      const confirm = body.confirm === true || inv.status === 'confirmed';
      if (body.confirm === true && inv.status === 'draft') {
        // a draft that matches a confirmed bill (flagged at extraction, or by a number typed now) is settled by its three
        // choices, never confirmed beside it: keep the edits as a draft and flag it
        const dup = inv.duplicate_of ?? duplicateOf(row, inv.id)?.id ?? null;
        if (dup) {
          store.updateInvoice(inv.id, { ...patch, duplicate_of: dup, ...(Object.keys(patch).length && { edits: JSON.stringify(edits), auto_confirmed: 0 }) });
          return [409, { error: 'duplicate_unresolved' }];
        }
      }
      if (confirm) {
        const list = checks(row, { readings: store.invoiceReadings(inv.id), today: today(), previous: previousOf(row, inv.id) });
        const refused = confirmError(row, list, body.force === true);
        if (refused) return refused;
      }
      const changed = Object.keys(patch).length > 0;
      store.updateInvoice(inv.id, {
        ...patch, status: confirm ? 'confirmed' : inv.status,
        ...(changed && { edits: JSON.stringify(edits), auto_confirmed: 0 }),
      });
      return [200, detail(store.invoice(inv.id))];
    },

    'POST /api/invoices/resolve': ({ body }) => {
      const [inv, err] = findInvoice(body?.id);
      if (err) return err;
      const action = body.action;
      if (!['discard', 'replace', 'keep'].includes(action)) return [400, { error: 'invalid', fields: { action: 'discard, replace or keep' } }];
      if (inv.status !== 'draft' || !inv.duplicate_of) return [409, { error: 'not_duplicate' }];
      if (action === 'discard') {
        deleteInvoice(inv);
        return [204, null];
      }
      const list = checks(inv, { readings: store.invoiceReadings(inv.id), today: today(), previous: previousOf(inv, inv.id) });
      const refused = confirmError(inv, list, body.force === true);
      if (refused) return refused;
      const older = store.invoice(inv.duplicate_of);
      store.tx(() => {
        store.updateInvoice(inv.id, { status: 'confirmed', duplicate_of: null });
        if (older && action === 'replace') deleteInvoice(older);
        if (older && action === 'keep') store.updateInvoice(older.id, { superseded_by: inv.id });
      });
      return [200, detail(store.invoice(inv.id))];
    },

    'POST /api/invoices/delete': ({ body }) => {
      const [inv, err] = findInvoice(body?.id);
      if (err) return err;
      deleteInvoice(inv);
      return [204, null];
    },

    'POST /api/invoices/delete-all': () => {
      deleteAll();
      return [204, null];
    },

    'GET /api/invoices/file': ({ query }) => {
      const id = intId(query.get('id'));
      if (id == null) return [400, { error: 'invalid', fields: { id: 'a file id' } }];
      const f = store.billFile(id);
      if (!f) return [404, { error: 'not found' }];
      let buf;
      try {
        buf = fs.readFileSync(fileOf(f));
      } catch {
        return [404, { error: 'not found' }];
      }
      return [200, buf, {
        'content-type': MIME[f.kind],
        'content-disposition': `inline; filename="factura-${f.id}.${EXT[f.kind]}"`,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
        'cache-control': 'private, no-store',
      }];
    },
  };

  return {
    routes,
    start() {
      started = true;
      store.requeueProcessing();
      pump();
    },
    stop() {
      started = false;
    },
    idle,
    waitFor,
    deleteGroup,
    deleteAll,
  };
}
