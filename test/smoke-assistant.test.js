process.env.TZ = 'Europe/Madrid';
// Live assistant check (spec AC1, AC2), skipped unless AI_SMOKE=1 and AI_SMOKE_DB names a copy of a real database
// outside the repo. The copy is copied again (VACUUM INTO) under ~/.cache/openfusionsolar/smoke/ and only that one is
// written. Keys come from .env and are never printed. Answers go to ~/.cache/openfusionsolar/smoke/assistant-<ts>.jsonl;
// the console gets pass or fail per question, rounds and cost only, never a figure or a text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { createLlm, CHAT_MODEL, CHAT_FALLBACK, reasoningFromEnv } from '../src/llm.js';
import { createAssistant } from '../src/assistant.js';
import { createWeb } from '../src/web.js';
import { createMarket } from '../src/market.js';
import { pricesFromEnv } from '../src/tariff.js';
import { localDay, dayBounds } from '../src/collector.js';
import { runTool } from '../src/assistant-tools.js';
import { buildDataset } from '../src/query-data.js';
import { createDatasets, resolveFigure, summarize, OPS } from '../src/datasets.js';
import { figures, isGrounded, MARK } from '../src/grounding.js';

const REPO = path.resolve(import.meta.dirname, '..');
const OUT = path.join(os.homedir(), '.cache/openfusionsolar/smoke');
const SPEND = 0.30;
const db = process.env.AI_SMOKE_DB;
const skip = process.env.AI_SMOKE !== '1' ? 'AI_SMOKE=1 not set' : !db || !fs.existsSync(db) ? 'AI_SMOKE_DB is not a file' : false;

// Benchmark questions (model-bench.md, text of its harness), the four of AC1 and one that needs the web.
const QUESTIONS = {
  q1: 'Quin mes d\'aquest any hem sigut més autosuficients amb les plaques, i per què aquell mes i no un altre?',
  q2: 'Quant ens ha estalviat la bateria aquest estiu?',
  q3: 'La factura de juny quadra amb el que ha mesurat la instal·lació?',
  q4: 'Quant portem estalviat aquest any gràcies a les plaques? I quant hauríem pagat sense?',
  q5: 'Quin mes d\'aquest any hem pagat la factura més cara, i quanta llum vam comprar i vendre aquell mes?',
  q9: 'Quant hem gastat?',
  q10: 'Compara-ho amb l\'any passat.',
  ac1a: 'El dia mitjà de juliol hora a hora: producció, consum i bateria.',
  ac1b: 'Quins dies de la setmana consumeixo més?',
  ac1c: 'Compara el preu PVPC d\'ahir amb la meva producció.',
  ac1d: 'Quant he estalviat cada mes d\'aquest any, acumulat?',
  web: 'Busca al web les últimes notícies sobre el preu de la llum a Espanya.',
};

// A reference value is in the answer when one of its checked figures matches it under the grounding tolerance
// (spec 3.6 step 7).
const has = (text, ref) => Number.isFinite(ref) && figures(text, 'ca').some((f) => isGrounded(f, new Set([Math.abs(ref)])));

// Key figures per data question, computed now with the app's own tools (as the benchmark's refs.mjs did): a list of
// alternatives per required figure.
async function references(deps, today) {
  const year = `${today.slice(0, 4)}-01-01`;
  const tool = async (name, args) => (await runTool(name, args, deps)).result;
  const months = (await tool('get_energy', { from: year, to: today, bucket: '1mo' })).buckets;
  const best = Math.max(...months.map((m) => m.selfSufficiencyPct ?? -1));
  const summer = { from: `${today.slice(0, 4)}-06-01`, to: `${today.slice(0, 4)}-08-31` };
  const summerEnergy = (await tool('get_energy', { ...summer, bucket: '1y' })).total;
  const bills = (await tool('list_invoices', { from: year })).invoices;
  const june = bills.find((b) => b.month === `${today.slice(0, 4)}-06`);
  const cmp = june ? await tool('compare_invoice', { id: june.id }) : null;
  const yearEstimate = await tool('estimate_bill', { from: year, to: today });
  const yearEnergy = (await tool('get_energy', { from: year, to: today, bucket: '1y' })).total;
  const dear = bills.reduce((a, b) => (b.total_eur > (a?.total_eur ?? -Infinity) ? b : a), null);
  return {
    q1: [months.filter((m) => m.selfSufficiencyPct >= best - 1).map((m) => m.selfSufficiencyPct)],
    q2: [[(await tool('estimate_bill', summer)).savings, summerEnergy.discharge_kwh, summerEnergy.money?.savings]],
    q3: [[cmp?.diffKwh, cmp?.kwh?.billed?.total, cmp?.kwh?.measured?.total]],
    q4: [[yearEstimate.savings, yearEnergy.money?.savings], [yearEstimate.withoutSolar, yearEnergy.money?.withoutSolar]],
    q5: [[dear?.total_eur], [dear?.kwh], [dear?.surplus_kwh]],
  };
}

// Every series of a figure equals a column of buildDataset(figure.query), or one op of draw_chart on its columns.
async function figureMatches(fig, deps) {
  const ds = await buildDataset(fig.query, deps);
  if (ds.unavailable || !isDeepStrictEqual(ds.x.values, fig.x.values)) return false;
  const datasets = createDatasets();
  const { id, columns } = summarize(datasets.add(ds));
  const cols = columns.slice(1);
  const specs = [...cols.map((c) => ({ column: c })), ...cols.map((c) => ({ op: 'cumulative', columns: [c] })),
    ...OPS.filter((o) => o !== 'cumulative').flatMap((op) => cols.flatMap((a) => cols.filter((b) => b !== a).map((b) => ({ op, columns: [a, b] }))))];
  const candidates = specs.flatMap((s) => {
    try {
      return [resolveFigure({ kind: 'line', title: 't', series: [{ dataset: id, label: 'l', ...s }] }, datasets).block.series[0].values];
    } catch {
      return []; // an op these columns do not allow
    }
  });
  return fig.series.every((s) => candidates.some((c) => isDeepStrictEqual(c, s.values)));
}

test('the assistant answers the benchmark and AC1 questions live, within 0.30 USD', { skip, timeout: 40 * 60e3 }, async (t) => {
  process.loadEnvFile(path.join(REPO, '.env'));
  const env = process.env;
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(OUT, `run-${stamp}.db`);
  const src = new DatabaseSync(db, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.replaceAll('\'', '\'\'')}'`);
  src.close();
  const store = new Store(copy);
  t.after(() => {
    store.db.close();
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true });
  });

  // as src/main.js builds them
  const optNum = (v) => (v == null || v === '' ? null : Number(v));
  const config = {
    prices: pricesFromEnv(env),
    battery: { capacityKwh: optNum(env.BATTERY_KWH), minPct: optNum(env.BATTERY_MIN_PCT), reservePct: optNum(env.BATTERY_RESERVE_PCT) },
    plantName: env.PLANT_NAME || null,
  };
  const d = new Date();
  const monthStart = dayBounds(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`)[0];
  const spent0 = store.usageCostSince(0);
  // preflight F10: the copy already holds this month's spending; this run may add 0.30 USD to it
  const llm = createLlm({ apiKey: env.AI_API_KEY, store, budgetUsd: store.usageCostSince(monthStart) + SPEND });
  const reasoning = reasoningFromEnv(env.AI_CHAT_REASONING);
  const web = createWeb({ apiKey: env.JINA_API_KEY, store });
  const market = createMarket({ store });
  const assistant = createAssistant({
    store, llm, config, web, market, reasoning,
    model: env.AI_MODEL_CHAT || CHAT_MODEL,
    fallbackModel: env.AI_MODEL_CHAT_FALLBACK === 'none' ? null : env.AI_MODEL_CHAT_FALLBACK || CHAT_FALLBACK,
    fallbackReasoning: reasoning && { effort: 'medium' },
  });
  const deps = { store, config, now: Date.now, market };
  const refs = await references(deps, localDay(Date.now()));
  const transcript = path.join(OUT, `assistant-${stamp}.jsonl`);

  const failed = [];
  for (const [id, text] of Object.entries(QUESTIONS)) {
    const t0 = Date.now();
    const events = [];
    const [status, run] = assistant.routes['POST /api/assistant/chat'].handler({ body: { text, lang: 'ca' } });
    if (status === 200) await run((e) => events.push(e), new AbortController().signal);
    const answer = events.filter((e) => e.type === 'text').map((e) => e.text).join('\n');
    const done = events.find((e) => e.type === 'done');
    const blocks = events.filter((e) => !['status', 'ping', 'done'].includes(e.type));
    const figs = events.filter((e) => e.type === 'figure');
    const checks = { answered: Boolean(done) && Boolean(answer), notApology: !answer.startsWith('Ho sento, no he pogut respondre'), noPlaceholder: !answer.includes(MARK.ca) };
    if (id === 'q9' || id === 'q10') checks.choice = blocks.at(-1)?.type === 'choice';
    else if (refs[id]) checks.keyFigures = refs[id].map((alts) => alts.some((ref) => has(answer, ref)));
    else if (id.startsWith('ac1')) checks.figures = await Promise.all(figs.map((f) => figureMatches(f, deps)));
    else if (id === 'web') checks.webSearch = events.some((e) => e.type === 'status' && e.tool === 'web_search');
    const ok = Object.values(checks).every((v) => (Array.isArray(v) ? v.length > 0 && v.every(Boolean) : v));
    const rounds = events.filter((e) => e.type === 'status' && e.tool === 'thinking').length;
    fs.appendFileSync(transcript, `${JSON.stringify({ id, question: text, ok, checks, ms: Date.now() - t0, refs: refs[id] ?? null, events })}\n`, { mode: 0o600 });
    const why = Object.keys(checks).filter((k) => !(Array.isArray(checks[k]) ? checks[k].length && checks[k].every(Boolean) : checks[k]));
    console.log(`${id} ${ok ? 'pass' : `FAIL (${why.join(', ')})`} rounds ${rounds} cost ${(done?.usage.costUsd ?? 0).toFixed(4)} USD${done ? '' : ` error ${events.find((e) => e.type === 'error')?.code ?? status}`}`);
    if (!ok) failed.push(id);
  }
  const spent = store.usageCostSince(0) - spent0;
  console.log(`total ${spent.toFixed(4)} USD; web search ${web.status().available ? 'available' : `unavailable (${web.status().lastError ?? 'no key'})`}`);
  assert.ok(spent <= SPEND, `spent ${spent.toFixed(4)} USD`);
  assert.deepEqual(failed, []);
});
