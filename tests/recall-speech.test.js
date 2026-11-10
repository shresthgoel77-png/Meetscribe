import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transcribe, synthesize, GnaniSpeechError, LIMITS } = require('../electron/providers/speech/gnani.js');
const apiKey = 'test-key-not-a-credential';

// Real RIFF/PCM bytes with a deterministic tone, NOT a user recording or live provider output.
function wav({ sampleRate = 16000, seconds = 0.1, channels = 1, bits = 16 } = {}) {
  const samples = Math.round(sampleRate * seconds);
  const dataBytes = samples * channels * bits / 8;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  b.writeUInt16LE(channels * bits / 8, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  if (bits === 16) {
    for (let i = 0; i < samples * channels; i++) b.writeInt16LE(Math.round(4000 * Math.sin(i * Math.PI / 20)), 44 + i * 2);
  }
  return b;
}
const clip = wav();
const speech = wav({ sampleRate: 24000 });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});
const sttResponse = (extra = {}) => json({ success: true, transcript: ' नमस्ते, hello. ', model: 'prisma-v3.0', ...extra });
const ttsResponse = (body = speech, headers = {}) => new Response(body, { headers: { 'Content-Type': 'audio/wav', ...headers } });
const operations = [
  ['STT', (deps, extra = {}) => transcribe({ apiKey, audio: clip, ...extra }, deps)],
  ['TTS', (deps, extra = {}) => synthesize({ apiKey, text: 'A short test.', ...extra }, deps)],
];

beforeEach(() => {
  // Any accidental use of the real transport fails locally; ordinary tests cannot call billable APIs.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected uninjected fetch'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Recall Gnani STT', () => {
  it('sends the actual WAV bytes, Prisma hints and explicit format with a real multipart boundary', async () => {
    const fetchImpl = vi.fn(async () => sttResponse());
    expect(await transcribe({ apiKey: ` ${apiKey} `, audio: new Uint8Array(clip) }, { fetchImpl })).toEqual({ text: 'नमस्ते, hello.' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.vachana.ai/stt/v3');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(init.headers).toEqual({ 'X-API-Key-ID': apiKey, Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const request = new Request(url, init);
    const type = request.headers.get('content-type');
    expect(type).toMatch(/^multipart\/form-data; boundary=.+/);
    const form = await request.formData();
    expect([...form.keys()]).toEqual(['audio_file', 'model', 'language_code', 'format']);
    expect(form.get('model')).toBe('prisma-v3.0');
    expect(form.get('language_code')).toBe('hi-IN,en-IN');
    expect(form.get('format')).toBe('transcribe');
    expect(form.get('audio_file').name).toBe('recall.wav');
    expect(form.get('audio_file').type).toBe('audio/wav');
    expect(Buffer.from(await form.get('audio_file').arrayBuffer())).toEqual(clip);
  });

  it('accepts a valid WAV with an odd-sized padded ancillary chunk', async () => {
    const chunk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 7, 0]); // JUNK + padding
    const audio = Buffer.concat([clip.subarray(0, 12), chunk, clip.subarray(12)]);
    audio.writeUInt32LE(audio.length - 8, 4);
    await expect(transcribe({ apiKey, audio }, { fetchImpl: async () => sttResponse() })).resolves.toHaveProperty('text');
  });

  it('allows exactly 25 seconds and rejects longer audio before making a request', async () => {
    const fetchImpl = vi.fn(async () => sttResponse());
    await transcribe({ apiKey, audio: wav({ seconds: 25, sampleRate: 8000 }) }, { fetchImpl });
    await expect(transcribe({ apiKey, audio: wav({ seconds: 25.1, sampleRate: 8000 }) }, { fetchImpl })).rejects.toHaveProperty('code', 'AUDIO_TOO_LONG');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined], ['empty', Buffer.alloc(0)], ['not bytes', 'audio'],
    ['fake header', Buffer.alloc(44)], ['truncated file', clip.subarray(0, -2)],
    ['stereo', wav({ channels: 2 })], ['8-bit', wav({ bits: 8 })],
    ['no samples', wav({ seconds: 0 })],
  ])('rejects %s input without fetch', async (_label, audio) => {
    const fetchImpl = vi.fn();
    await expect(transcribe({ apiKey, audio }, { fetchImpl })).rejects.toHaveProperty('code', 'INVALID_AUDIO');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caps upload bytes before parsing or copying', async () => {
    const fetchImpl = vi.fn();
    await expect(transcribe({ apiKey, audio: Buffer.alloc(LIMITS.uploadBytes + 1) }, { fetchImpl })).rejects.toHaveProperty('code', 'AUDIO_TOO_LARGE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['encoding', 'byte rate', 'data size', 'high-bit signature'])('rejects corrupt WAV %s', async field => {
    const audio = Buffer.from(clip);
    if (field === 'encoding') audio.writeUInt16LE(3, 20);
    if (field === 'byte rate') audio.writeUInt32LE(1, 28);
    if (field === 'data size') audio.writeUInt32LE(audio.length, 40);
    if (field === 'high-bit signature') audio[0] |= 128;
    const fetchImpl = vi.fn();
    await expect(transcribe({ apiKey, audio }, { fetchImpl })).rejects.toHaveProperty('code', 'INVALID_AUDIO');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['', ' \n\t '])('treats an empty transcript as no speech, including the documented minimal response', async (transcript) => {
    await expect(transcribe({ apiKey, audio: clip }, {
      fetchImpl: async () => json({ success: true, transcript }),
    })).rejects.toMatchObject({ code: 'NO_SPEECH', name: 'GnaniSpeechError' });
  });

  it('rejects truncated text without returning any partial transcript', async () => {
    const error = await transcribe({ apiKey, audio: clip }, {
      fetchImpl: async () => sttResponse({ truncated: true, transcript: 'private partial text' }),
    }).catch(e => e);
    expect(error).toBeInstanceOf(GnaniSpeechError);
    expect(error.code).toBe('INCOMPLETE_TRANSCRIPT');
    expect(JSON.stringify(error) + error.message).not.toContain('private partial text');
  });

  it.each([null, [], 'text', {}, { success: true }, { success: true, transcript: {} },
    { success: true, transcript: null }, { success: true, transcript: 'ok', truncated: 'true' },
    { success: true, transcript: 'ok', model: 'prisma-v2.5' }, { success: false, transcript: 'ok' },
  ])('rejects malformed STT envelopes %#', async (body) => {
    await expect(transcribe({ apiKey, audio: clip }, { fetchImpl: async () => json(body) })).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
  });

  it.each(['', '{broken'])('rejects malformed/empty JSON', async body => {
    await expect(transcribe({ apiKey, audio: clip }, {
      fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    })).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
  });

  it('does not accept an error envelope just because HTTP returned 200', async () => {
    await expect(transcribe({ apiKey, audio: clip }, {
      fetchImpl: async () => json({ success: false, error: { type: 'RATE_LIMITED', message: apiKey } }),
    })).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 200 });
  });

  it('rejects a JSON transcript served as HTML', async () => {
    await expect(transcribe({ apiKey, audio: clip }, {
      fetchImpl: async () => new Response('{"success":true,"transcript":"hello"}', { headers: { 'Content-Type': 'text/html' } }),
    })).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
  });
});

describe('Recall Gnani TTS', () => {
  it('requests the documented 24 kHz mono 16-bit WAV and returns the binary bytes unchanged', async () => {
    const fetchImpl = vi.fn(async () => ttsResponse());
    const result = await synthesize({ apiKey, text: ' Test audio. ', language: 'en-IN', speed: 1.05 }, { fetchImpl });
    expect(result).toEqual({ audio: speech, mimeType: 'audio/wav', sampleRate: 24000, durationSeconds: 0.1 });
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.vachana.ai/api/v1/tts/inference');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(init.headers).toEqual({ 'X-API-Key-ID': apiKey, 'Content-Type': 'application/json', Accept: 'audio/wav' });
    expect(JSON.parse(init.body)).toEqual({
      text: 'Test audio.', model: 'timbre-v3.0', voice: 'Shivani', language: 'en-IN', speed: 1.05,
      audio_config: { encoding: 'linear_pcm', container: 'wav', num_channels: 1, sample_width: 2, sample_rate: 24000 },
    });
  });

  it('supports the separate Timbre v2.5/Nalini catalog without fallback', async () => {
    const fetchImpl = vi.fn(async () => ttsResponse());
    await synthesize({ apiKey, text: 'नमस्ते', model: 'timbre-v2.5', language: 'hi-IN' }, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ model: 'timbre-v2.5', voice: 'Nalini', language: 'hi-IN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { model: 'timbre-v3.0', voice: 'Nalini' }, { model: 'timbre-v2.5', voice: 'Shivani' },
    { model: 'unknown' }, { voice: 'unknown' }, { language: 'xx-XX' },
    { speed: 0.84 }, { speed: 1.16 }, { speed: NaN }, { speed: 'fast' },
  ])('rejects incompatible/invalid options locally %#', async extra => {
    const fetchImpl = vi.fn();
    await expect(synthesize({ apiKey, text: 'test', ...extra }, { fetchImpl })).rejects.toHaveProperty('code', 'INVALID_REQUEST');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  ', {}, 'a'.repeat(LIMITS.textCharacters + 1)])('rejects missing/empty/oversized text %#', async text => {
    const fetchImpl = vi.fn();
    await expect(synthesize({ apiKey, text }, { fetchImpl })).rejects.toHaveProperty('code', 'INVALID_TEXT');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', Buffer.alloc(0)], ['JSON masquerading as audio', Buffer.from('{"audio":"base64"}')],
    ['base64 masquerading as audio', Buffer.from(speech.toString('base64'))],
    ['truncated WAV', speech.subarray(0, -2)], ['wrong sample rate', clip],
    ['stereo', wav({ sampleRate: 24000, channels: 2 })],
  ])('rejects %s responses', async (_label, audio) => {
    await expect(synthesize({ apiKey, text: 'test' }, { fetchImpl: async () => ttsResponse(audio) })).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
  });

  it.each(['application/json', 'application/octet-stream', 'audio/mpeg', ''])('rejects the wrong or missing WAV content type: %s', async type => {
    await expect(synthesize({ apiKey, text: 'test' }, {
      fetchImpl: async () => ttsResponse(speech, { 'Content-Type': type }),
    })).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
  });
});

describe.each(operations)('%s request safety', (_label, call) => {
  it.each([undefined, '', '  '])('requires a key without making a request %#', async apiKey => {
    const fetchImpl = vi.fn();
    await expect(call({ fetchImpl }, { apiKey })).rejects.toHaveProperty('code', 'AUTH_REQUIRED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects control characters in the key locally', async () => {
    const fetchImpl = vi.fn();
    await expect(call({ fetchImpl }, { apiKey: 'private\r\nheader' })).rejects.toHaveProperty('code', 'INVALID_REQUEST');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, LIMITS.maxTimeoutMs + 1])('rejects invalid timeout %s without fetch', async timeoutMs => {
    const fetchImpl = vi.fn();
    await expect(call({ fetchImpl, timeoutMs })).rejects.toHaveProperty('code', 'INVALID_REQUEST');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, { detail: { error_code: 'INVALID_API_KEY', message: apiKey } }, 'AUTH_FAILED'],
    [402, { message: 'insufficient credits' }, 'QUOTA_EXCEEDED'],
    [403, { success: false, error: { type: 'FORBIDDEN', message: apiKey } }, 'FORBIDDEN'],
    [429, { detail: { error_code: 'RATE_LIMITED', message: apiKey } }, 'RATE_LIMITED'],
    [400, { success: false, error: { type: 'INVALID_CONTEXT', message: apiKey } }, 'INVALID_REQUEST'],
    [400, { success: false, message: apiKey, status_code: 400 }, 'INVALID_REQUEST'],
    [422, { detail: [{ loc: ['body', 'text'], msg: apiKey, input: 'private input' }] }, 'INVALID_REQUEST'],
    [504, { code: 'UPSTREAM_TIMEOUT', error: 'Gateway Timeout', message: apiKey }, 'UPSTREAM_TIMEOUT'],
    [503, { success: false, error: { type: 'SERVICE_UNAVAILABLE', message: apiKey } }, 'SERVICE_UNAVAILABLE'],
  ])('sanitizes HTTP %s across nested, flat and validation shapes', async (status, body, code) => {
    const fetchImpl = vi.fn(async () => json(body, status));
    const error = await call({ fetchImpl }).catch(e => e);
    expect(error).toMatchObject({ name: 'GnaniSpeechError', code, status });
    expect(error.message + error.stack + JSON.stringify(error)).not.toContain(apiKey);
    expect(error.message + JSON.stringify(error)).not.toContain('private input');
    expect(error.cause).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no automatic billable retries
  });

  it('maps non-JSON error bodies by status and never exposes server text', async () => {
    const error = await call({ fetchImpl: async () => new Response(apiKey, { status: 429, headers: { 'Content-Type': 'text/html' } }) }).catch(e => e);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).not.toContain(apiKey);
  });

  it('sanitizes thrown network failures', async () => {
    const error = await call({ fetchImpl: async () => { throw new Error(`network leaked ${apiKey}`); } }).catch(e => e);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message + error.stack).not.toContain(apiKey);
  });

  it('rejects pre-cancelled requests before fetch, ignoring a private abort reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error(apiKey));
    const fetchImpl = vi.fn();
    await expect(call({ fetchImpl }, { signal: controller.signal })).rejects.toHaveProperty('code', 'CANCELLED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels an in-flight fetch even if the injected fetch ignores abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const result = call({ fetchImpl }, { signal: controller.signal }).catch(e => e);
    controller.abort(new Error(apiKey));
    const error = await result;
    expect(error.code).toBe('CANCELLED');
    expect(error.message + error.stack).not.toContain(apiKey);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('enforces the whole-request deadline even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const result = call({ fetchImpl, timeoutMs: 20 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toHaveProperty('code', 'TIMEOUT');
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards and cancels a response arriving after caller cancellation', async () => {
    let finish;
    const cancelled = vi.fn();
    const controller = new AbortController();
    const fetchImpl = () => new Promise(resolve => { finish = resolve; });
    const result = call({ fetchImpl }, { signal: controller.signal }).catch(e => e);
    controller.abort();
    expect(await result).toHaveProperty('code', 'CANCELLED');
    finish(new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'Content-Type': _label === 'STT' ? 'application/json' : 'audio/wav' },
    }));
    await new Promise(resolve => setImmediate(resolve));
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cleans up the deadline and caller listener after success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetchImpl = vi.fn(async () => _label === 'STT' ? sttResponse() : ttsResponse());
    await call({ fetchImpl }, { signal: controller.signal });
    controller.abort();
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['abort', 'timeout'])('cancels a stalled response body on %s', async mode => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancelled = vi.fn();
    const stream = new ReadableStream({ cancel: cancelled });
    const fetchImpl = async () => new Response(stream, { headers: { 'Content-Type': _label === 'STT' ? 'application/json' : 'audio/wav' } });
    const result = call({ fetchImpl, timeoutMs: 20 }, { signal: controller.signal }).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(20);
    expect(await result).toHaveProperty('code', mode === 'abort' ? 'CANCELLED' : 'TIMEOUT');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps declared response size without consuming the body', async () => {
    const cancelled = vi.fn();
    await expect(call({ fetchImpl: async () => new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'Content-Type': _label === 'STT' ? 'application/json' : 'audio/wav', 'Content-Length': String(LIMITS.audioBytes + 1) },
    }) })).rejects.toHaveProperty('code', 'RESPONSE_TOO_LARGE');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('caps streamed response size even with a misleading small Content-Length', async () => {
    const cancelled = vi.fn();
    const cap = _label === 'STT' ? LIMITS.transcriptBytes : LIMITS.audioBytes;
    const stream = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(cap)); c.enqueue(new Uint8Array(1)); }, cancel: cancelled,
    });
    await expect(call({ fetchImpl: async () => new Response(stream, {
      headers: { 'Content-Type': _label === 'STT' ? 'application/json' : 'audio/wav', 'Content-Length': '1' },
    }) })).rejects.toHaveProperty('code', 'RESPONSE_TOO_LARGE');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('caps error bodies too', async () => {
    await expect(call({ fetchImpl: async () => new Response('x'.repeat(LIMITS.errorBytes + 1), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    }) })).rejects.toHaveProperty('code', 'RESPONSE_TOO_LARGE');
  });

  it('rejects non-200 success statuses', async () => {
    await expect(call({ fetchImpl: async () => new Response(null, { status: 204 }) })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 204 });
  });
});
