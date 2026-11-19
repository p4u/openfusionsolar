process.env.TZ = 'Europe/Madrid';
// OpenRouter client. Every model call goes through complete(): budget check first, usage recorded after.
// The key lives only in the createLlm closure and is never logged or put in an error.
import { dayBounds } from './collector.js';

export const DEFAULT_MODEL = 'google/gemini-3.1-flash-lite';
export const PRICES = { [DEFAULT_MODEL]: { in: 0.25e-6, out: 1.5e-6 } };

const MAX_BYTES = 1024 * 1024;
const BACKOFF_MS = [1000, 3000];

export class LlmError extends Error {
  // code: budget | rate_limited | timeout | upstream | bad_response | disabled
  constructor(code, message, status = null) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads at most MAX_BYTES of the body; null when it is larger.
async function readCapped(res) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.length;
    if (n > MAX_BYTES) return null; // leaving the loop cancels the stream
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createLlm({
  apiKey, store, budgetUsd = 5, fetch = globalThis.fetch, now = Date.now, sleep = wait, log = () => {},
  baseUrl = 'https://openrouter.ai/api/v1',
} = {}) {
  const enabled = Boolean(apiKey);

  function monthSpend() {
    const d = new Date(now());
    return store.usageCostSince(dayBounds(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`)[0]);
  }

  async function complete({
    job, model = DEFAULT_MODEL, messages, tools, schema, maxTokens, temperature = 0, timeoutMs = 60000, signal, ref,
  }) {
    const fail = (code, message, status = null) => {
      log(`llm ${job} error ${code} ${status}`);
      throw new LlmError(code, message, status);
    };
    if (!enabled) fail('disabled', 'ai is not configured');
    if (monthSpend() >= budgetUsd) fail('budget', 'monthly ai budget reached');

    const body = { model, messages, temperature, max_tokens: maxTokens, provider: { data_collection: 'deny' } };
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema } };
    if (tools) body.tools = tools;
    const payload = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const t0 = now();
      const timer = AbortSignal.timeout(timeoutMs);
      let res;
      let retryable = true;
      let last;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: payload,
          signal: AbortSignal.any([signal, timer].filter(Boolean)),
        });
        if (res.status === 200) return await finish(res, t0);
        await res.body?.cancel().catch(() => {});
        retryable = res.status === 429 || res.status >= 500;
        last = [res.status === 429 ? 'rate_limited' : 'upstream', `upstream status ${res.status}`, res.status];
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (signal?.aborted) fail('timeout', 'request aborted');
        last = timer.aborted ? ['timeout', 'request timed out'] : ['upstream', 'network error'];
      }
      if (!retryable || attempt >= BACKOFF_MS.length) fail(...last);
      await sleep(BACKOFF_MS[attempt]);
      if (signal?.aborted) fail('timeout', 'request aborted');
    }

    async function finish(res, t0) {
      const text = await readCapped(res);
      if (text === null) fail('bad_response', 'response too large', 200);
      let json;
      try { json = JSON.parse(text); } catch { fail('bad_response', 'response is not json', 200); }
      const u = json?.usage ?? {};
      const tokensIn = u.prompt_tokens ?? 0;
      const tokensOut = u.completion_tokens ?? 0;
      const p = PRICES[model] ?? PRICES[DEFAULT_MODEL];
      const costUsd = u.cost ?? tokensIn * p.in + tokensOut * p.out;
      store.addUsage({ ts: now(), job, model, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, ref });
      const choice = json?.choices?.[0];
      if (!choice?.message) fail('bad_response', 'response has no message', 200);
      log(`llm ${job} ${model} 200 ${now() - t0} ms`);
      return { message: choice.message, finishReason: choice.finish_reason, usage: { tokensIn, tokensOut, costUsd } };
    }
  }

  return { enabled, complete, monthSpend, budgetUsd };
}
