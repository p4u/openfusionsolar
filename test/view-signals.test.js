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

test('with nothing chosen the view shows inverter power and battery charge, from their own devices', async () => {
  const { defaultPicks, phaseLink } = await import('../public/js/views/signals-model.js');
  const devices = [
    { dn: 'B', type: 'Battery', signals: [{ id: 30005, name: 'Charge/Discharge power', unit: 'kW' }, { id: 30007, name: 'Battery SOC', unit: '%' }] },
    { dn: 'D', type: 'Dongle', signals: [] },
    { dn: 'I', type: 'Inverter', signals: [{ id: 30017, name: 'Total input power', unit: 'kW' }, { id: 30014, name: 'Active power', unit: 'kW' }] },
    { dn: 'M', type: 'Power Sensor', signals: [{ id: 3, name: 'Active power', unit: 'W' }, { id: 17, name: 'Active power Pa', unit: 'W' }, { id: 18, name: 'Active power Pb', unit: 'W' }] },
  ];
  assert.deepEqual(defaultPicks(devices), [{ dn: 'I', ids: [30014] }, { dn: 'B', ids: [30007] }]);
  assert.deepEqual(defaultPicks([devices[1]]), []);
  assert.equal(phaseLink(devices), '#/signals?dn=M&ids=17,18');
  assert.equal(phaseLink([devices[0]]), null);
});
