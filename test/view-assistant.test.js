import { test } from 'node:test';
import assert from 'node:assert/strict';
import dict from '../public/js/i18n/assistant.js';
import { renderSafe, blocksToView, ndjsonError, prefill, statusKey, ERROR_CODES, STATUS_TOOLS } from '../public/js/views/assistant-model.js';
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
