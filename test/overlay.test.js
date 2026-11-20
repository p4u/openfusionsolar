// overlay() of ui.js (spec 4.3, preflight F6) over a fake history whose back() lands a task later, as in a browser,
// and fake dialogs whose close event is also queued.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const win = new EventTarget();
let entries;
let index;
const reset = () => { entries = [{ url: '#/a', state: null }]; index = 0; };
reset();
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.history = {
  get state() { return entries[index].state; },
  pushState(state) { entries.splice(index + 1, Infinity, { url: entries[index].url, state: structuredClone(state) }); index++; },
  back() { setTimeout(() => { if (index > 0) { index--; win.dispatchEvent(new Event('popstate')); } }, 5); },
};
globalThis.location = {
  get hash() { return entries[index].url; },
  set hash(h) { if (h !== entries[index].url) { entries.splice(index + 1, Infinity, { url: h, state: null }); index++; } },
};
const { overlay } = await import('../public/js/ui.js');

function fakeDialog() {
  const el = Object.assign(new EventTarget(), { open: false, isConnected: true });
  el.showModal = () => { el.open = true; };
  el.close = () => {
    if (!el.open) return;
    el.open = false;
    setTimeout(() => el.dispatchEvent(new Event('close')), 0);
  };
  return el;
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const userBack = () => history.back();
const urls = () => entries.slice(0, index + 1).map((e) => `${e.url}${e.state?.overlay ? '+o' : ''}`);

test('open pushes one entry on the same url and back closes the dialog without a second pop', async () => {
  reset();
  const d = fakeDialog();
  await overlay(d).open();
  assert.deepEqual(urls(), ['#/a', '#/a+o']);
  userBack();
  await tick();
  assert.equal(d.open, false);
  assert.deepEqual(urls(), ['#/a']);
});

test('closing by a button pops the entry, and closed() resolves after the pop', async () => {
  reset();
  const d = fakeDialog();
  const o = overlay(d);
  await o.open();
  d.close();
  await o.closed();
  assert.deepEqual(urls(), ['#/a']);
});

test('a dialog opened right after another one closes waits for the pop (sheet then confirm)', async () => {
  reset();
  const sheet = fakeDialog();
  const confirm = fakeDialog();
  await overlay(sheet).open();
  sheet.close();
  const opening = overlay(confirm).open(); // same tick as the close
  await tick(1);
  assert.equal(confirm.open, false, 'not before the pending back() lands');
  await opening;
  assert.equal(confirm.open, true);
  assert.deepEqual(urls(), ['#/a', '#/a+o']);
  userBack();
  await tick();
  assert.equal(confirm.open, false);
  assert.deepEqual(urls(), ['#/a'], 'no empty step left behind');
});

test('a route link inside an overlay closes it, then navigates from the view underneath', async () => {
  reset();
  const d = fakeDialog();
  await overlay(d).open();
  const click = new Event('click', { cancelable: true });
  Object.defineProperty(click, 'target', { value: { closest: () => ({ getAttribute: () => '#/b' }) } });
  d.dispatchEvent(click);
  assert.ok(click.defaultPrevented);
  await tick();
  assert.deepEqual(urls(), ['#/a', '#/b']);
});
