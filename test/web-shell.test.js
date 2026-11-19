// Web shell: the DOM-free parts (route map, sub-navigation, upload grouping, NDJSON reader) and the stub files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, PATHS, PARENT, RANGED } from '../public/js/routes.js';
import { moneyTabs } from '../public/js/ui.js';
import { groupFiles } from '../public/js/upload.js';
import { readNdjson } from '../public/js/api.js';
import { PRESET_TYPES } from '../public/js/chart-presets.js';
import { register, setLang } from '../public/js/i18n.js';
import core from '../public/js/i18n/core.js';

register(core);

test('old #/money opens the summary and forecast keeps the old estimate', () => {
  assert.equal(ROUTES.money, 'billing');
  assert.equal(ROUTES.invoices, 'invoices');
  assert.equal(ROUTES.forecast, 'bill');
  assert.equal(ROUTES.assistant, 'assistant');
  assert.equal(PATHS.bill, 'forecast');
  assert.equal(PATHS.billing, 'money');
  assert.ok(RANGED.has('billing') && RANGED.has('invoices') && RANGED.has('bill'));
});

test('parent routes mark Facturació current', () => {
  assert.deepEqual(PARENT, { invoices: 'billing', bill: 'billing' });
  // the nav rule of app.js: current when the link's route is the view or its parent
  const current = (view) => ['billing', 'bill', 'invoices', 'energy'].filter((r) => r === view || r === PARENT[view]);
  assert.deepEqual(current('invoices'), ['billing', 'invoices']);
  assert.deepEqual(current('bill'), ['billing', 'bill']);
  assert.deepEqual(current('billing'), ['billing']);
});

test('moneyTabs links the three sub-views, carries the range and marks the active one', () => {
  setLang('en');
  const html = moneyTabs('invoices', new URLSearchParams('r=month&x=1'));
  assert.match(html, /class="segmented/);
  assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['#/money?r=month', '#/invoices?r=month', '#/forecast?r=month']);
  assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1);
  assert.match(html, /href="#\/invoices\?r=month" aria-current="page">Bills</);
  assert.match(moneyTabs('bill'), /href="#\/forecast" aria-current="page">Forecast</);
});

test('upload groups split pdfs and keep photos together', () => {
  const pdf = (n) => ({ name: `${n}.pdf`, type: 'application/pdf' });
  const img = (n) => ({ name: `${n}.jpg`, type: 'image/jpeg' });
  const names = (groups) => groups.map((g) => g.map((f) => f.name));
  assert.deepEqual(names(groupFiles([pdf('a'), img('1'), img('2'), pdf('b')])), [['a.pdf'], ['1.jpg', '2.jpg'], ['b.pdf']]);
  assert.deepEqual(names(groupFiles([img('1'), img('2')], { onePerPhoto: true })), [['1.jpg'], ['2.jpg']]);
  const eight = Array.from({ length: 8 }, (_, i) => img(i));
  assert.deepEqual(groupFiles(eight).map((g) => g.length), [6, 2]);
  assert.equal(groupFiles(Array.from({ length: 30 }, (_, i) => pdf(i))).length, 20, 'at most 20 files');
});

test('chatStream parses split ndjson chunks', async () => {
  const enc = new TextEncoder();
  const chunks = ['{"type":"status","text":"a"}\n{"type":"te', 'xt","delta":"hé"}\n\n{"type":"done"}'];
  // the multi-byte character is cut in two bytes between chunks
  const bytes = enc.encode(chunks.join(''));
  const cut = bytes.indexOf(0xc3) + 1;
  const parts = [bytes.slice(0, cut), bytes.slice(cut)];
  const reader = { read: async () => (parts.length ? { done: false, value: parts.shift() } : { done: true }) };
  const events = [];
  await readNdjson(reader, (e) => events.push(e));
  assert.deepEqual(events, [{ type: 'status', text: 'a' }, { type: 'text', delta: 'hé' }, { type: 'done' }]);
});

test('the chart preset list is final', () => {
  assert.equal(PRESET_TYPES.length, 9);
  assert.ok(PRESET_TYPES.includes('bill_breakdown') && PRESET_TYPES.includes('savings'));
});
