// Dictionaries: one file per namespace, same keys in every language, no key in two files, no missing key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const DIR = path.join(PUBLIC, 'js', 'i18n');
const dicts = new Map(await Promise.all(fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()
  .map(async (f) => [path.basename(f, '.js'), (await import(pathToFileURL(path.join(DIR, f)))).default])));

test('the shell and every view have a dictionary', () => {
  for (const ns of ['core', 'now', 'energy', 'battery', 'panels', 'bill', 'incidents', 'signals', 'settings']) {
    assert.ok(dicts.has(ns), ns);
    if (ns !== 'core') assert.equal(typeof dicts.get(ns).en[`${ns}.title`], 'string', `${ns}.title`);
  }
});

for (const [ns, dict] of dicts) {
  test(`${ns}: en and ca have the same keys`, () => {
    assert.deepEqual(Object.keys(dict.ca).sort(), Object.keys(dict.en).sort());
  });
  test(`${ns}: every key starts with the namespace`, () => {
    for (const lang of ['en', 'ca']) {
      assert.deepEqual(Object.keys(dict[lang]).filter((k) => !k.startsWith(`${ns}.`)), [], lang);
    }
  });
}

test('no key is defined in two files', () => {
  const owner = new Map();
  const dupes = [];
  for (const [ns, dict] of dicts) {
    for (const k of Object.keys(dict.en)) {
      if (owner.has(k)) dupes.push(`${k} (${owner.get(k)}, ${ns})`);
      owner.set(k, ns);
    }
  }
  assert.deepEqual(dupes, []);
});

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(html|js)$/.test(e.name)) yield p;
  }
}

test('every literal key used in markup and code exists', () => {
  const names = [...dicts.keys()].join('|');
  const literal = new RegExp(`["'\`]((?:${names})\\.[A-Za-z][\\w.]*)["'\`]`, 'g');
  const missing = [];
  for (const file of walk(PUBLIC)) {
    if (file.startsWith(DIR)) continue;
    for (const [, key] of fs.readFileSync(file, 'utf8').matchAll(literal)) {
      if (/\.(js|css)$/.test(key)) continue;
      if (dicts.get(key.split('.')[0]).en[key] === undefined) missing.push(`${path.relative(PUBLIC, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('i18n and format import under node, setLang switches language, t falls back to en then to the key', async () => {
  const i18n = await import('../public/js/i18n.js');
  const format = await import('../public/js/format.js');
  i18n.register(dicts.get('core'));
  i18n.register({ en: { 'x.hi': 'Hello {name}', 'x.onlyEn': 'only en', 'x.list': ['a', 'b'] }, ca: { 'x.hi': 'Hola {name}' } });

  i18n.setLang('en');
  assert.equal(i18n.getLang(), 'en');
  assert.equal(i18n.locale(), 'en-GB');
  assert.equal(i18n.t('x.hi', { name: 'Ada' }), 'Hello Ada');

  i18n.setLang('ca');
  assert.equal(i18n.getLang(), 'ca');
  assert.equal(i18n.locale(), 'ca-ES');
  assert.equal(i18n.t('x.hi', { name: 'Ada' }), 'Hola Ada');
  assert.equal(i18n.t('x.onlyEn'), 'only en');
  assert.equal(i18n.t('x.nowhere'), 'x.nowhere');
  assert.deepEqual(i18n.t('x.list'), ['a', 'b']);

  i18n.setLang('xx');
  assert.equal(i18n.getLang(), 'ca', 'unknown languages are ignored');

  assert.equal(format.kwh(1234.56), '1.234,6\u00a0kWh');
  assert.equal(format.kw(null), '–');
});
