import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dict from '../public/js/i18n/assistant.js';
import { setLang } from '../public/js/i18n.js';
import { setTimeZone } from '../public/js/format.js';
import { renderSafe, blocksToView, ndjsonError, prefill, statusKey, answered, figureModel, ERROR_CODES, STATUS_TOOLS, FIGURE_KINDS } from '../public/js/views/assistant-model.js';
import { blocksToView as blocksToViewV1 } from './fixtures/assistant-model-v1.js';
import { TOOL_NAMES } from '../src/assistant-tools.js';

test('renderSafe escapes html and keeps only paragraphs, bold and lists', () => {
  const html = renderSafe('Hola <img src=x onerror=alert(1)>\n**Total**: 59,15 €\n\n- energia\n- potència\n\n1. primer\n2. segon\n\n[a](http://x) <script>x</script>');
  assert.equal(html, '<p>Hola &lt;img src=x onerror=alert(1)&gt;<br><strong>Total</strong>: 59,15 €</p>'
    + '<ul><li>energia</li><li>potència</li></ul><ol><li>primer</li><li>segon</li></ol>'
    + '<p>[a](http://x) &lt;script&gt;x&lt;/script&gt;</p>');
  const tags = [...renderSafe('<b>x</b> ![i](http://x/i.png) "q" \'s\' & **b** ### h').matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)].sort(), ['p', 'strong']);
  assert.equal(renderSafe('### Resum\ntext'), '<p><strong>Resum</strong></p><p>text</p>');
  assert.equal(renderSafe('- a\n  b\nc'), '<ul><li>a b</li></ul><p>c</p>');
  assert.equal(renderSafe(''), '');
  assert.equal(renderSafe(null), '');
});

test('stored and streamed blocks become view items; unknown or malformed blocks are dropped', () => {
  const chart = { type: 'bill_breakdown', from: '2026-01-01', to: '2026-10-31' };
  const view = blocksToView({ role: 'assistant', blocks: [
    { type: 'invoice', id: 7, period: { from: '2026-09-01', to: '2026-09-30' }, total: 59.15, status: 'confirmed' },
    { type: 'chart', chart },
    { type: 'tool_call', name: 'get_invoice' },
    { type: 'invoice', id: '7' },
    { type: 'text', text: '**Hola** <b>' },
  ] });
  assert.equal(view.role, 'assistant');
  assert.deepEqual(view.items.map((i) => i.kind), ['invoice', 'chart', 'text']);
  assert.equal(view.items[1].chart, chart);
  assert.equal(view.items[2].html, '<p><strong>Hola</strong> &lt;b&gt;</p>');
  const asked = blocksToView({ role: 'user', blocks: [{ type: 'text', text: '<i>raw</i>' }] });
  assert.deepEqual(asked, { role: 'user', items: [{ kind: 'question', text: '<i>raw</i>' }] });
  assert.deepEqual(blocksToView(null), { role: 'assistant', items: [] });
});

test('every stream error code has a message in both languages', () => {
  // preflight F22: stream codes, then the HTTP errors before the stream
  for (const code of ['internal', 'budget', 'rate_limited', 'timeout', 'upstream', 'bad_response', 'too_many_rounds', 'invalid', 'ai_disabled']) {
    assert.ok(ERROR_CODES.includes(code), code);
  }
  for (const code of ERROR_CODES) {
    for (const lang of ['ca', 'en']) {
      assert.equal(typeof dict[lang][`assistant.err.${code}`], 'string', `${lang} ${code}`);
      const text = ndjsonError(code, lang);
      assert.equal(text, dict[lang][`assistant.err.${code}`]);
      assert.doesNotMatch(text, /assistant\.|\{/);
    }
  }
  assert.equal(ndjsonError('something_new', 'ca'), dict.ca['assistant.err.internal']);
  assert.equal(ndjsonError('rate_limited', 'ca', { retryAfter: 2 }), 'Massa preguntes seguides. Torna-ho a provar d’aquí a 2\u00a0s.');
  assert.equal(ndjsonError('rate_limited', 'en', { retryAfter: 125 }), 'Too many questions in a row. Try again in 3\u00a0min.');
});

test('every tool the server can name has a status line in both languages', () => {
  for (const tool of [...TOOL_NAMES, 'reading_bill']) assert.ok(STATUS_TOOLS.includes(tool), tool);
  for (const tool of STATUS_TOOLS) for (const lang of ['ca', 'en']) assert.equal(typeof dict[lang][statusKey(tool)], 'string', `${lang} ${tool}`);
  assert.equal(statusKey('rm -rf'), 'assistant.status.thinking');
});

test('prefill reads q and invoice from params', () => {
  assert.deepEqual(prefill(new URLSearchParams('q=Quadra%20la%20factura%3F&invoice=12')), { text: 'Quadra la factura?', invoiceId: 12 });
  assert.deepEqual(prefill(new URLSearchParams('q=%20%20')), { text: '', invoiceId: null });
  for (const bad of ['0', '-3', '1.5', 'abc', '12abc', '']) assert.equal(prefill(new URLSearchParams(`invoice=${bad}`)).invoiceId, null, bad);
  assert.equal(prefill(new URLSearchParams(`q=${'a'.repeat(5000)}`)).text.length, 4000);
  assert.deepEqual(prefill(new URLSearchParams('')), { text: '', invoiceId: null });
});

test('suggested questions are the same number in both languages', () => {
  assert.ok(Array.isArray(dict.ca['assistant.suggest']) && dict.ca['assistant.suggest'].length >= 4);
  assert.equal(dict.ca['assistant.suggest'].length, dict.en['assistant.suggest'].length);
});

test('busy has its own message', () => {
  assert.equal(ndjsonError('busy', 'ca'), 'L’assistent està responent una altra pregunta.');
  assert.notEqual(ndjsonError('busy', 'en'), ndjsonError('rate_limited', 'en'));
  for (const tool of ['query_data', 'draw_chart', 'read_guide', 'web_search', 'read_web_page', 'calculate', 'ask_user', 'checking']) assert.ok(STATUS_TOOLS.includes(tool), tool);
});

// ---------- figure, choice and sources (spec 3.3-3.5) ----------

const figure = (extra = {}) => ({
  type: 'figure', kind: 'bar', title: 'Consum', x: { type: 'month', values: ['2026-01', '2026-02'] },
  series: [{ label: 'Casa', values: [10.5, null] }], unit: 'kWh', source: ['measured', 'nope'], notes: 'Nota', query: { metrics: ['load_kwh'] }, ...extra,
});
const one = (b) => blocksToView({ role: 'assistant', blocks: [b] }).items;

test('figure, choice and sources blocks become items; a sources url that is not https is dropped', () => {
  const items = blocksToView({ role: 'assistant', blocks: [
    figure(),
    { type: 'choice', options: [' Aquest mes ', 'Aquest any'] },
    { type: 'sources', items: [
      { title: 'REE', url: 'https://www.ree.es/es/datos?x=1' },
      { title: 'plain http', url: 'http://example.com/' },
      { title: 'script', url: 'javascript:alert(1)' },
      { title: 'data', url: 'data:text/html,<b>x</b>' },
      { title: 'bad', url: 'not a url' },
      { title: 'no url' },
      { url: 'https://untitled.example/a' },
      { title: 'Spoof', url: 'https://user:pw@real.example/p', host: 'trusted.example' },
    ] },
  ] }).items;
  assert.deepEqual(items.map((i) => i.kind), ['figure', 'choice', 'sources']);
  assert.deepEqual(items[0].figure, {
    kind: 'bar', title: 'Consum', x: { type: 'month', values: ['2026-01', '2026-02'] }, series: [{ label: 'Casa', values: [10.5, null] }],
    unit: 'kWh', source: ['measured'], notes: 'Nota',
  });
  assert.deepEqual(items[1].options, ['Aquest mes', 'Aquest any']);
  assert.deepEqual(items[2].items, [
    { title: 'REE', url: 'https://www.ree.es/es/datos?x=1', host: 'www.ree.es' },
    { title: 'untitled.example', url: 'https://untitled.example/a', host: 'untitled.example' },
    { title: 'Spoof', url: 'https://user:pw@real.example/p', host: 'real.example' },
  ]);
  // malformed blocks are dropped whole
  const long = Array.from({ length: 751 }, (_, i) => i);
  for (const bad of [
    figure({ kind: 'pie' }), figure({ title: 3 }), figure({ x: { type: 'week', values: ['2026-01'] } }), figure({ x: { type: 'month', values: [] } }),
    figure({ x: { type: 'month', values: ['2026-01', 'enero'] } }), figure({ x: { type: 'hour_of_day', values: [0, 24] } }),
    figure({ x: { type: 'time', values: long }, series: [{ label: 'a', values: long }] }),
    figure({ series: [{ label: 'a', values: [1] }] }), figure({ series: [{ label: 'a', values: [1, '2'] }] }), figure({ series: [{ values: [1, 2] }] }),
    figure({ series: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, values: [1, 2] })) }), figure({ series: [] }),
    { type: 'choice', options: ['only one'] }, { type: 'choice', options: ['a', 'b', 'c', 'd', 'e'] }, { type: 'choice', options: ['a', 'x'.repeat(61)] },
    { type: 'choice', options: ['a', 2] }, { type: 'choice', options: ['a', '  '] }, { type: 'choice' },
    { type: 'sources', items: [{ title: 'x', url: 'http://x.example/' }] }, { type: 'sources' },
  ]) assert.deepEqual(one(bad), [], JSON.stringify(bad).slice(0, 80));
});

test('figureModel for each kind', () => {
  setLang('en');
  const two = { series: [{ label: 'Casa', values: [1, 2] }, { label: 'Xarxa', values: [3, null] }] };
  const model = (extra) => figureModel(one(figure(extra))[0].figure);

  const bar = model(two);
  assert.equal(bar.spec.kind, 'category');
  assert.equal(bar.spec.unit, 'kWh');
  assert.equal(bar.spec.stacked, false);
  assert.deepEqual(bar.spec.series.map((s) => [s.key, s.name, s.type, s.entity]), [['s0', 'Casa', 'bar', 'sun'], ['s1', 'Xarxa', 'bar', 'home']]);
  assert.deepEqual(bar.spec.series[1].data, [3, null]);
  assert.deepEqual(bar.spec.x.categories, ['Jan', 'Feb']);
  assert.equal(bar.spec.x.title, '2026');
  assert.deepEqual(bar.columns, ['Month', { label: 'Casa', unit: 'kWh', decimals: 1 }, { label: 'Xarxa', unit: 'kWh', decimals: 1 }]);
  assert.deepEqual(bar.rows, [['January 2026', 1, 3], ['February 2026', 2, null]]);
  assert.deepEqual(bar.iso, ['2026-01', '2026-02']);
  assert.equal(bar.caption, 'Measured by the installation. Nota');
  assert.equal(bar.title, 'Consum');
  assert.equal(bar.id, 'figure-consum');

  assert.equal(model({ ...two, kind: 'stacked_bar' }).spec.stacked, true);
  assert.equal(model({ ...two, kind: 'stacked_bar' }).spec.series[0].type, 'bar');
  assert.equal(model({ kind: 'line' }).spec.series[0].type, 'line');
  assert.equal(model({ kind: 'area' }).spec.series[0].type, 'area');
  const scatter = model({ kind: 'scatter' }).spec.series[0];
  assert.deepEqual([scatter.type, scatter.width, scatter.markers], ['line', 0, true]);

  const donut = model({ ...two, kind: 'donut' }).spec;
  assert.equal(donut.kind, 'donut');
  assert.deepEqual(donut.series.map((s) => [s.name, s.data]), [['Casa', [3]], ['Xarxa', [3]]]);

  const heat = model({ ...two, kind: 'heatmap', x: { type: 'weekday', values: [1, 7] } });
  assert.equal(heat.spec.kind, 'heatmap');
  assert.deepEqual(heat.spec.x.categories, ['Mon', 'Sun']);
  assert.deepEqual(heat.spec.series.map((s) => [s.name, s.entity, s.data]), [['Casa', 'sun', [1, 2]], ['Xarxa', 'sun', [3, null]]]);
  assert.deepEqual(heat.rows.map((r) => r[0]), ['Monday', 'Sunday']);
  assert.equal(heat.spec.x.label(1), 'Sunday');

  const hours = model({ x: { type: 'hour_of_day', values: [0, 13, 23] }, series: [{ label: 'Casa', values: [1, 2, 3] }], unit: '€', source: ['estimate', 'bills', 'ree'], notes: null });
  assert.deepEqual(hours.spec.x.categories, ['00 h', '13 h', '23 h']);
  assert.deepEqual(hours.columns, ['Hour', { label: 'Casa', unit: '€', decimals: 2 }]);
  assert.equal(hours.caption, 'Estimated with your prices. From your bills. Market prices from Red Eléctrica (REE).');
  assert.deepEqual(model({ x: { type: 'month_of_year', values: [1, 12] } }).spec.x.categories, ['Jan', 'Dec']);
  assert.deepEqual(model({ x: { type: 'day', values: ['2026-03-09', '2026-03-10'] } }).spec.x.categories, ['9', '10']);
  assert.deepEqual(model({ x: { type: 'year', values: ['2025', '2026'] } }).spec.x.categories, ['2025', '2026']);
  assert.deepEqual(model({ x: { type: 'bill', values: ['2026-01', '2026-02'] } }).spec.x.categories, ['Jan', 'Feb']);
  // a second bill of one month is keyed `YYYY-MM (2)` by the server (gate F1): drawn, not dropped
  const twoBills = { type: 'figure', kind: 'bar', title: 't', x: { type: 'bill', values: ['2026-10', '2026-10 (2)'] }, series: [{ label: 'a', values: [1, 2] }], unit: '€', source: ['bills'] };
  for (const kind of FIGURE_KINDS) assert.equal(one({ ...twoBills, kind }).length, 1, kind);
  const billRows = figureModel(one(twoBills)[0].figure);
  assert.equal(billRows.rows.length, 2);
  assert.notEqual(billRows.rows[0][0], billRows.rows[1][0]);
  assert.deepEqual(billRows.spec.x.categories, ['Oct', 'Oct (2)']);
  assert.deepEqual(billRows.iso, ['2026-10', '2026-10 (2)']);
  assert.equal(one({ ...twoBills, x: { type: 'bill', values: ['2026-10', '2026-10 (x)'] } }).length, 0);

  setTimeZone('Europe/Madrid');
  const t0 = Date.UTC(2026, 9, 14, 10);
  const time = model({ kind: 'line', x: { type: 'time', values: [t0, t0 + 3600e3] }, unit: 'kW' });
  assert.equal(time.spec.kind, 'time');
  assert.deepEqual(time.spec.series[0].data, [[t0, 10.5], [t0 + 3600e3, null]]);
  assert.deepEqual([time.spec.x.min, time.spec.x.max], [t0, t0 + 7200e3]);
  assert.deepEqual(time.iso, ['2026-10-14T12:00', '2026-10-14T13:00']);
  assert.equal(time.spec.y.decimals, 2);
  setTimeZone(null);
  for (const kind of FIGURE_KINDS) assert.equal(model({ ...two, kind }).spec.series.length, 2, kind);

  // a label that ends with its unit loses it, so the table header is not "Estalvi diari (€) (€)" (fix-2 D8)
  const own = model({ unit: '€', series: [{ label: 'Estalvi diari (€)', values: [1, 2] }, { label: 'Cost [€]', values: [1, 2] }, { label: 'Casa (kWh)', values: [1, 2] }, { label: '(€)', values: [1, 2] }] });
  assert.deepEqual(own.columns.slice(1).map((c) => c.label), ['Estalvi diari', 'Cost', 'Casa (kWh)', '(€)']);
  assert.deepEqual(own.spec.series.map((s) => s.name), ['Estalvi diari', 'Cost', 'Casa (kWh)', '(€)']);
});

test('answered marks a choice followed by a user message', () => {
  const ask = { role: 'assistant', blocks: [{ type: 'text', text: 'Quin període?' }, { type: 'choice', options: ['Aquest mes', 'Aquest any'] }] };
  const user = { role: 'user', blocks: [{ type: 'text', text: 'Aquest mes' }] };
  const reply = { role: 'assistant', blocks: [{ type: 'text', text: 'D’acord' }] };
  assert.deepEqual([...answered([user, ask, user, reply, ask])], [1]);
  assert.deepEqual([...answered([ask])], []);
  assert.deepEqual([...answered([ask, reply])], []);
  assert.deepEqual([...answered(null)], []);
});

test('no history.replaceState(null in public/js', () => {
  // the overlay helper keeps its marker in history.state: every replaceState passes it on (preflight F6)
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('history.replaceState(null')) hits.push(p);
    }
  })(fileURLToPath(new URL('../public/js/', import.meta.url)));
  assert.deepEqual(hits, []);
});

test('every modal dialog opens through overlay(): no showModal() outside ui.js', () => {
  // Android back closes the top overlay first (spec 4.3): the conversations sheet too (Task 11)
  const dir = fileURLToPath(new URL('../public/js/', import.meta.url));
  const hits = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js') && f !== 'ui.js')
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('.showModal('));
  assert.deepEqual(hits, []);
});

test('the old blocksToView drops figure, choice and sources without throwing', () => {
  const view = blocksToViewV1({ role: 'assistant', blocks: [
    figure(), { type: 'choice', options: ['a', 'b'] }, { type: 'sources', items: [{ title: 'x', url: 'https://x.example/' }] }, { type: 'text', text: 'Fet' },
  ] });
  assert.deepEqual(view.items.map((i) => i.kind), ['text']);
});

test('a stored pre-change conversation gives the same items as before', () => {
  const messages = [
    { role: 'user', blocks: [{ type: 'text', text: 'Quant vaig pagar al setembre?' }] },
    { role: 'assistant', blocks: [
      { type: 'invoice', id: 7, period: { from: '2026-09-01', to: '2026-09-30' }, total: 59.15, status: 'confirmed' },
      { type: 'chart', chart: { type: 'bill_breakdown', from: '2026-01-01', to: '2026-10-31' } },
      { type: 'tool_call', name: 'get_invoice' },
      { type: 'text', text: '**59,15 €** <b>' },
    ] },
    { role: 'user', blocks: [{ type: 'text', text: '<i>i l’agost?</i>' }] },
    { role: 'assistant', blocks: [] },
  ];
  for (const m of messages) assert.deepEqual(blocksToView(m), blocksToViewV1(m));
  assert.deepEqual([...answered(messages)], []);
});
