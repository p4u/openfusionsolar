import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadGuide, parseGuide, readGuide, guidePrompt, GuideError, CORE_TERMS, MAX_WORDS, MAX_PROMPT } from '../src/knowledge.js';

const guide = loadGuide();
const md = fs.readFileSync(new URL('../src/knowledge/guide.md', import.meta.url), 'utf8');
const SPEC_SECTIONS = ['pv-basics', 'huawei-fusionsolar', 'spain-tariff-2.0TD', 'spain-market', 'self-consumption-compensation',
  'advice-patterns', 'glossary'];

test('every section is in the index', () => {
  assert.deepEqual(guide.sections.map((s) => s.id), SPEC_SECTIONS);
  for (const s of guide.sections) {
    assert.ok(guide.index.has(s.id), s.id);
    assert.ok(s.summary.length > 10, `${s.id} summary`);
    assert.ok(s.topics.length > 0, `${s.id} topics`);
    for (const t of s.topics) assert.match(t, new RegExp(`^${s.id.replace('.', '\\.')}/[a-z0-9-]+$`));
  }
});

test('read_guide returns each listed id', () => {
  for (const s of guide.sections) {
    for (const id of [s.id, ...s.topics]) {
      const r = readGuide(guide, id);
      assert.equal(r.id, id);
      assert.ok(r.text?.includes(id) || r.topics?.length, id);
    }
  }
  assert.match(readGuide(guide, 'spain-tariff-2.0TD/periods').text, /P1 punta/);
});

test('read_guide refuses \'pv-basics/../../.env\', \'\', \'x\' and an id with a trailing space', () => {
  for (const id of ['pv-basics/../../.env', '', 'x', 'pv-basics ', 'pv-basics/how-it-works ', undefined, null, 42, ['pv-basics']]) {
    assert.throws(() => readGuide(guide, id), (err) => err instanceof GuideError && /^unknown guide id; ids: pv-basics/.test(err.message), String(id));
  }
});

test('no subsection is over 2500 words', () => {
  for (const [id, e] of guide.index) {
    if (id.includes('/')) assert.ok(e.words <= MAX_WORDS, `${id}: ${e.words}`);
  }
});

test('a section over 2500 words is returned as its topic list', () => {
  const big = Array.from({ length: MAX_WORDS }, () => 'kWh').join(' ');
  const g = parseGuide(`# t\n\n## s\n\nSummary line.\n\n### s/a\n${big}\n\n### s/b\nshort\n`);
  assert.deepEqual(readGuide(g, 's'), { id: 's', topics: ['s/a', 's/b'] });
  assert.equal(readGuide(g, 's/b').text, '### s/b\nshort');
  assert.throws(() => parseGuide('## s\n\nSummary.\n\n### other/a\ntext\n'), /outside section/);
});

test('the guide holds no e-mail, CUPS (ES + 16 digits + 2 letters) or phone pattern, no "[47]", no "owner"', () => {
  assert.doesNotMatch(md, /[\w.+-]+@[\w-]+\.[\w.-]+/, 'e-mail');
  assert.doesNotMatch(md, /ES\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?[A-Z]{2}/i, 'CUPS');
  assert.doesNotMatch(md, /(?<![\w.,/-])(?:\+34[\s-]?)?[6789]\d{2}[\s-]?\d{3}[\s-]?\d{3}(?![\w.,/-])/, 'phone');
  assert.ok(!md.includes('[47]'), '[47]');
  assert.doesNotMatch(md, /owner/i);
});

test('sources are https URLs', () => {
  assert.ok(guide.sources.size >= 40, `${guide.sources.size} sources`);
  for (const u of guide.sources) {
    assert.equal(new URL(u).protocol, 'https:', u);
    assert.equal(new URL(u).href, u, 'canonical');
  }
  // a parenthesis inside a URL stays; one closing the line's own bracket does not
  assert.ok(guide.sources.has('https://ske-solar.com/productdata/SUN2000-M1/02_Manuals/User%20Manual_SUN2000-(3KTL-10KTL)-M1_V17_2024-01-12_EN.pdf'));
  assert.ok(guide.sources.has('https://www.osti.gov/biblio/1045052'));
  assert.ok(guide.sources.has('https://www.boe.es/buscar/act.php?id=BOE-A-2019-5089'));
});

test('guidePrompt is at most 2200 characters and holds 15 glossary terms', () => {
  const p = guidePrompt(guide);
  assert.ok(p.length <= MAX_PROMPT, `${p.length} characters`);
  assert.equal(CORE_TERMS.length, 15);
  assert.equal(new Set(CORE_TERMS).size, 15);
  for (const term of CORE_TERMS) assert.ok(p.includes(`\n${term} = ${guide.glossary.get(term)}`), term);
  for (const s of guide.sections) assert.ok(p.includes(`${s.id}: `), s.id);
  assert.match(p, /how-it-works, self-consumption-terms/);
});

test('read_guide ends with the cited sources as "[n] url" lines that read_web_page accepts', async () => {
  const { urlRefusal } = await import('../src/web-rules.js');
  const { text } = readGuide(guide, 'self-consumption-compensation');
  const lines = text.slice(text.indexOf('\n\nSources:\n') + 11).split('\n');
  assert.ok(lines.length > 3);
  for (const l of lines) {
    const [, n, url] = /^\[(\d+)\] (https:\S+)$/.exec(l);
    assert.ok(text.includes(`[${n}]`), n);
    assert.equal(urlRefusal(url, guide.sources), null, url);
  }
  assert.ok(lines.some((l) => l.startsWith('[40] https://')));
  const g = parseGuide('## s\n\nSummary.\n\n### s/a\nA fact [2] and [1].\n\n### s/b\nno citation\n\n## Sources\n\n1. One. https://a.example/x\n2. Two. https://b.example/y (abstract: https://b.example/z)\n');
  assert.equal(readGuide(g, 's/a').text, '### s/a\nA fact [2] and [1].\n\nSources:\n[1] https://a.example/x\n[2] https://b.example/y\n[2] https://b.example/z');
  assert.equal(readGuide(g, 's/b').text, '### s/b\nno citation');
});

test('the prompt\'s glossary lines name no supplier', () => {
  const p = guidePrompt(guide);
  assert.doesNotMatch(p, /\bSom\b/);
  assert.match(p, /\nSols = A supplier's solar credit; 1 Sol = 1 € off a later bill\n/);
  assert.match(p, /\nserveis d'ajust = Cost of balancing the grid; some suppliers bill it apart\n/);
});
