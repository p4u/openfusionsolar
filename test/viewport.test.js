// keyboardState and its wiring (spec 4.1, AC7 iOS path): pure function, then watchViewport over fake window objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardState, watchViewport } from '../public/js/viewport.js';

const CASES = [
  // [name, input, expected]
  ['first reading sets the baseline', { innerHeight: 844, vvHeight: 844, baseline: 0 }, { vvh: 844, open: false, baseline: 844 }],
  ['android keyboard (layout resized too)', { innerHeight: 500, vvHeight: 500, baseline: 844 }, { vvh: 500, open: true, baseline: 844 }],
  ['ios keyboard (layout not resized, viewport scrolled)', { innerHeight: 844, vvHeight: 508, vvOffsetTop: 300, baseline: 844 }, { vvh: 508, open: true, baseline: 844 }],
  ['url bar collapsing is not a keyboard', { innerHeight: 760, vvHeight: 760, baseline: 844 }, { vvh: 760, open: false, baseline: 844 }],
  ['exactly 120 px is not open', { innerHeight: 724, vvHeight: 724, baseline: 844 }, { vvh: 724, open: false, baseline: 844 }],
  ['121 px is open', { innerHeight: 723, vvHeight: 723, baseline: 844 }, { vvh: 723, open: true, baseline: 844 }],
  ['a taller reading raises the baseline', { innerHeight: 900, vvHeight: 900, baseline: 844 }, { vvh: 900, open: false, baseline: 900 }],
];
for (const [name, input, expected] of CASES) test(`keyboardState: ${name}`, () => assert.deepEqual(keyboardState(input), expected));

function fakeWindow({ height = 844, type = 'portrait-primary' } = {}) {
  const vv = Object.assign(new EventTarget(), { height, offsetTop: 0 });
  const classes = new Set();
  const props = {};
  const document = Object.assign(new EventTarget(), {
    documentElement: {
      style: { setProperty: (k, v) => { props[k] = v; } },
      classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    },
  });
  const win = { visualViewport: vv, document, innerHeight: height, screen: { orientation: { type } } };
  const resize = (h) => { vv.height = h; vv.dispatchEvent(new Event('resize')); };
  return { win, vv, classes, props, resize };
}

test('watchViewport sets --vvh, toggles kb-open once per opening and resets on rotation', () => {
  const f = fakeWindow();
  let opened = 0;
  f.win.document.addEventListener('keyboardopen', () => opened++);
  const stop = watchViewport(f.win);
  assert.equal(f.props['--vvh'], '844px');
  f.resize(500);
  assert.ok(f.classes.has('kb-open'));
  f.resize(498);
  assert.equal(opened, 1);
  f.resize(844);
  assert.ok(!f.classes.has('kb-open'));
  f.win.screen.orientation.type = 'landscape-primary';
  f.resize(390); // a landscape phone: 390 is the new baseline, not a keyboard
  assert.ok(!f.classes.has('kb-open'));
  assert.equal(f.props['--vvh'], '390px');
  stop();
  f.resize(100);
  assert.equal(f.props['--vvh'], '390px');
});

test('watchViewport is a no-op without visualViewport', () => assert.equal(typeof watchViewport({}), 'function'));

test('a pinch zoom is not a keyboard', () => {
  const f = fakeWindow();
  watchViewport(f.win);
  f.vv.scale = 1.5;
  f.resize(563);
  assert.ok(!f.classes.has('kb-open'));
});
