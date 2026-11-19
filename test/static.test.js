import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStatic, buildSprite, ICONS, FONTS, MIME } from '../src/static.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const LUCIDE = fileURLToPath(new URL('../node_modules/lucide-static/icons', import.meta.url));

test('traversal and hidden paths resolve to null', () => {
  for (const p of [
    '/../package.json', '/%2e%2e/package.json', '/js/..%2f..%2fsrc%2fmain.js', '/%00.js', '/.env', '/js/.x.js',
    '/x.exe', '/%E0%A4%A', '/', '/js', '/..%5c..%5cpackage.json', '/nope.js',
  ]) {
    assert.equal(resolveStatic(PUBLIC, p), null, p);
  }
});

test('manifest and png icons resolve with their types; traversal through them does not', () => {
  assert.equal(resolveStatic(PUBLIC, '/manifest.webmanifest'), path.join(PUBLIC, 'manifest.webmanifest'));
  assert.equal(resolveStatic(PUBLIC, '/icons/icon-192.png'), path.join(PUBLIC, 'icons', 'icon-192.png'));
  assert.equal(MIME['.webmanifest'], 'application/manifest+json');
  assert.equal(MIME['.png'], 'image/png');
  for (const p of ['/icons/../../package.json', '/icons/%2e%2e/%2e%2e/package.json', '/icons/nope.png', '/x.webmanifest', '/icons/.x.png', '/icons/icon-192.png%00.js']) {
    assert.equal(resolveStatic(PUBLIC, p), null, p);
  }
});

test('a normal file resolves inside public', () => {
  assert.equal(resolveStatic(PUBLIC, '/index.html'), path.join(PUBLIC, 'index.html'));
  assert.equal(resolveStatic(PUBLIC, '/js/login.js'), path.join(PUBLIC, 'js', 'login.js'));
});

test('sprite has one symbol per icon and no hardcoded stroke width', () => {
  const sprite = buildSprite(LUCIDE);
  assert.ok(Object.isFrozen(ICONS));
  assert.equal(sprite.match(/<symbol /g).length, ICONS.length);
  for (const name of ICONS) assert.match(sprite, new RegExp(`<symbol id="${name}" viewBox="0 0 24 24">`));
  assert.doesNotMatch(sprite, /stroke-width|license|class="lucide/);
  assert.match(sprite, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg">/);
  assert.equal(sprite.match(/<svg/g).length, 1);
});

test('every font in the whitelist exists', () => {
  assert.equal(Object.keys(FONTS).length, 4);
  for (const [url, file] of Object.entries(FONTS)) {
    assert.match(url, /^\/fonts\/[a-z-]+-wght-normal\.woff2$/);
    assert.ok(fs.statSync(file).isFile(), file);
  }
});
