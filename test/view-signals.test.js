import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SIGNALS, groupByUnit, parseIds, toggleId } from '../public/js/views/signals-model.js';

const s = (id, unit) => ({ id, unit, name: `s${id}` });

test('signals group by unit in order of first appearance', () => {
  const g = groupByUnit([s(1, 'V'), s(2, 'A'), s(3, 'V'), s(4, undefined)]);
  assert.deepEqual(g.map((x) => [x.unit, x.signals.map((y) => y.id)]), [['V', [1, 3]], ['A', [2]], ['', [4]]]);
  assert.deepEqual(groupByUnit([]), []);
});

test('the selection caps at 6 and ignores unknown or repeated ids', () => {
  const valid = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(parseIds('1,2,2,99,x,3', valid), [1, 2, 3]);
  assert.deepEqual(parseIds('1,2,3,4,5,6,7,8', valid), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseIds(null, valid), []);
  let ids = [];
  for (const id of valid) ids = toggleId(ids, id);
  assert.equal(ids.length, MAX_SIGNALS);
  assert.deepEqual(toggleId(ids, 7), ids);
  assert.deepEqual(toggleId(ids, 1), [2, 3, 4, 5, 6]);
});
