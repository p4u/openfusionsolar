// The calculate tool's parser (spec 3.6 step 8): grounded literals only, no eval, fixed grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, CalcError } from '../src/calc.js';
import { groundedSet } from '../src/grounding.js';

const G = groundedSet(['{"bought":277.8,"exportIncome":12.35,"load":1016,"import":402.6}']);

const OK = [
  ['277.8 - 12.35', 265.45, 265],
  ['(1016 - 402.6) / 1016 * 100', 60.37, 60],
  ['-12.35 + 277.8', 265.45, 265],
  ['277.8 / 12', 23.15, 23],
  ['1016 * 365 / 1000', 370.84, 371],
  ['  277.8*2 ', 555.6, 556],
  ['277.80 - 12.4', 265.4, 265], // a literal rounded the way the tool gave it still counts
];
for (const [expr, value, rounded] of OK) {
  test(`calculate ${expr}`, () => assert.deepEqual(calculate(expr, G), { expr, value, rounded }));
}

const BAD = [
  ['277.8 + 999', /999 is not a figure/],
  ['277,8 + 1', /use a dot/],
  ['277.8 ** 2', /unexpected \*/],
  ['(277.8 - 12.35', /not closed/],
  ['277.8 / (12.35 - 12.35)', /division by zero/],
  ['Math.max(1)', /unexpected character "M"/],
  ['', /non-empty/],
  [`${'1016 + '.repeat(40)}1016`, /too long/],
  ['277.8 12.35', /unexpected 12.35/],
  ['process.exit()', /unexpected character "p"/],
];
for (const [expr, re] of BAD) {
  test(`calculate refuses ${JSON.stringify(expr).slice(0, 40)}`, () => assert.throws(() => calculate(expr, G), (e) => e instanceof CalcError && re.test(e.message)));
}

test('the result rounds to 2 and to 0 decimals without a negative zero', () => {
  assert.deepEqual(calculate('12.35 - 12.35', G), { expr: '12.35 - 12.35', value: 0, rounded: 0 });
  assert.ok(Object.is(calculate('-12.35 + 12.35', G).value, 0));
});
