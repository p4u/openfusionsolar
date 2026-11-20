// installMode and showBanner (spec 4.2, AC8 unit part): which install entry each browser gets, and when the banner shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMode, showBanner } from '../public/js/install.js';

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const MODES = [
  // [name, input, expected]
  ['Chrome Android with a prompt', { hasPrompt: true, ua: UA.chromeAndroid, maxTouchPoints: 5 }, 'prompt'],
  ['Chrome Android without a prompt', { hasPrompt: false, ua: UA.chromeAndroid, maxTouchPoints: 5 }, 'manual'],
  ['Samsung Internet without a prompt', { hasPrompt: false, ua: UA.samsung, maxTouchPoints: 5 }, 'manual'],
  ['Firefox Android', { hasPrompt: false, ua: UA.firefoxAndroid, maxTouchPoints: 5 }, 'firefox-android'],
  ['iPhone Safari', { hasPrompt: false, ua: UA.iphone, maxTouchPoints: 5 }, 'ios'],
  ['iPad reporting Macintosh with 5 touch points', { hasPrompt: false, ua: UA.mac, maxTouchPoints: 5 }, 'ios'],
  ['Mac desktop with 0 touch points', { hasPrompt: false, ua: UA.mac, maxTouchPoints: 0 }, 'hidden'],
  ['Windows Chrome without a prompt', { hasPrompt: false, ua: UA.windowsChrome, maxTouchPoints: 0 }, 'hidden'],
  ['display-mode standalone wins over a prompt', { hasPrompt: true, ua: UA.chromeAndroid, maxTouchPoints: 5, standalone: true }, 'installed'],
  ['navigator.standalone on an iPhone', { hasPrompt: false, ua: UA.iphone, maxTouchPoints: 5, standalone: true }, 'installed'],
];
for (const [name, input, expected] of MODES) test(`installMode: ${name}`, () => assert.equal(installMode(input), expected));

const base = { mode: 'prompt', today: '2026-11-21', firstDay: '2026-11-20', dismissed: false, route: 'now', toast: false };
const BANNER = [
  ['first day', { today: '2026-11-20' }, false],
  ['no first day recorded yet', { firstDay: null }, false],
  ['second day', {}, true],
  ['dismissed', { dismissed: true }, false],
  ['login page', { route: 'login' }, false],
  ['update toast showing', { toast: true }, false],
  ['installed', { mode: 'installed' }, false],
  ['desktop without a prompt', { mode: 'hidden' }, false],
  ['ios steps', { mode: 'ios' }, true],
];
for (const [name, patch, expected] of BANNER) test(`showBanner: ${name}`, () => assert.equal(showBanner({ ...base, ...patch }), expected));
