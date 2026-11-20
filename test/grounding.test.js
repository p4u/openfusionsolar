// Number grounding (spec 3.6, AC4): table-driven. G is built from the strings the model was given this turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundedSet, figures, check, redact, normalise, numbersIn, MARK } from '../src/grounding.js';

const TOOL = JSON.stringify({ total: 1180.73, discount: -12.3, contractedW: 4400, share: 0.31, tax: 5.113,
  timetable: 'P1 (punta) 10-14 and 18-22 h', rows: [[1, 2.5], [2, 3.25]] });
const USER = 'La factura de juny va ser de 87,45 € i em sembla cara.';
const PREVIOUS = 'En total vas comprar 1.016 kWh.'; // the previous answer, as history

const G = groundedSet([ 'You are the assistant...', PREVIOUS, USER, TOOL ]);

const CASES = [
  // [answer (ca), expected ungrounded raws]
  ['El total és 1.180,73 €.', []],
  ['El total és 1180,73 €.', []],
  ['El total és 1.181 €.', []],
  ['Uns 1.200 € en total.', []],
  ['La potència és 4,4 kW.', []],
  ['Un 31 % de l’energia.', []],
  ['L’impost és del 5,11 %.', []],
  ['Un descompte de -12,30 €.', []],
  ['El període punta va de 10 a 14 h.', []],
  ['L’any 2026 ha anat bé.', []],
  ['La tarifa 2.0TD té tres períodes: P1, P2 i P3.', []],
  ['Vas dir que la factura era de 87,45 €.', []],
  ['Com et deia, 1.016 kWh.', []],
  ['El 25 de juliol a les 14:30, el 2026-10-25 i el 3/11/2026.', []],
  ['1. Primer punt\n2. Segon punt', []],
  ['Has pagat 1.234,56 €.', ['1.234,56 €']],
  ['Has comprat 350 kWh.', ['350 kWh']],
  ['Has comprat 2,5 kWh i 3,25 kWh, i 7,77 kWh.', ['7,77 kWh']],
  ['Has comprat **777** kWh.', ['777** kWh']],
  ['Has comprat 777 KWh i 778 kwh.', ['777 KWh', '778 kwh']],
  ['Total **1.180,73** €', []],
];

for (const [answer, expected] of CASES) {
  test(`grounding: ${answer.replace(/\n/g, ' / ')}`, () => {
    assert.deepEqual(check(answer, G, 'ca').map((f) => f.raw), expected);
  });
}

test('english answers read a comma as thousands and a dot as decimal', () => {
  assert.deepEqual(check('You paid 1,180.73 € and 1,181 € rounded, about 1,200 €.', G, 'en').map((f) => f.raw), []);
  assert.deepEqual(check('You paid 1,234.56 €.', G, 'en').map((f) => f.raw), ['1,234.56 €']);
});

test('an invented 350 kWh beside a 60-row dataset is caught', () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`2026-07-${String((i % 31) + 1).padStart(2, '0')}`, Math.round((i + 1) * 10) / 100]);
  const summary = JSON.stringify({ id: 'd1', columns: ['x', 'pv_kwh'], rowCount: 60, rows, stats: { pv_kwh: { min: 0.1, max: 6, sum: 183, mean: 3.05 } } });
  const g = groundedSet([summary]);
  assert.deepEqual(check('Al juliol vas produir 350 kWh.', g, 'ca').map((f) => f.raw), ['350 kWh']);
  assert.deepEqual(check('Al juliol vas produir 183 kWh.', g, 'ca').map((f) => f.raw), []);
});

test('unchecked: small whole numbers without a unit, years, list markers', () => {
  assert.deepEqual(figures('Tens 3 factures del 2025 i 12 mesos', 'ca').map((f) => f.raw), ['12 mesos']);
});

test('normalise turns narrow and no-break spaces into spaces and the minus sign into a hyphen', () => {
  assert.equal(normalise('1 180,73 € −12'), '1 180,73 € -12');
});

test('the grounded set takes numbers inside json strings and both conventions of prose', () => {
  const g = groundedSet(['{"note":"10-14 h","v":-3.5}', 'uns 1.180,73 € i 1,5 kWh']);
  for (const n of [10, 14, 3.5, 1180.73, 1.5]) assert.ok(g.has(n), String(n));
  assert.deepEqual(numbersIn('1,180'), [1.18, 1180]);
});

test('redact puts the placeholder in place of each ungrounded figure and appends one line', () => {
  const answer = 'Has pagat 1.234,56 € i has comprat 350 kWh.';
  const bad = check(answer, G, 'ca');
  const out = redact(answer, bad, 'ca');
  assert.equal(out, `Has pagat ${MARK.ca} i has comprat ${MARK.ca}.\n\nHe tret 2 xifres que no he pogut comprovar amb les dades.`);
  assert.doesNotMatch(out, /1\.234|350/);
  assert.match(redact('You paid 999.99 €.', check('You paid 999.99 €.', G, 'en'), 'en'), /\[unverified figure\]\.\n\nI removed 1 figure I could not check/);
});

test('a negative sign goes with the redacted figure, a range dash does not', () => {
  const bad = check('Saldo -999,99 € i de 10-77 h.', G, 'ca');
  assert.deepEqual(bad.map((f) => f.raw), ['-999,99 €', '77 h']);
});
