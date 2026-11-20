// The domain guide (src/knowledge/guide.md) and its read_guide index. Ids are keys of an index parsed once at
// start-up, never paths: read_guide cannot reach any other file.
import fs from 'node:fs';

export const MAX_WORDS = 2500;
export const MAX_PROMPT = 2200;

// The glossary terms every system prompt carries (Catalan, as written in the guide's glossary tables).
export const CORE_TERMS = [
  'autoconsum', 'autosuficiència', 'excedents', 'compensació simplificada', 'balanç net horari', 'Sols',
  'potència contractada', 'terme de potència', 'terme d\'energia', 'punta (P1)', 'pla (P2)', 'vall (P3)',
  'PVPC', 'serveis d\'ajust', 'SOC de fi de descàrrega',
];

export class GuideError extends Error {}

const words = (text) => text.split(/\s+/).filter(Boolean).length;

// A URL as `new URL(u).href` writes it (the form web-rules' urlRefusal compares), or null if it is not https.
function canonicalHttps(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// URLs in a source line. A closing parenthesis ends the URL unless the URL opened one, as in "(abstract: https://x)"
// versus "...SUN2000-(3KTL-10KTL)-M1...pdf".
function lineUrls(line) {
  return (line.match(/https:\/\/[^\s]+/g) ?? []).map((u) => {
    let url = u.replace(/[.,;]+$/, '');
    if (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
    return url;
  });
}

// md → { index: Map<id, { title, text, words }>, sections: [{ id, summary, topics }], sources: Set<url>,
// glossary: Map<term, definition> }. Sections are the `## ` headings before `## Sources`; topics their `### ` ids.
export function parseGuide(md) {
  const sections = [];
  const sources = new Set();
  const glossary = new Map();
  const bodies = new Map(); // id → lines
  let section = null;
  let topic = null;
  let inSources = false;
  for (const line of md.split('\n')) {
    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);
    if (h2) {
      inSources = h2[1].trim() === 'Sources';
      topic = null;
      section = inSources ? null : { id: h2[1].trim(), summary: '', topics: [] };
      if (section) sections.push(section);
      continue;
    }
    if (inSources) {
      for (const u of lineUrls(line)) {
        const c = canonicalHttps(u);
        if (c) sources.add(c);
      }
      continue;
    }
    if (!section) continue; // preamble before the first section
    if (h3) {
      topic = h3[1].trim();
      if (!topic.startsWith(`${section.id}/`)) throw new Error(`guide topic ${topic} is outside section ${section.id}`);
      if (bodies.has(topic)) throw new Error(`duplicate guide id ${topic}`);
      section.topics.push(topic);
      bodies.set(topic, []);
      continue;
    }
    if (line.trim() === '---') continue;
    if (!topic) {
      if (!section.summary && line.trim()) section.summary = line.trim();
      continue;
    }
    bodies.get(topic).push(line);
    if (section.id === 'glossary' && line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length >= 2 && cells[0] !== 'Català' && !/^-+$/.test(cells[0])) {
        glossary.set(cells[0], cells.at(-1).replace(/\s*(\[\d+\])+$/, ''));
      }
    }
  }

  const index = new Map();
  for (const s of sections) {
    if (!s.summary || !s.topics.length) throw new Error(`guide section ${s.id} needs a summary and topics`);
    if (index.has(s.id)) throw new Error(`duplicate guide id ${s.id}`);
    const parts = [];
    for (const id of s.topics) {
      const text = `### ${id}\n${bodies.get(id).join('\n').trim()}`;
      index.set(id, { title: id, text, words: words(text) });
      parts.push(text);
    }
    const text = [`## ${s.id}`, s.summary, ...parts].join('\n\n');
    index.set(s.id, { title: s.id, text, words: words(text) });
  }
  return { index, sections, sources, glossary };
}

let loaded = null;

// The guide shipped with the app, parsed on first use and kept for the process.
export function loadGuide() {
  loaded ??= parseGuide(fs.readFileSync(new URL('./knowledge/guide.md', import.meta.url), 'utf8'));
  return loaded;
}

// The read_guide tool: a subsection's text, a section's text when it fits, else the section's topic ids.
export function readGuide(guide, id) {
  const entry = typeof id === 'string' ? guide.index.get(id) : undefined;
  if (!entry) throw new GuideError(`unknown guide id; ids: ${[...guide.index.keys()].join(', ')}`);
  const section = guide.sections.find((s) => s.id === id);
  if (section && entry.words > MAX_WORDS) return { id, topics: section.topics };
  return { id, text: entry.text };
}

// The system-prompt lines: one per section with its summary and topics, then the core glossary.
export function guidePrompt(guide) {
  const lines = guide.sections.map((s) => {
    const topics = s.topics.map((t) => t.slice(s.id.length + 1)).join(', ');
    return `${s.id}: ${s.summary.replace(/\.$/, '')} (topics: ${topics})`;
  });
  lines.push('Glossary:');
  for (const term of CORE_TERMS) {
    const def = guide.glossary.get(term);
    if (!def) throw new Error(`core glossary term missing from the guide: ${term}`);
    lines.push(`${term} = ${def}`);
  }
  return lines.join('\n');
}
