// Fake transport for the LLM client: replays steps in order, records each parsed request body.
// A step is { status, response } (response an object, or a raw string) or 'timeout' / 'network'.
import fs from 'node:fs';

const dir = new URL('.', import.meta.url);

// A recorded fixture ({ request, status, response }) as a replayable step.
export const fixture = (name) => {
  const { status, response } = JSON.parse(fs.readFileSync(new URL(`${name}.json`, dir), 'utf8'));
  return { status, response };
};

export function fakeFetch(steps) {
  const calls = [];
  const headers = [];
  const queue = [...steps];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    headers.push(init.headers);
    const step = queue.shift();
    if (!step) throw new Error('fakeFetch: no step left');
    if (step === 'network') throw new TypeError('fetch failed');
    if (step === 'timeout') {
      // hangs until the client aborts, like a stalled connection
      return new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout is unref'd; a real socket would hold the loop
        const abort = () => { clearTimeout(keepAlive); reject(init.signal.reason); };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    }
    const body = typeof step.response === 'string' ? step.response : JSON.stringify(step.response);
    return new Response(body, { status: step.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls, headers };
}
