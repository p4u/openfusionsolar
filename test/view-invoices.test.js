process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dict from '../public/js/i18n/invoices.js';
import { INVOICE_COLS } from '../src/db.js';
import { normalise, toRow } from '../src/invoice-schema.js';
import {
  plainWords, queueState, fieldGroups, stateLabel, parseField, missingText, sumText, uploadErrorKey, ofMonth, say,
  lineCells, readingText, coverageState, failedChecks,
} from '../public/js/views/invoices-model.js';

const { row: sample } = toRow(normalise(JSON.parse(readFileSync(new URL('./fixtures/bills/sample-v1.json', import.meta.url)))));

test('plain words for the sample name every block with its euros and add up to the total', () => {
  for (const lang of ['ca', 'en']) {
    const w = plainWords(sample, lang);
    const ids = w.parts.map((p) => p.id);
    for (const id of ['fixed', 'energy', 'taxes']) assert.ok(ids.includes(id), `${lang} ${id}`);
    if (sample.adjust_eur) assert.ok(ids.includes('adjust'));
    if (sample.surplus_eur) assert.ok(ids.includes('surplus'));
    assert.equal(w.sum, Math.round(sample.total_eur * 100) / 100, `${lang}: the blocks add up to the total`);
    for (const p of w.parts) assert.match(p.text, /\d/, 'every sentence carries its euros');
  }
  const zero = plainWords({ ...sample, surplus_lost_eur: 0 }, 'ca');
  assert.match(zero.parts.find((p) => p.id === 'surplus').text, /No es perd cap excedent/);
});

const keysOk = (key) => assert.ok(dict.ca[key] && dict.en[key], `missing text ${key}`);

test('queue states map every extraction status and error code to a message', () => {
  const cases = [
    [{ status: 'queued' }, 'queued'], [{ status: 'processing' }, 'processing'],
    [{ status: 'done', badge: 'auto' }, 'checked'], [{ status: 'done', badge: 'confirmed' }, 'checked'],
    [{ status: 'done', badge: 'review' }, 'review'], [{ status: 'done', duplicateOf: 3 }, 'duplicate'],
    [{ status: 'not_a_bill' }, 'notBill'],
    [{ status: 'failed', error: 'ai_disabled' }, 'aiOff'], [{ status: 'failed', error: 'budget' }, 'budget'],
    [{ status: 'failed', error: 'rate_limited' }, 'rate'], [{ status: 'failed', error: 'heic_unsupported' }, 'heic'],
    [{ status: 'failed', error: 'invalid_json' }, 'error'], [{ status: 'failed', error: 'no_files' }, 'error'], [{ status: 'failed' }, 'error'],
  ];
  for (const [upload, key] of cases) {
    const s = queueState(upload);
    assert.equal(s.key, `invoices.q.${key}`, JSON.stringify(upload));
    keysOk(s.key);
  }
  assert.equal(queueState({ status: 'failed', error: 'rate_limited' }).retry, true);
  assert.equal(queueState({ status: 'failed', error: 'ai_disabled' }).manual, true);
  assert.equal(queueState({ status: 'failed', error: 'ai_disabled' }).retry, false);
  for (const code of ['too_large', 'body too large', 'too_many_pages', 'unsupported_type', 'duplicate_file', 'too_many_files', 'pdf_alone',
    'too_many_images', 'group_closed', 'rate_limited', 'budget', 'ai_disabled', 'heic_unsupported', 'HTTP 500', undefined]) keysOk(uploadErrorKey(code));
  assert.equal(uploadErrorKey('too_many_pages', 413), 'invoices.err.too_many_pages');
  assert.equal(uploadErrorKey('HTTP 413', 413), 'invoices.err.too_large'); // R4: any other 413 is "too large"
  assert.equal(uploadErrorKey('x', 413), 'invoices.err.too_large');
  assert.equal(ofMonth('2025-10', 'ca'), 'd’octubre');
  assert.equal(ofMonth('2025-05', 'ca'), 'de maig');
});

test('field parsing accepts 0,249 and rejects 1.2.3', () => {
  assert.deepEqual(parseField('price_p1', '0,249'), { value: 0.249 });
  assert.deepEqual(parseField('price_p1', '0.249'), { value: 0.249 });
  assert.deepEqual(parseField('total_eur', '1.234,56'), { value: 1234.56 });
  assert.deepEqual(parseField('total_eur', ' '), { value: null });
  assert.equal(parseField('price_p1', '1.2.3').error, 'number');
  assert.equal(parseField('price_p1', 'abc').error, 'number');
  assert.equal(parseField('days', '31').value, 31);
  assert.equal(parseField('days', '3,5').error, 'int');
  assert.equal(parseField('period_from', '2026-02-30').error, undefined); // the server validates calendar dates
  assert.equal(parseField('period_from', '3/4/2026').error, 'date');
  assert.deepEqual(parseField('self_consumption', 'yes'), { value: true });
  assert.deepEqual(parseField('invoice_number', '  A-1 '), { value: 'A-1' });
});

test('missing months read naturally in both languages', () => {
  assert.equal(missingText(['2026-05', '2026-06'], 'ca'), 'maig i juny de 2026');
  assert.equal(missingText(['2026-05', '2026-06'], 'en'), 'May and June 2026');
  assert.equal(missingText(['2026-05'], 'ca'), 'maig de 2026');
  assert.equal(missingText(['2025-11', '2025-12', '2026-01'], 'ca'), 'novembre i desembre de 2025, gener de 2026');
  assert.equal(say('ca', 'invoices.missing', { months: 'maig i juny de 2026' }), 'Et falten: maig i juny de 2026.');
});

test('a failing sum is spelled out in both languages', () => {
  const check = { id: 'H1', outcome: 'fail', op: '+', expected: 8.4, actual: 8.5, terms: [{ col: 'power_eur', value: 3.4 }, { col: 'energy_eur', value: 5 }] };
  const nf = (n) => n.toFixed(2).replace('.', ',');
  assert.equal(sumText(check, nf, 'ca'), 'Potència (3,40) + Total d’energia (5,00) sumen 8,40, però la factura diu 8,50.');
  assert.equal(sumText(check, nf, 'en'), 'Power (3,40) + Energy total (5,00) add up to 8,40, but the bill says 8,50.');
  assert.match(sumText({ ...check, op: null }, nf, 'en'), /does not fit/);
});

test('every field group column exists in the invoice schema', () => {
  const cols = fieldGroups().flatMap((g) => g.fields.map((f) => f.col));
  assert.deepEqual(cols.filter((c) => !INVOICE_COLS.includes(c)), []);
  assert.equal(new Set(cols).size, cols.length);
  for (const c of cols) keysOk(`invoices.col.${c}`);
  for (const s of ['verified', 'unverified', 'suspect', 'missing', 'edited', 'weird']) keysOk(stateLabel(s));
});

test('bill lines and readings read in the reader locale, with money as money', () => {
  assert.deepEqual(lineCells({ quantity: 31, unit: 'days', unit_price: 0.081 }, 'ca'), { qty: '31\u00a0dies', price: '0,081' });
  assert.deepEqual(lineCells({ quantity: 4.4, unit: 'kW', unit_price: 29.934 }, 'ca'), { qty: '4,4\u00a0kW', price: '29,934' });
  assert.equal(lineCells({ quantity: 52.3, unit: 'EUR', unit_price: 0.0511269 }, 'ca').qty, '52,30\u00a0€');
  assert.equal(lineCells({ quantity: 52.3, unit: 'EUR' }, 'en').qty, '€52.30');
  assert.deepEqual(lineCells({ quantity: null, unit: null, unit_price: null }, 'ca'), { qty: '', price: '' });
  assert.equal(readingText({ start_kwh: 2016.92, end_kwh: 2017.87 }, 'ca'), '2.016,92 - 2.017,87\u00a0kWh');
  assert.equal(readingText({ start_kwh: null, end_kwh: null }, 'ca'), '');
});

test('a month is marked missing only when the server lists it', () => {
  const missing = ['2026-05'];
  const measured = ['2026-05', '2026-10'];
  assert.equal(coverageState({ month: '2026-04', state: 'ok' }, missing, measured), 'ok');
  assert.equal(coverageState({ month: '2026-04', state: 'review' }, missing, measured), 'review');
  assert.equal(coverageState({ month: '2026-05', state: 'missing' }, missing, measured), 'missing');
  assert.equal(coverageState({ month: '2026-10', state: 'missing' }, missing, measured), 'pending'); // measured, the bill may still come
  assert.equal(coverageState({ month: '2025-01', state: 'missing' }, missing, measured), 'nodata');
  assert.equal(coverageState({ month: '2025-01', state: 'missing' }, [], undefined), 'nodata'); // older server
  for (const s of ['nodata', 'pending']) keysOk(`invoices.cell.${s}`);
});

test('failing checks of a refused save name their fields in plain words', () => {
  const nf = (n) => n.toFixed(2).replace('.', ',');
  const h1 = { id: 'H1', outcome: 'fail', op: '+', target: 'total_eur', expected: 59.15, actual: 69.15, fields: ['tax_base_eur', 'vat_eur', 'total_eur'],
    terms: [{ col: 'tax_base_eur', value: 48.88 }, { col: 'vat_eur', value: 10.27 }] };
  const h6 = { id: 'H6', outcome: 'fail', fields: ['vat_pct'], terms: [], op: null, expected: null };
  const { notes, byCol } = failedChecks([h1, h6], nf, 'ca');
  assert.deepEqual(notes.map((n) => n.col), ['total_eur', 'vat_pct']);
  assert.match(notes[0].text, /^El total hauria de ser la base imposable/);
  assert.match(notes[0].text, /sumen 59,15, però la factura diu 69,15\.$/);
  assert.equal(byCol.tax_base_eur, 'total_eur');
  assert.equal(byCol.vat_pct, 'vat_pct');
  assert.match(failedChecks([{ id: 'X9', fields: ['days'] }], nf, 'en').notes[0].text, /does not fit/);
  assert.deepEqual(failedChecks(undefined, nf, 'en'), { notes: [], byCol: {} });
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) keysOk(`invoices.check.${id}`);
});

test('the days field has no unit repeating its label', () => {
  assert.equal(fieldGroups()[0].fields.find((x) => x.col === 'days').unit, null);
});
