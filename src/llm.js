// OpenRouter client. Every model call goes through complete(): budget check first, usage recorded after.
// The key lives only in the createLlm closure and is never logged or put in an error.
import { dayBounds } from './collector.js';
import { readCapped } from './http.js';

export const DEFAULT_MODEL = 'google/gemini-3.1-flash-lite';
export const CHAT_MODEL = 'google/gemini-3.8-flash';
export const CHAT_FALLBACK = 'qwen/qwen3.8-27b';
// USD per token, OpenRouter list prices of 2026-11-20; only used when a response has no usage.cost.
export const PRICES = {
  [DEFAULT_MODEL]: { in: 0.25e-6, out: 1.5e-6 },
  [CHAT_MODEL]: { in: 0.825e-6, out: 4.125e-6 },
  [CHAT_FALLBACK]: { in: 0.06e-6, out: 2.2e-6 },
};

// AI_CHAT_REASONING: 'off' → null, empty → low effort, low | medium | high; anything else throws.
export function reasoningFromEnv(v) {
  const s = (v ?? '').trim();
  if (s === 'off') return null;
  if (s === '') return { effort: 'low' };
  if (['low', 'medium', 'high'].includes(s)) return { effort: s };
  throw new Error('AI_CHAT_REASONING must be off, low, medium or high');
}

export function assertPriced(model) {
  if (!PRICES[model]) throw new Error(`no price for model ${model}: add it to PRICES in src/llm.js`);
}

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
    reasoning = null, retryTimeout = true,
  }) {
    const fail = (code, message, status = null) => {
      log(`llm ${job} error ${code} ${status}`);
      throw new LlmError(code, message, status);
    };
    if (!enabled) fail('disabled', 'ai is not configured');
    if (!(monthSpend() < budgetUsd)) fail('budget', 'monthly ai budget reached');

    const body = { model, messages, temperature, max_tokens: maxTokens, provider: { data_collection: 'deny' } };
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema } };
    if (tools) body.tools = tools;
    if (reasoning) body.reasoning = reasoning;
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
        if (timer.aborted) retryable = retryTimeout; // false when the caller has a fallback to try instead
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
