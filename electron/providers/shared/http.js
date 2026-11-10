const https = require('https');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve(responseBody);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...extraHeaders },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPut(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ?? Buffer.alloc(0);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'PUT',
      headers: {
        'Content-Length': payload.length,
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: responseBody });
          return;
        }
        reject(new Error(`HTTP ${res.statusCode}: ${responseBody || res.statusMessage}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * fetch() wrapper for OpenAI-compatible JSON/multipart APIs. Throws an Error
 * carrying `.status` and `.retryAfterMs` on non-2xx so callers can map/retry.
 */
async function fetchJson(url, init = {}, { label = 'API', fetchImpl = globalThis.fetch, maxResponseBytes } = {}) {
  if (maxResponseBytes !== undefined && (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1)) throw new Error('Invalid response limit');
  if (init.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  const res = await fetchImpl(url, init);
  let text;
  if (maxResponseBytes === undefined) text = await res.text(); // existing callers retain their behavior
  else {
    const cancel = () => { try { res.body?.cancel().catch(() => {}); } catch { /* locked */ } };
    if (init.signal?.aborted) { cancel(); throw new DOMException('Request aborted', 'AbortError'); }
    if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(res.headers.get('content-type') || '')) {
      cancel(); throw new Error('Invalid JSON response type');
    }
    if (Number(res.headers.get('content-length')) > maxResponseBytes) { cancel(); throw new Error('Response size limit exceeded'); }
    if (!res.body?.getReader) throw new Error('Missing response body');
    const reader = res.body.getReader();
    const abort = () => { reader.cancel().catch(() => {}); };
    init.signal?.addEventListener('abort', abort, { once: true });
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (init.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) { abort(); throw new Error('Response size limit exceeded'); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks, size).toString('utf8');
    } finally { init.signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  }
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || text.slice(0, 300) || res.statusText;
    const err = new Error(`${label} error (${res.status}): ${detail}`);
    err.status = res.status;
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return data;
}

module.exports = { sleep, httpsPost, httpsGet, httpsPut, fetchJson };
