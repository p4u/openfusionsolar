process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCHEMA_V, BILL_SCHEMA, SYSTEM_PROMPT, normalise, toRow, checks, retryText, fieldStates, maskCups, validCups,
  coverageMonths, missingMonths, measuredMonths, RETRY_PATHS,
} from '../src/invoice-schema.js';

const today = '2026-11-19';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/bills/${name}.json`, import.meta.url)));
const sample = () => toRow(normalise(fixture('sample-v1')));
const run = (row, opts = {}) => checks(row, { readings: sample().readings, today, ...opts });
const failing = (list) => [...new Set(list.filter((c) => c.outcome === 'fail').map((c) => c.id))].sort();
const outcome = (list, id) => {
  const mine = list.filter((c) => c.id === id);
  return mine.some((c) => c.outcome === 'fail') ? 'fail' : mine.some((c) => c.outcome === 'missing') ? 'missing' : 'pass';
};

test('the schema is strict and the prompt is the fixed text', () => {
  assert.equal(SCHEMA_V, 2);
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(s.required, Object.keys(s.properties));
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  walk(BILL_SCHEMA);
  assert.match(BILL_SCHEMA.properties.energy.properties.total.description, /includes adjust_amount/);
  assert.match(BILL_SCHEMA.properties.surplus.properties.amount.description, /positive/);
  assert.ok(BILL_SCHEMA.properties.charges.properties.other_taxed.description);
  assert.match(BILL_SCHEMA.properties.supply.properties.max_demand_kw.description, /12 months/);
  assert.match(SYSTEM_PROMPT, /^You read Spanish electricity bills \(2\.0TD\)\./);
  assert.match(SYSTEM_PROMPT, /set is_electricity_bill = false and leave the rest null\.$/);
});

test('the golden sample normalises and passes every hard and soft check', () => {
  const raw = fixture('sample-v1');
  // the fixture keeps the model's answer as returned
  assert.equal(raw.surplus.amount, -0.72);
  assert.equal(raw.charges.other_taxed, null);
  assert.equal(raw.surplus.uncompensated_amount, null);
  const bill = normalise(raw);
  assert.equal(bill.surplus.amount, 0.72);
  assert.equal(bill.charges.other_taxed, null);
  assert.equal(bill.surplus.uncompensated_amount, null);
  const { row, lines, readings } = toRow(bill);
  assert.equal(row.total_eur, 59.15);
  assert.deepEqual([row.kwh_p1, row.kwh_p2, row.kwh_p3], [25.704, 29.651, 103.725]);
  assert.equal(row.surplus_p1_kwh + row.surplus_p2_kwh + row.surplus_p3_kwh, 24);
  assert.equal(row.surplus_eur, 0.72);
  assert.deepEqual([row.contracted_p1_kw, row.contracted_p2_kw], [4.4, 4.4]);
  assert.equal(row.days, 31);
  assert.equal(row.energy_eur, 31.59);
  assert.equal(row.vat_pct, 21);
  assert.equal(row.elec_tax_pct, 5.11269);
  assert.equal(row.self_consumption, 1);
  assert.equal(lines.length, 12);
  assert.equal(readings.length, 6);
  const list = checks(row, { lines, readings, today });
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'S1', 'S2', 'S3', 'S4', 'S6']) {
    assert.ok(list.some((c) => c.id === id), `${id} ran`);
  }
  assert.deepEqual(list.filter((c) => c.outcome !== 'pass').map((c) => `${c.id} ${c.outcome}`), []);
  assert.equal(retryText(list), '');
});

test('several VAT lines: summed base and VAT, the largest base gives the rate, H2 checks each line', () => {
  const bill = normalise(fixture('sample-v1'));
  bill.totals = { ...bill.totals, tax_base: 24.56, vat_pct: null, vat: 2.05,
    vat_rates: [{ pct: 21, base: -1.94, amount: -0.41 }, { pct: 10, base: 24.56, amount: 2.46 }] };
  const { row } = toRow(bill);
  assert.deepEqual([row.tax_base_eur, row.vat_eur, row.vat_pct], [22.62, 2.05, 10]);
  assert.equal(JSON.parse(row.vat_rates).length, 2);
  assert.equal(outcome(checks(row, { today }), 'H2'), 'pass');
  const bad = { ...row, vat_rates: JSON.stringify([{ pct: 21, base: -1.94, amount: -0.41 }, { pct: 10, base: 24.56, amount: 2.86 }]) };
  assert.equal(outcome(checks(bad, { today }), 'H2'), 'fail');
  // every VAT line's rate is one of the Spanish rates, not only the largest
  const odd = { ...row, vat_rates: JSON.stringify([{ pct: 10, base: 100, amount: 10 }, { pct: 99, base: 10, amount: 9.9 }]), tax_base_eur: 110, vat_eur: 19.9 };
  assert.equal(outcome(checks(odd, { today }), 'H6'), 'fail');
  // one VAT line fills what the model left empty; it is not kept
  bill.totals = { tax_base: null, vat_pct: null, vat: null, total: 59.15, vat_rates: [{ pct: 21, base: 47.57, amount: 9.99 }] };
  const single = toRow(bill).row;
  assert.deepEqual([single.tax_base_eur, single.vat_eur, single.vat_pct, single.vat_rates], [47.57, 9.99, 21, null]);
});

test('a discount after VAT joins the exempt concepts; a surplus valuation given with a cap becomes the discount applied', () => {
  const bill = normalise({ ...fixture('sample-v1'), charges: { ...fixture('sample-v1').charges, other_exempt: 0.35, discount_after_vat: 2.02 } });
  assert.equal(toRow(bill).row.other_exempt_eur, -1.67);
  // sample surplus: 24 kWh × 0.03 = 0.72 valued; 0.30 left uncompensated by the cap
  const capped = normalise(fixture('sample-v1'));
  capped.surplus = { ...capped.surplus, amount: 0.72, uncompensated_amount: 0.3 };
  const { row } = toRow(capped);
  assert.equal(row.surplus_eur, 0.42);
  assert.equal(outcome(checks(row, { today }).filter((c) => c.op === '×' || c.id !== 'S2'), 'S2'), 'pass');
  capped.surplus.amount = 0.42; // already the discount applied: left as printed
  assert.equal(toRow(capped).row.surplus_eur, 0.42);
  // a small cap already split (0.70 + 0.02 = 0.72) is not subtracted again
  capped.surplus = { ...capped.surplus, amount: 0.7, uncompensated_amount: 0.02 };
  assert.equal(toRow(capped).row.surplus_eur, 0.7);
  // editing only the uncompensated amount fails S2 and names that field
  const { row: split } = toRow({ ...capped, surplus: { ...capped.surplus, amount: 0.42, uncompensated_amount: 0.3 } });
  const s2 = checks({ ...split, surplus_lost_eur: 0.5 }, { today }).find((c) => c.id === 'S2' && c.op === '×');
  assert.equal(s2.outcome, 'fail');
  assert.ok(s2.fields.includes('surplus_lost_eur'));
});

test('mutating one figure fails the right check and marks the field suspect', () => {
  const cases = [
    ['kwh_p1', 27.704, ['H4'], 'kwh_p1'],
    ['vat_eur', 8.99, ['H1', 'H2'], 'vat_eur'],
    ['tax_base_eur', 48.57, ['H1', 'H2', 'H3'], 'tax_base_eur'],
    ['total_eur', 60.15, ['H1'], 'total_eur'],
    ['period_to', '2026-11-01', [], 'period_from'], // days = to - from: passes, period_from flagged
    ['period_to', '2026-10-30', ['H5'], 'period_to'],
    ['vat_pct', 7, ['H2', 'H6'], 'vat_pct'],
    ['cups', 'ES0031000000000001BK0F', ['S4'], 'cups'],
  ];
  for (const [col, value, ids, suspect] of cases) {
    const row = { ...sample().row, [col]: value };
    const list = run(row);
    assert.deepEqual(failing(list), ids, `${col} = ${value}`);
    assert.equal(fieldStates(row, list)[suspect], 'suspect', `${suspect} after ${col} = ${value}`);
  }
  // a wrong CUPS letter is soft: every hard check still passes, so the bill is auto-confirmable
  const list = run({ ...sample().row, cups: 'ES0031000000000001BK0F' });
  assert.ok(list.filter((c) => c.hard).every((c) => c.outcome === 'pass'));
  // the shifted end date passes H5 and leaves every other field as it was
  const shifted = run({ ...sample().row, period_to: '2026-11-01' });
  assert.equal(outcome(shifted, 'H5'), 'pass');
  assert.deepEqual(shifted.find((c) => c.id === 'H5').flags, ['period_from']);
});

test('the image answer fails H1 H3 H4 and the retry text names them', () => {
  const { row, readings } = toRow(normalise(fixture('sample-images-v1')));
  const list = checks(row, { readings, today });
  assert.deepEqual(failing(list.filter((c) => c.hard)), ['H1', 'H3', 'H4']);
  const text = retryText(list);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^H1: /);
  assert.match(lines[1], /^H3: /);
  assert.equal(lines[2], 'H4: energy.amount.p1 (6.40) + energy.amount.p2 (5.01) + energy.amount.p3 (15.56) + energy.adjust_amount (4.62) = 31.59, but energy.total is 26.97.');
  assert.match(text, /energy\.total/);
});

test('null operands make a check missing, not passed', () => {
  const cases = [
    ['total_eur', 'H1', 'missing'],
    ['vat_eur', 'H1', 'missing'],
    ['vat_pct', 'H2', 'missing'],
    ['power_eur', 'H3', 'missing'],
    ['energy_eur', 'H4', 'missing'],
    ['other_taxed_eur', 'H3', 'pass'], // optional addends count as 0
    ['other_exempt_eur', 'H1', 'fail'], // 0 instead of 1.59: the sum no longer holds
    ['social_bonus_eur', 'H3', 'fail'],
  ];
  for (const [col, id, want] of cases) {
    assert.equal(outcome(run({ ...sample().row, [col]: null }), id), want, `${col} null → ${id} ${want}`);
  }
  const noPeriods = { ...sample().row, price_p1: null, price_p2: null, price_p3: null };
  const h4 = run(noPeriods).filter((c) => c.id === 'H4');
  assert.deepEqual(h4.map((c) => c.outcome), ['missing']);
  assert.ok(!run({ ...sample().row, tax_base_eur: null }).some((c) => c.outcome === 'pass' && ['H1', 'H2', 'H3'].includes(c.id)));
});

test('required fields gate confirmation', () => {
  const h7 = (patch) => run({ ...sample().row, ...patch }).find((c) => c.id === 'H7');
  assert.equal(h7({}).outcome, 'pass');
  assert.deepEqual(h7({ invoice_number: null }), { id: 'H7', hard: true, outcome: 'missing', fields: ['invoice_number'], expected: null, actual: null, terms: [], op: null, target: null });
  assert.equal(h7({ invoice_number: '' }).outcome, 'pass'); // the explicit "no number" marker
  assert.equal(h7({ kwh_p1: 0 }).outcome, 'pass');
  assert.deepEqual(h7({ total_eur: null, kwh_p3: null }).fields, ['total_eur', 'kwh_p3']);
  const row = { ...sample().row, invoice_number: null };
  assert.equal(fieldStates(row, run(row)).invoice_number, 'missing');
});

test('dates: impossible days, from after to, over 100 days and future issue dates fail', () => {
  const raw = fixture('sample-v1');
  raw.invoice.period_to = '2026-02-30';
  raw.invoice.due_date = '19/11/2026';
  const bill = normalise(raw);
  assert.equal(bill.invoice.period_to, null);
  assert.equal(bill.invoice.due_date, null);
  const h5 = (patch) => run({ ...sample().row, ...patch }).find((c) => c.id === 'H5');
  assert.equal(h5({ period_to: null }).outcome, 'missing');
  assert.equal(h5({ period_to: '2026-02-30' }).outcome, 'fail');
  assert.match(h5({ period_to: '2026-02-30' }).reason, /calendar/);
  assert.equal(h5({ period_from: '2026-11-01', days: null }).outcome, 'fail');
  assert.equal(h5({ period_from: '2026-07-01', days: 123 }).outcome, 'fail');
  assert.match(h5({ period_from: '2026-07-01', days: 123 }).reason, /over 100/);
  assert.equal(h5({ issue_date: '2026-11-20' }).outcome, 'fail');
  assert.equal(h5({ issue_date: '2026-10-30' }).outcome, 'fail'); // issued before the period ends
  assert.equal(h5({ period_to: '2026-11-20', days: null, issue_date: '2026-11-20' }).outcome, 'fail');
  assert.equal(h5({ due_date: '2026-12-20' }).outcome, 'pass'); // a due date may be in the future
  assert.equal(h5({ days: 29 }).outcome, 'fail');
});

test('field states follow the precedence', () => {
  const row = { ...sample().row, kwh_p1: 27.704, invoice_number: null };
  const list = run(row);
  const states = fieldStates(row, list, { unreadable: ['supply.tariff'], edits: { total_eur: { from: 59, at: 1 }, energy_p1_eur: { from: 6, at: 1 } } });
  assert.equal(states.total_eur, 'edited'); // edited beats verified
  assert.equal(states.energy_p1_eur, 'edited'); // edited beats suspect
  assert.equal(states.kwh_p1, 'suspect');
  assert.equal(states.price_p1, 'suspect');
  assert.equal(states.tariff, 'suspect'); // unreadable
  assert.equal(states.invoice_number, 'missing');
  assert.equal(states.vat_eur, 'verified');
  assert.equal(states.kwh_p2, 'verified');
  assert.equal(states.supplier, 'unverified');
  assert.deepEqual(Object.keys(states), Object.keys(RETRY_PATHS));
  // a required field that is suspect stays suspect
  assert.equal(fieldStates({ ...row, period_to: null }, list, { unreadable: ['invoice.period_to'] }).period_to, 'suspect');
});

test('cups is masked and validated', () => {
  assert.equal(maskCups('ES0031000000000001BJ0F'), 'ES00...BJ0F');
  assert.equal(maskCups(null), null);
  assert.equal(maskCups(''), null);
  assert.equal(validCups('ES0031000000000001BJ0F'), true);
  assert.equal(validCups('ES0031000000000001BJ'), true);
  assert.equal(validCups('ES0031000000000001BK0F'), false);
  assert.equal(validCups('ES0031000000000001BJOF0'), false);
  assert.equal(validCups('es0031000000000001bj0f'), false);
  assert.equal(validCups(null), false);
});

test('normalise drops unknown keys and fixes types', () => {
  const raw = fixture('sample-v1');
  raw.holder_name = 'X';
  raw.supply.address = 'X';
  raw.lines[0].iban = 'X';
  raw.invoice.kind = 'other';
  raw.lines[0].section = 'tolls';
  raw.lines[0].unit = 'kg';
  raw.energy.amount.p1 = 6.404;
  raw.energy.kwh.p2 = 29.65149;
  raw.totals.vat = '9.99';
  raw.totals.tax_base = Infinity;
  raw.invoice.days = 31.5;
  raw.supplier.name = '  Som Energia, SCCL  ';
  raw.readings.push({ kind: 'net', period: 'p1' }, { ...raw.readings[0], start_kwh: 1 });
  const bill = normalise(raw);
  assert.equal('holder_name' in bill, false);
  assert.equal('address' in bill.supply, false);
  assert.equal('iban' in bill.lines[0], false);
  assert.equal(bill.invoice.kind, 'normal');
  assert.equal(bill.lines[0].section, 'other');
  assert.equal(bill.lines[0].unit, null);
  assert.equal(bill.energy.amount.p1, 6.4);
  assert.equal(bill.energy.kwh.p2, 29.651);
  assert.equal(bill.totals.vat, null);
  assert.equal(bill.totals.tax_base, null);
  assert.equal(bill.invoice.days, null);
  assert.equal(bill.supplier.name, 'Som Energia, SCCL');
  assert.equal(bill.readings.length, 7); // the unknown kind is dropped
  const { readings } = toRow(bill);
  assert.equal(readings.length, 6); // one row per kind and period
  assert.equal(readings[0].start_kwh, 5933.69);
  // anything that is not an object becomes the full shape with nulls
  const empty = normalise('nope');
  assert.equal(empty.is_electricity_bill, false);
  assert.equal(empty.totals.total, null);
  assert.deepEqual(empty.lines, []);
});

test('tax ids and bank accounts inside concepts and notes are removed', () => {
  const raw = fixture('sample-v1');
  raw.lines[0].concept = 'Domiciliació ES12 3456 7890 1234 5678 9012 de 12345678Z';
  raw.notes = `Titular X1234567L, compte ES1234567890123456789012. ${'a'.repeat(400)}`;
  raw.lines[1].concept = 'b'.repeat(200);
  const bill = normalise(raw);
  assert.match(bill.lines[0].concept, /^Domiciliació \[\.\.\.\] ?de \[\.\.\.\]$/);
  assert.match(bill.notes, /^Titular \[\.\.\.\], compte \[\.\.\.\]\. a+$/);
  assert.equal(bill.notes.length, 300);
  assert.equal(bill.lines[1].concept.length, 120);
});

test('the previous bill flags breaks, gaps and jumps as soft warnings', () => {
  const { row, readings } = sample();
  const previous = {
    ...row, period_from: '2026-09-01', period_to: '2026-09-30', price_p1: 0.15,
    readings: readings.map((r) => ({ ...r, end_kwh: r.start_kwh })),
  };
  const ok = run(row, { previous }).find((c) => c.id === 'S5');
  assert.equal(ok.outcome, 'fail'); // only the price jump: 0.15 → 0.249
  assert.deepEqual(ok.fields, ['price_p1']);
  const clean = run(row, { previous: { ...previous, price_p1: row.price_p1 } }).find((c) => c.id === 'S5');
  assert.equal(clean.outcome, 'pass');
  const gap = { ...previous, price_p1: row.price_p1, period_to: '2026-09-20', readings: readings.map((r) => ({ ...r, end_kwh: r.start_kwh - 5 })) };
  const broken = run(row, { previous: gap }).find((c) => c.id === 'S5');
  assert.deepEqual(broken.fields, ['period_from']);
  assert.match(broken.reason, /2026-09-20/);
  assert.match(broken.reason, /import p1 reading/);
  assert.ok(run(row, { previous: gap }).filter((c) => c.hard).every((c) => c.outcome === 'pass'));
});

const bill = (period_from, period_to, extra = {}) => ({ period_from, period_to, status: 'confirmed', superseded_by: null, cups: 'A', ...extra });

// the first 28 days of each month, as measured days
const daysOf = (...months) => months.flatMap((m) => Array.from({ length: 28 }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`));

test('missing months: measured on 15 days or more, no confirmed bill on any of its days, ended over 45 days ago', () => {
  const measured = daysOf('2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10');
  const invoices = [
    bill('2026-03-01', '2026-03-31'), bill('2026-04-01', '2026-04-30'), bill('2026-07-01', '2026-07-31'),
    bill('2026-05-01', '2026-05-31', { status: 'draft' }), // drafts do not fill a gap
    bill('2026-06-01', '2026-06-30', { superseded_by: 9 }),
  ];
  // today - 45 days = 2026-10-05: Aug and Sep are missing, October is not due yet
  assert.deepEqual(missingMonths(invoices, today, measured), ['2026-05', '2026-06', '2026-08', '2026-09']);
  // a bill on any day of a month covers it, whatever its supply: 04-15..05-14 covers May; nothing touches March or June
  const mid = [bill('2026-04-15', '2026-05-14'), bill('2026-07-15', '2026-08-14', { cups: 'B' }), bill('2026-08-15', '2026-09-14'), bill('2026-09-15', '2026-10-14')];
  assert.deepEqual(missingMonths(mid, today, measured), ['2026-03', '2026-06']);
  // a one-day gap between reading dates is not a missing month
  assert.deepEqual(missingMonths([bill('2026-08-01', '2026-08-30'), bill('2026-09-01', '2026-09-30')], '2026-11-10', daysOf('2026-08', '2026-09')), []);
  // fewer than 15 measured days: never missing
  const short = [...daysOf('2026-08'), ...daysOf('2026-09').slice(0, 14), '2026-10-01'];
  assert.deepEqual(measuredMonths(short), ['2026-08']);
  assert.deepEqual(missingMonths([], today, short), ['2026-08']);
  // the month must have ended more than 45 days ago
  assert.deepEqual(missingMonths([], '2026-11-14', daysOf('2026-09')), []);
  assert.deepEqual(missingMonths([], '2026-11-15', daysOf('2026-09')), ['2026-09']);
  assert.deepEqual(missingMonths([], today, []), []);
});

test('coverage marks months under review', () => {
  const invoices = [
    bill('2026-09-01', '2026-09-30'),
    bill('2026-10-01', '2026-10-31', { status: 'draft' }),
    bill('2026-08-01', '2026-08-31', { status: 'draft' }), bill('2026-08-01', '2026-08-31'),
    bill('2026-07-01', '2026-07-31', { superseded_by: 3 }),
    bill('2024-10-01', '2024-10-31'), // older than the strip
  ];
  const cells = coverageMonths(invoices, today);
  assert.equal(cells.length, 24);
  assert.equal(cells[0].month, '2024-12');
  assert.equal(cells[23].month, '2026-11');
  const at = (m) => cells.find((c) => c.month === m).state;
  assert.equal(at('2026-09'), 'ok');
  assert.equal(at('2026-10'), 'review');
  assert.equal(at('2026-08'), 'ok'); // a confirmed bill wins over a draft
  assert.equal(at('2026-07'), 'missing');
  assert.equal(at('2026-11'), 'missing');
  assert.equal(coverageMonths(invoices, today, 3).map((c) => c.month).join(), '2026-09,2026-10,2026-11');
});
