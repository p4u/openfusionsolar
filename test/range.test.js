process.env.TZ = 'Europe/Madrid';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, parseRange, rangeParams, stepRange, customFromZoom, rangeLabel } from '../public/js/range.js';

const ctx = { today: '2026-11-19', firstDay: '2025-03-10' };
const P = (o) => new URLSearchParams(o);

test('presets resolve to days', () => {
  assert.deepEqual(PRESETS, ['today', 'yesterday', '7d', '30d', 'month', 'year', 'all', 'custom']);
  const m = parseRange(P({ r: 'month', d: '2026-10' }), ctx);
  assert.deepEqual([m.from, m.to, m.days, m.d], ['2026-10-01', '2026-10-31', 31, '2026-10']);
  const cur = parseRange(P({ r: 'month' }), ctx);
  assert.deepEqual([cur.from, cur.to, cur.d], ['2026-11-01', '2026-11-19', '2026-11']);
  const w = parseRange(P({ r: '7d' }), ctx);
  assert.deepEqual([w.from, w.to, w.days], ['2026-11-13', '2026-11-19', 7]);
  assert.equal(parseRange(P({ r: 'all' }), ctx).from, '2025-03-10');
  assert.equal(parseRange(P({ r: 'yesterday' }), ctx).to, '2026-11-18');
  const y = parseRange(P({ r: 'year', d: '2025' }), ctx);
  assert.deepEqual([y.from, y.to], ['2025-03-10', '2025-12-31']);
  const c = parseRange(P({ r: 'custom', from: '2020-01-01', to: '2030-01-01' }), ctx);
  assert.deepEqual([c.from, c.to], ['2025-03-10', '2026-11-19']);
});

test('invalid params fall back', () => {
  assert.equal(parseRange(P({ r: 'nope' }), ctx).r, 'today');
  assert.equal(parseRange(P({ r: 'nope' }), ctx, '30d').r, '30d');
  assert.equal(parseRange(P({ r: 'custom', from: '2026-02-31', to: '2026-03-01' }), ctx, '7d').r, '7d');
  assert.equal(parseRange(P({ r: 'month', d: '2026-13' }), ctx).d, '2026-11');
  const x = parseRange(P({ cmp: 'zzz', b: '7s' }), ctx);
  assert.deepEqual([x.cmp, x.b], ['none', 'auto']);
  assert.equal(parseRange(P({ r: 'custom', from: '2026-11-10', to: '2026-11-01' }), ctx).from, '2026-11-01');
});

test('stepping month and year and stopping at today', () => {
  const m = parseRange(P({ r: 'month', d: '2026-10' }), ctx);
  assert.equal(stepRange(m, -1, ctx).d, '2026-09');
  const next = stepRange(m, 1, ctx);
  assert.deepEqual([next.d, next.to], ['2026-11', '2026-11-19']);
  assert.equal(stepRange(next, 1, ctx), null);
  const touch = stepRange(parseRange(P({ r: 'month', d: '2025-04' }), ctx), -1, ctx);
  assert.deepEqual([touch.d, touch.from], ['2025-03', '2025-03-10'], 'a month that touches firstDay is allowed and clamped');
  assert.equal(stepRange(parseRange(P({ r: 'month', d: '2025-03' }), ctx), -1, ctx), null);
  const y = parseRange(P({ r: 'year', d: '2025' }), ctx);
  assert.equal(stepRange(y, 1, ctx).d, '2026');
  assert.equal(stepRange(y, -1, ctx), null);
  assert.equal(stepRange(parseRange(P({ r: 'year' }), ctx), 1, ctx), null);
  const t = parseRange(P({ r: 'today' }), ctx);
  assert.equal(stepRange(t, 1, ctx), null);
  assert.equal(stepRange(t, -1, ctx).r, 'yesterday');
  const d2 = stepRange(stepRange(t, -1, ctx), -1, ctx);
  assert.deepEqual([d2.r, d2.from, d2.to], ['custom', '2026-11-17', '2026-11-17']);
  const w = stepRange(parseRange(P({ r: '7d' }), ctx), -1, ctx);
  assert.deepEqual([w.from, w.to], ['2026-11-06', '2026-11-12']);
  assert.equal(stepRange(parseRange(P({ r: '7d' }), ctx), 1, ctx), null);
  assert.equal(stepRange(parseRange(P({ r: 'all' }), ctx), -1, ctx), null);
});

test('custom from zoom covers the dragged days', () => {
  const z = customFromZoom(new Date(2026, 9, 3, 22, 30).getTime(), new Date(2026, 9, 5, 1, 5).getTime());
  assert.deepEqual(z, { r: 'custom', from: '2026-10-03', to: '2026-10-05' });
  assert.deepEqual(customFromZoom(Date.UTC(2026, 0, 2, 12), Date.UTC(2026, 0, 1, 12), (ms) => new Date(ms).toISOString().slice(0, 10)),
    { r: 'custom', from: '2026-01-01', to: '2026-01-02' });
  assert.equal(rangeLabel(parseRange(P({ r: 'month', d: '2026-10' }), ctx), 'en-GB'), 'October 2026');
});

test('params round-trip without defaults', () => {
  const plain = parseRange(P({ r: '30d' }), ctx);
  assert.deepEqual(rangeParams(plain), { r: '30d', d: null, from: null, to: null, cmp: null, b: null });
  for (const q of [{ r: 'month', d: '2026-10', cmp: 'yoy' }, { r: 'custom', from: '2026-10-01', to: '2026-10-09', b: '1h', cmp: 'prev' }, { r: 'year', d: '2025' }]) {
    const a = parseRange(P(q), ctx);
    const patch = Object.fromEntries(Object.entries(rangeParams(a)).filter(([, v]) => v != null));
    assert.deepEqual(parseRange(P(patch), ctx), a);
    assert.equal(patch.cmp === undefined, a.cmp === 'none');
  }
});
