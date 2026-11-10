// Main-process Recall transport only. No config, logging, filesystem or meeting-provider imports.
// Contracts checked 2026-11-10:
// https://docs.gnani.ai/api/STT/speech-to-text
// https://docs.gnani.ai/api/TTS/tts-inference
// https://docs.gnani.ai/api/TTS/available-voices
const STT_URL = 'https://api.vachana.ai/stt/v3';
const TTS_URL = 'https://api.vachana.ai/api/v1/tts/inference';
const LIMITS = Object.freeze({
  clipSeconds: 25, // application cap; Gnani REST permits 30 seconds
  uploadBytes: 3 * 1024 * 1024,
  transcriptBytes: 64 * 1024,
  audioBytes: 4 * 1024 * 1024,
  errorBytes: 16 * 1024,
  textCharacters: 2000, // application cap, not a published Gnani text limit
  timeoutMs: 30000,
  maxTimeoutMs: 60000,
});
const LANGUAGES = new Set(['auto', 'hi-IN', 'en-IN', 'hi-en', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'pa-IN', 'bn-IN', 'gu-IN']);
const VOICES = {
  'timbre-v3.0': new Set('Shivani Lakshmi Kalpana Chetana Vasudha Riyaa Tarika Avinash Shubham Prakash Devansh Yashraj Harshad'.split(' ')),
  'timbre-v2.5': new Set('Ambuja Asmita Bhavna Brinda Chitra Deepak Devika Dhruva Falak Girish Hemraj Ishaan Jalaj Jwala Kaveri Kavin Kirra Lavanya Lehara Mehuli Nalini Noopur Omkar Poorvi Pranav Reshma Riyaan Roopesh Saanvi Shlok Suhana Trisha Trupti Urmila Varuni Vedika Veera Vikrant Yashvi Yukti Zahira Zayan'.split(' ')),
};
const MESSAGES = {
  AUTH_REQUIRED: 'Add a Gnani API key to use Recall speech.',
  AUTH_FAILED: 'Gnani rejected the API key. Check the Recall speech credential.',
  FORBIDDEN: 'Gnani denied speech access. Check service scopes, account status and credits.',
  QUOTA_EXCEEDED: 'Gnani speech credits are unavailable. Check the account balance.',
  RATE_LIMITED: 'Gnani speech is rate limited. Wait for the current request to finish before retrying.',
  INVALID_REQUEST: 'Gnani speech request is invalid. Check the audio, model, voice and language.',
  SERVICE_UNAVAILABLE: 'Gnani speech is temporarily unavailable. Try again later.',
  UPSTREAM_TIMEOUT: 'Gnani could not finish the speech request in time. Try a shorter clip.',
  HTTP_ERROR: 'Gnani returned an unexpected HTTP status.',
  NETWORK_ERROR: 'Could not reach Gnani speech. Check the connection and try again.',
  TIMEOUT: 'Gnani speech request timed out.',
  CANCELLED: 'Recall speech request was cancelled.',
  INVALID_AUDIO: 'Recall speech requires a valid non-empty mono 16-bit PCM WAV clip at 8000–48000 Hz.',
  AUDIO_TOO_LONG: 'Recall speech clips must be 25 seconds or shorter.',
  AUDIO_TOO_LARGE: 'Recall speech clip exceeds the upload size limit.',
  INVALID_TEXT: 'Recall speech requires non-empty text within the text size limit.',
  INVALID_RESPONSE: 'Gnani returned an invalid speech response.',
  RESPONSE_TOO_LARGE: 'Gnani speech response exceeds the size limit.',
  NO_SPEECH: 'No speech was detected. Record a new clip to try again.',
  INCOMPLETE_TRANSCRIPT: 'Gnani returned an incomplete transcript. Record a shorter clip.',
};

class GnaniSpeechError extends Error {
  constructor(code, status) {
    super(MESSAGES[code]);
    this.name = 'GnaniSpeechError';
    this.code = code;
    if (status !== undefined) this.status = status;
    // Never retain provider text, response bodies, credentials, abort reasons or causes.
  }
}
const fail = (code, status) => { throw new GnaniSpeechError(code, status); };

function keyHeader(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('AUTH_REQUIRED');
  const key = apiKey.trim();
  if (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) fail('INVALID_REQUEST');
  return key;
}

// Intentionally accepts PCM WAV only: duration is checked from actual samples, not caller metadata.
// Handles ancillary chunks/padding; rejects incomplete RIFF/data and contradictory format fields.
function inspectWav(bytes, errorCode) {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' ||
      bytes.toString('latin1', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail(errorCode);
  let format;
  let dataBytes;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > bytes.length) fail(errorCode);
    if (id === 'fmt ') {
      if (format || size < 16) fail(errorCode);
      format = {
        encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') {
      if (dataBytes !== undefined) fail(errorCode);
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }
  if (offset !== bytes.length || !format || !dataBytes || format.encoding !== 1 ||
      format.channels !== 1 || format.bits !== 16 || format.blockAlign !== 2 ||
      format.sampleRate < 8000 || format.sampleRate > 48000 ||
      format.byteRate !== format.sampleRate * 2 || dataBytes % 2) fail(errorCode);
  return { sampleRate: format.sampleRate, durationSeconds: dataBytes / format.byteRate };
}

function cancelBody(response) {
  // Do not await cancellation: a broken server/stream must not extend the request deadline.
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* already locked */ }
}

async function readBounded(response, cap, signal) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > cap) {
    cancelBody(response);
    fail('RESPONSE_TOO_LARGE');
  }
  if (signal.aborted) { cancelBody(response); fail('CANCELLED'); }
  if (!response.body?.getReader) fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail('CANCELLED');
      if (done) break;
      size += value.byteLength;
      if (size > cap) { abort(); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

const contentType = (response) => (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
const isJson = (response) => /^application\/(?:[a-z0-9.-]+\+)?json$/.test(contentType(response));

function providerError(status, data) {
  // Recognize codes from nested STT, flat TTS/timeout and auth-detail shapes, never echo messages.
  const code = data?.error?.type || data?.detail?.error_code || data?.code;
  if (status === 401) fail('AUTH_FAILED', status);
  if (status === 402) fail('QUOTA_EXCEEDED', status);
  if (status === 403) fail('FORBIDDEN', status);
  if (status === 429) fail('RATE_LIMITED', status);
  if (status === 504) fail('UPSTREAM_TIMEOUT', status);
  if (status >= 500) fail('SERVICE_UNAVAILABLE', status);
  if (status === 400 || status === 422 || Array.isArray(data?.detail)) fail('INVALID_REQUEST', status);
  // Also reject a provider error envelope incorrectly returned with HTTP 200.
  const known = {
    MISSING_API_KEY: 'AUTH_FAILED', INVALID_API_KEY: 'AUTH_FAILED', SCOPE_NOT_ALLOWED: 'FORBIDDEN',
    FORBIDDEN: 'FORBIDDEN', RATE_LIMITED: 'RATE_LIMITED', UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  };
  if (Object.hasOwn(known, code)) fail(known[code], status);
  fail(status === 200 ? 'INVALID_RESPONSE' : 'HTTP_ERROR', status);
}

async function validateStatus(response, signal) {
  if (response.status === 200) return;
  // Non-JSON (e.g. proxy HTML) errors still map by HTTP status without exposing their body.
  let data;
  if (isJson(response)) {
    const bytes = await readBounded(response, LIMITS.errorBytes, signal);
    try { data = JSON.parse(bytes.toString('utf8')); } catch { /* status remains authoritative */ }
  } else cancelBody(response);
  providerError(response.status, data);
}

async function request({ signal, timeoutMs = LIMITS.timeoutMs, fetchImpl = globalThis.fetch }, operation) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.maxTimeoutMs ||
      typeof fetchImpl !== 'function' || (signal && !(signal instanceof AbortSignal))) fail('INVALID_REQUEST');
  if (signal?.aborted) fail('CANCELLED');
  const controller = new AbortController();
  let abortCode = 'CANCELLED';
  const cancel = () => controller.abort(); // caller's reason may contain private data
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new GnaniSpeechError(abortCode)), { once: true });
  });
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { abortCode = 'TIMEOUT'; controller.abort(); }, timeoutMs);
  try {
    // The race also bounds injected fetch implementations that ignore AbortSignal.
    const result = await Promise.race([operation(fetchImpl, controller.signal), aborted]);
    if (controller.signal.aborted) fail(abortCode);
    return result;
  } catch (err) {
    if (controller.signal.aborted) fail(abortCode);
    if (err instanceof GnaniSpeechError) throw err;
    fail('NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Resolves { text } only for a complete non-empty transcript; no partial text on errors. */
async function transcribe({ apiKey, audio, signal } = {}, deps = {}) {
  const key = keyHeader(apiKey);
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) fail('INVALID_AUDIO');
  if (audio.byteLength > LIMITS.uploadBytes) fail('AUDIO_TOO_LARGE');
  const bytes = Buffer.from(audio); // snapshot caller-owned bytes before awaiting
  const wav = inspectWav(bytes, 'INVALID_AUDIO');
  if (wav.durationSeconds > LIMITS.clipSeconds) fail('AUDIO_TOO_LONG');
  return request({ ...deps, signal }, async (fetchImpl, requestSignal) => {
    const body = new FormData();
    body.append('audio_file', new Blob([bytes], { type: 'audio/wav' }), 'recall.wav');
    body.append('model', 'prisma-v3.0');
    body.append('language_code', 'hi-IN,en-IN');
    body.append('format', 'transcribe');
    const response = await fetchImpl(STT_URL, {
      method: 'POST', headers: { 'X-API-Key-ID': key, Accept: 'application/json' },
      body, signal: requestSignal, redirect: 'error', cache: 'no-store',
      // FormData sets Content-Type with its own multipart boundary.
    });
    await validateStatus(response, requestSignal);
    if (!isJson(response)) { cancelBody(response); fail('INVALID_RESPONSE'); }
    const raw = await readBounded(response, LIMITS.transcriptBytes, requestSignal);
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_RESPONSE'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_RESPONSE');
    if (data.success !== true) providerError(200, data);
    if (typeof data.transcript !== 'string' ||
        (data.truncated !== undefined && typeof data.truncated !== 'boolean') ||
        (data.model !== undefined && data.model !== 'prisma-v3.0')) fail('INVALID_RESPONSE');
    if (data.truncated === true) fail('INCOMPLETE_TRANSCRIPT');
    const text = data.transcript.trim();
    if (!text) fail('NO_SPEECH');
    return { text };
  });
}

/** Resolves { audio: Buffer, mimeType, sampleRate, durationSeconds }; audio is a full PCM WAV. */
async function synthesize({ apiKey, text, model = 'timbre-v3.0', voice, language = 'auto', speed = 1, signal } = {}, deps = {}) {
  const key = keyHeader(apiKey);
  if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.textCharacters) fail('INVALID_TEXT');
  const chosenVoice = voice ?? (model === 'timbre-v2.5' ? 'Nalini' : 'Shivani');
  if (!Object.hasOwn(VOICES, model) || !VOICES[model].has(chosenVoice) || !LANGUAGES.has(language) ||
      typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.85 || speed > 1.15) fail('INVALID_REQUEST');
  return request({ ...deps, signal }, async (fetchImpl, requestSignal) => {
    const response = await fetchImpl(TTS_URL, {
      method: 'POST', headers: { 'X-API-Key-ID': key, 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        text: text.trim(), model, voice: chosenVoice, language, speed,
        audio_config: { encoding: 'linear_pcm', container: 'wav', num_channels: 1, sample_width: 2, sample_rate: 24000 },
      }),
      signal: requestSignal, redirect: 'error', cache: 'no-store',
    });
    await validateStatus(response, requestSignal);
    if (contentType(response) !== 'audio/wav') { cancelBody(response); fail('INVALID_RESPONSE'); }
    const audio = await readBounded(response, LIMITS.audioBytes, requestSignal);
    const wav = inspectWav(audio, 'INVALID_RESPONSE');
    if (wav.sampleRate !== 24000) fail('INVALID_RESPONSE');
    return { audio, mimeType: 'audio/wav', ...wav };
  });
}

module.exports = { transcribe, synthesize, GnaniSpeechError, LIMITS };
