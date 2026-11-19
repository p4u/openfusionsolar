// AC5: the UI carries no emoji or glyphs doing an icon's job, and loads nothing from another origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const BANNED = /[\p{Extended_Pictographic}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{FE0F}\u{2014}]/u;
const SVG_NS = 'http://www.w3.org/2000/svg';

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// file:line of every line that matches
function offending(matches) {
  const hits = [];
  for (const file of walk(PUBLIC)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (matches(line)) hits.push(`${path.relative(PUBLIC, file)}:${i + 1}`);
    });
  }
  return hits;
}

test('public has no emoji, arrows, geometric glyphs or em dashes', () => {
  assert.deepEqual(offending((line) => BANNED.test(line)), []);
});

test('public references no external urls', () => {
  assert.deepEqual(offending((line) => /https?:\/\//.test(line.replaceAll(SVG_NS, ''))), []);
});

test('the banned set catches the emoji the old ui used and spares normal typography', () => {
  for (const c of ['⏳', 'ℹ', '☀️', '\u{1F50C}', '▲', '←', '→', '—']) assert.match(c, BANNED, c);
  for (const c of ['€', '·', '–', '’', '…', '«', '℃', '×', '°', '≥', '0']) assert.doesNotMatch(c, BANNED, c);
});
