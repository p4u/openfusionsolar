// Bounded HTTP for outside services: a timeout and a body cap. Errors carry a code only (no url, header or body).

// Reads at most maxBytes of the body; null when it is larger.
export async function readCapped(res, maxBytes = 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.length;
    if (n > maxBytes) return null; // leaving the loop cancels the stream
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// → { status, text } (text null when the body is over maxBytes); throws an Error with code 'timeout' | 'network'.
export async function fetchCapped(url, {
  method = 'GET', headers, body, timeoutMs = 15000, signal, fetch = globalThis.fetch, maxBytes,
} = {}) {
  const timer = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.any([signal, timer].filter(Boolean)) });
    return { status: res.status, text: await readCapped(res, maxBytes) };
  } catch (e) {
    const code = timer.aborted || e?.name === 'TimeoutError' ? 'timeout' : 'network';
    throw Object.assign(new Error(`http ${code}`), { code });
  }
}
