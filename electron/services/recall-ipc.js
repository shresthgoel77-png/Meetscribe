// Main-only capability boundary. No renderer receives config, credentials or arbitrary IPC.
const { randomUUID } = require('crypto');
const gnani = require('../providers/speech/gnani');
const { createRecallService } = require('./recall');
const registrations = new WeakMap();
const CHANNELS = Object.freeze({
  open: 'recall:open', close: 'recall:close', state: 'recall:get-state', text: 'recall:submit-text',
  audio: 'recall:submit-audio', cancel: 'recall:cancel', source: 'recall:open-source', resize: 'recall:resize',
  testStt: 'recall:test-stt', testTts: 'recall:test-tts', testLlm: 'recall:test-llm',
});
const EVENTS = Object.freeze({ stage: 'recall:stage', answer: 'recall:answer', audio: 'recall:audio', error: 'recall:error' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODES = Object.freeze({ INVALID_REQUEST: 'Invalid Recall request.', NOT_READY: 'Recall is not ready. Check the window, credentials and model settings.',
  BUSY: 'Another Recall operation is active. Stop it or wait before testing speech.', NO_SPEECH: 'No speech was detected.',
  INCOMPLETE_TRANSCRIPT: 'Speech was incomplete. Record a shorter clip.', INVALID_ANSWER: 'The answer could not be verified.',
  SOURCE_CHANGED: 'Saved evidence changed. Please ask again.', RATE_LIMITED: 'Recall is rate limited. Please try later.',
  UNAVAILABLE: 'Recall is temporarily unavailable.', TIMEOUT: 'Recall timed out.', CANCELLED: 'Recall was cancelled.' });
const PUBLIC_STAGES = new Set(['idle', 'transcribing', 'retrieving', 'answering', 'speaking']);
const idOk = id => typeof id === 'string' && UUID.test(id);
const fail = code => { throw Object.assign(new Error(CODES[code]), { code }); };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) fail('INVALID_REQUEST');
}
function request(value, required = [], optional = []) {
  shape(value, ['requestId', ...required], optional);
  if (!idOk(value.requestId)) fail('INVALID_REQUEST');
}
function question(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000 || Buffer.byteLength(value.trim(), 'utf8') > 4000) fail('INVALID_REQUEST');
  return value.trim();
}
function locale(value) {
  if (value !== undefined && (typeof value !== 'string' || value.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value))) fail('INVALID_REQUEST');
}
function credential(value) {
  if (typeof value !== 'string' || !value.trim()) fail('NOT_READY');
  if (value.length > 4096 || !/^[\x21-\x7e]+$/.test(value.trim())) fail('INVALID_REQUEST');
  return value.trim();
}
function publicError(error) {
  const code = error?.code;
  let mapped = Object.hasOwn(CODES, code) ? code : 'UNAVAILABLE';
  if (['AUTH_REQUIRED', 'AUTH_FAILED', 'FORBIDDEN', 'QUOTA_EXCEEDED'].includes(code) || [401, 402, 403, 404].includes(error?.status)) mapped = 'NOT_READY';
  if (['INVALID_AUDIO', 'AUDIO_TOO_LONG', 'AUDIO_TOO_LARGE', 'INVALID_TEXT'].includes(code)) mapped = 'INVALID_REQUEST';
  if (code === 'UPSTREAM_TIMEOUT') mapped = 'TIMEOUT';
  if (error?.status === 429) mapped = 'RATE_LIMITED';
  return { code: mapped, message: CODES[mapped], retryable: ['UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'SOURCE_CHANGED'].includes(mapped) };
}
function failure(requestId, error) {
  const clean = publicError(error);
  return { requestId: idOk(requestId) ? requestId : null, status: clean.code === 'CANCELLED' ? 'cancelled' : 'error', error: clean };
}
function inputAudio(audio, mimeType) {
  if (mimeType !== 'audio/wav' || !(audio instanceof ArrayBuffer || audio instanceof Uint8Array) ||
      (audio instanceof Uint8Array && !(audio.buffer instanceof ArrayBuffer)) || audio.byteLength > gnani.LIMITS.uploadBytes) fail('INVALID_REQUEST');
  // Buffer.from(view) copies exactly the selected view; never expose its backing allocation.
  const copy = Buffer.from(audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio);
  gnani.validateClip(copy);
  return copy;
}
function outputAudio(result) {
  if (result?.mimeType !== 'audio/wav') fail('UNAVAILABLE');
  const info = gnani.validateOutputAudio(result.audio);
  return { audio: Uint8Array.from(result.audio), mimeType: 'audio/wav', ...info };
}
function ttsOptions(values, text) {
  if (['recallTtsModel', 'recallTtsVoice', 'recallTtsLanguage'].some(k => typeof values[k] !== 'string' || !values[k] || values[k].length > 64)) fail('INVALID_REQUEST');
  const options = { text, model: values.recallTtsModel, voice: values.recallTtsVoice, language: values.recallTtsLanguage };
  gnani.validateTtsOptions(options); return options;
}

function registerRecallIpc(deps) {
  const { ipcMain, getMainWindow, getOverlayWindow = () => null } = deps;
  if (registrations.has(ipcMain)) return registrations.get(ipcMain);
  const getConfig = deps.getConfig || (() => require('../utils/config').getConfig());
  const registry = deps.llmRegistry || require('../providers').llmRegistry;
  const speech = deps.speech || gnani;
  let recallWindow = null;
  let recallContents = null;
  let disposed = false;
  let turn = null;
  let settings = null;
  let speechOwner = null;
  let latestAnswer = null;
  const watches = new Map();
  const ledgers = new Map();
  const windowFor = role => role === 'main' ? getMainWindow() : role === 'overlay' ? getOverlayWindow() : recallWindow;
  function alive(win) { return !!win && !win.isDestroyed() && !!win.webContents && !win.webContents.isDestroyed(); }
  function ownerAlive(owner) {
    try { return !disposed && windowFor(owner.role) === owner.win && alive(owner.win) && owner.wc === owner.win.webContents &&
      owner.frame === owner.wc.mainFrame && owner.frame.parent === null && !owner.frame.detached &&
      watches.get(owner.wc)?.epoch === owner.epoch; } catch { return false; }
  }
  function closeService() { service.close({ requestId: randomUUID() }); latestAnswer = null; }
  function invalidate(wc) {
    const watch = watches.get(wc); if (watch) watch.epoch++;
    for (const job of [turn, settings]) if (job?.owner.wc === wc) {
      job.controller.abort(Object.assign(new Error(CODES.CANCELLED), { code: 'CANCELLED' }));
      if (job === turn) turn = null;
      if (job === settings) settings = null;
    }
    ledgers.delete(wc);
    if (recallContents === wc) closeService();
  }
  function watch(win) {
    const wc = win.webContents;
    if (watches.has(wc)) return;
    const nav = (details, _url, isInPlace, isMainFrame) => {
      if ((details?.isMainFrame ?? isMainFrame) && !(details?.isSameDocument ?? isInPlace)) invalidate(wc);
    };
    const gone = () => { invalidate(wc); unwatch(wc); };
    const crash = () => invalidate(wc);
    watches.set(wc, { epoch: 0, nav, gone, crash });
    wc.on('did-start-navigation', nav); wc.on('destroyed', gone); wc.on('render-process-gone', crash);
  }
  function unwatch(wc) {
    const w = watches.get(wc); if (!w) return;
    wc.removeListener('did-start-navigation', w.nav); wc.removeListener('destroyed', w.gone); wc.removeListener('render-process-gone', w.crash);
    watches.delete(wc);
  }
  function authorize(event, roles) {
    for (const role of roles) {
      const win = windowFor(role);
      if (alive(win) && event?.sender === win.webContents && event.senderFrame && event.senderFrame === win.webContents.mainFrame &&
          event.senderFrame.parent === null && !event.senderFrame.detached) {
        watch(win); return { role, win, wc: win.webContents, frame: event.senderFrame, epoch: watches.get(win.webContents).epoch };
      }
    }
    fail('INVALID_REQUEST');
  }
  function acceptId(owner, requestId) {
    const ledger = ledgers.get(owner.wc) || new Set();
    if (ledger.has(requestId)) fail('INVALID_REQUEST');
    if (ledger.size >= 64) fail('NOT_READY');
    ledger.add(requestId); ledgers.set(owner.wc, ledger);
  }
  function current(job) {
    return ownerAlive(job.owner) && (job.kind === 'turn' ? turn === job : settings === job);
  }
  function assertCurrent(job) {
    if (performance.now() >= job.expiresAt) job.controller.abort(Object.assign(new Error(CODES.TIMEOUT), { code: 'TIMEOUT' }));
    if (!current(job) || job.controller.signal.aborted) throw job.controller.signal.reason || Object.assign(new Error(CODES.CANCELLED), { code: 'CANCELLED' });
  }
  function send(job, channel, data, terminal = false) {
    if (!current(job) || (!terminal && job.controller.signal.aborted)) return false;
    try { job.owner.frame.send(channel, { ...data, requestId: job.id }); return true; }
    catch { job.controller.abort(Object.assign(new Error(CODES.CANCELLED), { code: 'CANCELLED' })); return false; }
  }
  function stage(job, name, status = 'running') {
    job.stage = name; send(job, EVENTS.stage, { stage: name, status }, status !== 'running');
  }
  const service = (deps.createService || createRecallService)({ ...deps.serviceDeps, getConfig,
    getRecordingState: deps.getRecordingState, onEvent: event => {
      if (turn?.id === event.requestId && PUBLIC_STAGES.has(event.stage) && event.status === 'running') stage(turn, event.stage);
    } });
  function reserveSpeech(job) { if (speechOwner) fail('BUSY'); speechOwner = job; }
  async function speechScope(job, run) {
    try { return await run(); } finally { if (speechOwner === job) speechOwner = null; }
  }
  async function execute(job, run, timeoutMs) {
    job.expiresAt = performance.now() + timeoutMs;
    const timer = setTimeout(() => job.controller.abort(Object.assign(new Error(CODES.TIMEOUT), { code: 'TIMEOUT' })), timeoutMs);
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(job.controller.signal.reason);
      job.controller.signal.addEventListener('abort', abort, { once: true });
      if (job.controller.signal.aborted) abort();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => { assertCurrent(job); job.started = true; return run(); }), cancelled]);
      assertCurrent(job); stage(job, 'idle', 'complete'); return { requestId: job.id, status: 'complete', ...result };
    } catch (error) {
      const response = failure(job.id, job.controller.signal.aborted ? job.controller.signal.reason : error);
      send(job, EVENTS.error, { stage: job.stage || 'idle', error: response.error }, true);
      stage(job, 'idle', response.status === 'cancelled' ? 'cancelled' : 'error'); return response;
    } finally {
      clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort);
      if (!job.started && speechOwner === job) speechOwner = null;
      if (turn === job) turn = null;
      if (settings === job) settings = null;
    }
  }
  function newJob(owner, id, kind) { return { owner, id, kind, controller: new AbortController(), stage: 'idle' }; }
  function speechConfig(cfg) {
    if (cfg.recallSttModel !== 'prisma-v3.0' || cfg.recallSttLanguage !== 'hi-IN,en-IN') fail('NOT_READY');
    return credential(cfg.recallGnaniApiKey);
  }
  async function pipeline(job, payload, cfg, audio) {
    let text = payload.question;
    if (audio) {
      stage(job, 'transcribing');
      const result = await speech.transcribe({ apiKey: speechConfig(cfg), audio, signal: job.controller.signal }, deps.speechDeps);
      assertCurrent(job); text = question(result?.text);
    }
    const answer = await service.ask({ requestId: job.id, question: text, locale: payload.locale, signal: job.controller.signal });
    assertCurrent(job);
    if (answer.requestId !== job.id || !['answered', 'insufficient_evidence'].includes(answer.status)) {
      if (answer.error) throw answer.error;
      fail('INVALID_ANSWER');
    }
    if (bytes(answer) > 65536) fail('INVALID_ANSWER');
    // Service alone constructs sources; IPC never accepts client evidence/locators.
    if (!send(job, EVENTS.answer, answer)) fail('CANCELLED');
    latestAnswer = { id: job.id, owner: job.owner };
    if (audio && !(payload.muted ?? cfg.recallMuted)) {
      assertCurrent(job); stage(job, 'speaking');
      const result = await speech.synthesize({ apiKey: speechConfig(cfg), ...ttsOptions(cfg, answer.text), signal: job.controller.signal }, deps.speechDeps);
      assertCurrent(job); send(job, EVENTS.audio, outputAudio(result));
    }
    return {};
  }
  function startTurn(owner, payload, audio) {
    if (turn) fail('BUSY');
    if (audio && speechOwner) fail('BUSY');
    const cfg = getConfig();
    if (audio) { speechConfig(cfg); if (!(payload.muted ?? cfg.recallMuted)) ttsOptions(cfg, 'Recall'); }
    acceptId(owner, payload.requestId);
    const job = newJob(owner, payload.requestId, 'turn');
    turn = job; latestAnswer = null;
    if (audio) reserveSpeech(job);
    // A speech lease lasts until the underlying pipeline settles, including an abort-ignoring
    // dependency. A cancelled promise cannot silently permit an overlapping settings test.
    const run = () => audio ? speechScope(job, () => pipeline(job, payload, cfg, audio)) : pipeline(job, payload, cfg);
    void execute(job, run, audio ? 90000 : 30000);
    return { requestId: job.id, status: 'running' };
  }
  function preferences(cfg) {
    return { recallSttModel: cfg.recallSttModel, recallSttLanguage: cfg.recallSttLanguage,
      recallTtsModel: cfg.recallTtsModel, recallTtsVoice: cfg.recallTtsVoice, recallTtsLanguage: cfg.recallTtsLanguage,
      recallLlmProvider: cfg.recallLlmProvider, recallLlmModels: Object.fromEntries(registry.list().flatMap(p => {
        const model = cfg.recallLlmModels?.[p.id]; return typeof model === 'string' && model.length <= 200 ? [[p.id, model]] : [];
      })), recallShortcut: cfg.recallShortcut,
      recallStartupMode: cfg.recallStartupMode, recallMuted: cfg.recallMuted, recallContextBudget: cfg.recallContextBudget };
  }
  const handlers = new Map();
  function handle(channel, roles, run) {
    handlers.set(channel, async (event, payload, ...extra) => {
      try {
        if (disposed) fail('NOT_READY');
        const owner = authorize(event, roles);
        if (extra.length) fail('INVALID_REQUEST');
        return await run(owner, payload);
      } catch (error) { return failure(payload?.requestId, error); }
    });
  }
  handle(CHANNELS.open, ['main', 'overlay', 'recall'], (_owner, p) => {
    request(p); if (!alive(recallWindow)) fail('NOT_READY'); recallWindow.show(); recallWindow.focus();
    return { requestId: p.requestId, status: 'complete', opened: true };
  });
  handle(CHANNELS.close, ['main', 'recall'], (_owner, p) => {
    request(p); if (recallWindow) { invalidate(recallContents); if (alive(recallWindow)) recallWindow.close(); }
    else closeService();
    return { requestId: p.requestId, status: 'complete' };
  });
  handle(CHANNELS.state, ['main', 'recall'], (_owner, p) => {
    request(p); const cfg = getConfig();
    const configured = registry.has(cfg.recallLlmProvider) && registry.isConfigured(registry.get(cfg.recallLlmProvider), cfg) &&
      !!cfg.recallLlmModels?.[cfg.recallLlmProvider];
    const valid = run => { try { run(); return true; } catch { return false; } };
    const sttConfigured = valid(() => speechConfig(cfg));
    const ttsConfigured = valid(() => { credential(cfg.recallGnaniApiKey); ttsOptions(cfg, 'Recall'); });
    const snapshot = service.getState(p);
    const state = { requestId: p.requestId, historyTurns: snapshot.historyTurns, historyBytes: snapshot.historyBytes,
      activeRequestId: turn?.id || null, stage: turn?.stage || 'idle',
      status: turn ? 'running' : 'complete', speechBusy: !!speechOwner, preferences: preferences(cfg),
      readiness: { text: { configured: !!configured, access: 'unverified' },
        stt: { configured: sttConfigured, access: 'unverified' },
        tts: { configured: ttsConfigured, access: 'unverified' }, shortcut: cfg.recallShortcut === '' ? 'disabled' : 'unregistered' },
      disclosures: { cloud: 'Questions and selected saved-meeting evidence go to the answering LLM. Voice audio and synthesized text go to Gnani.',
        loopback: 'System loopback may record spoken assistant answers, even through headphones. Mute or stop Recall audio; the meeting will not be paused.',
        explicitVoiceStart: true } };
    if (bytes(state) > 8192) fail('UNAVAILABLE'); return state;
  });
  handle(CHANNELS.text, ['recall'], (owner, p) => {
    request(p, ['question'], ['locale']); question(p.question); locale(p.locale); if (bytes(p) > 8192) fail('INVALID_REQUEST');
    return startTurn(owner, p);
  });
  handle(CHANNELS.audio, ['recall'], (owner, p) => {
    request(p, ['audio', 'mimeType'], ['locale', 'muted']); locale(p.locale);
    if (p.muted !== undefined && typeof p.muted !== 'boolean') fail('INVALID_REQUEST');
    return startTurn(owner, p, inputAudio(p.audio, p.mimeType));
  });
  handle(CHANNELS.cancel, ['main', 'recall'], (owner, p) => {
    request(p, ['targetRequestId']); if (!idOk(p.targetRequestId)) fail('INVALID_REQUEST');
    const job = owner.role === 'recall' ? turn : settings;
    if (!job || job.id !== p.targetRequestId || job.owner.wc !== owner.wc || job.owner.frame !== owner.frame) fail('INVALID_REQUEST');
    job.controller.abort(Object.assign(new Error(CODES.CANCELLED), { code: 'CANCELLED' }));
    if (job.kind === 'turn') service.cancel({ requestId: p.requestId, targetRequestId: job.id });
    return { requestId: p.requestId, status: 'complete', cancelled: true };
  });
  handle(CHANNELS.source, ['recall'], (owner, p) => {
    request(p, ['answerRequestId', 'evidenceId']);
    if (!idOk(p.answerRequestId) || typeof p.evidenceId !== 'string' || !/^E[0-9a-f]{24}$/.test(p.evidenceId)) fail('INVALID_REQUEST');
    if (!latestAnswer || latestAnswer.id !== p.answerRequestId || latestAnswer.owner.wc !== owner.wc ||
        latestAnswer.owner.frame !== owner.frame || latestAnswer.owner.epoch !== owner.epoch) fail('SOURCE_CHANGED');
    const result = service.resolveSource(p);
    const evidence = result.evidence[0]; if (!evidence || evidence.evidenceId !== p.evidenceId) fail('SOURCE_CHANGED');
    // Dispatch only. Existing renderer openSessionById retains its unsaved-navigation guard.
    if (!deps.openSource?.(evidence, p)) fail('UNAVAILABLE');
    return { requestId: p.requestId, status: 'complete', navigation: 'requested' };
  });
  handle(CHANNELS.resize, ['recall'], (owner, p) => {
    request(p, ['width', 'height']);
    if (!Number.isInteger(p.width) || p.width < 320 || p.width > 640 || !Number.isInteger(p.height) || p.height < 220 || p.height > 800) fail('INVALID_REQUEST');
    owner.win.setContentSize(p.width, p.height); return { requestId: p.requestId, status: 'complete' };
  });
  async function test(owner, p, kind) {
    request(p, kind === 'stt' ? ['values', 'audio', 'mimeType'] : kind === 'tts' ? ['values', 'text'] : ['values']);
    if (settings || (kind !== 'llm' && speechOwner)) fail('BUSY');
    const values = p.values;
    let audio; let selected; let model; let config;
    if (kind === 'stt') {
      shape(values, ['recallGnaniApiKey', 'recallSttModel', 'recallSttLanguage']); speechConfig(values);
      audio = inputAudio(p.audio, p.mimeType);
    } else if (kind === 'tts') {
      shape(values, ['recallGnaniApiKey', 'recallTtsModel', 'recallTtsVoice', 'recallTtsLanguage']); credential(values.recallGnaniApiKey);
      ttsOptions(values, p.text);
    } else {
      if (!values || typeof values.recallLlmProvider !== 'string' || !registry.has(values.recallLlmProvider)) fail('INVALID_REQUEST');
      selected = registry.get(values.recallLlmProvider);
      shape(values, ['recallLlmProvider', 'recallLlmModels', ...selected.credentials.map(f => f.configKey)]);
      shape(values.recallLlmModels, [selected.id]); model = values.recallLlmModels[selected.id];
      if (typeof model !== 'string' || !model.trim() || model.length > 200) fail('INVALID_REQUEST');
      config = Object.fromEntries(selected.credentials.map(f => [f.configKey, credential(values[f.configKey])]));
    }
    if (bytes({ ...p, audio: undefined }) > 8192) fail('INVALID_REQUEST');
    acceptId(owner, p.requestId); const job = newJob(owner, p.requestId, 'settings'); settings = job;
    if (kind !== 'llm') reserveSpeech(job);
    const run = async () => {
      stage(job, kind === 'stt' ? 'transcribing' : kind === 'tts' ? 'speaking' : 'answering');
      const signal = job.controller.signal;
      if (kind === 'stt') {
        const result = await speech.transcribe({ apiKey: values.recallGnaniApiKey, audio, signal }, deps.speechDeps);
        assertCurrent(job); return { test: 'stt', transcript: question(result?.text), verified: true };
      }
      if (kind === 'tts') {
        const result = await speech.synthesize({ apiKey: values.recallGnaniApiKey, ...ttsOptions(values, p.text), signal }, deps.speechDeps);
        assertCurrent(job); return { test: 'tts', verified: true, ...outputAudio(result) };
      }
      const raw = await selected.generate({ systemPrompt: 'Return ONLY JSON {"ok":true}. No other content.', userPrompt: 'JSON connectivity check.',
        config, model, json: true, signal, maxTokens: 512, maxResponseBytes: 8192 }, deps.providerDeps);
      assertCurrent(job);
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1024) fail('INVALID_ANSWER');
      let result; try { result = JSON.parse(raw); } catch { fail('INVALID_ANSWER'); }
      shape(result, ['ok']); if (result.ok !== true) fail('INVALID_ANSWER');
      return { test: 'llm', verified: true, provider: selected.id, model };
    };
    return execute(job, () => kind === 'llm' ? run() : speechScope(job, run), 30000);
  }
  handle(CHANNELS.testStt, ['main'], (owner, p) => test(owner, p, 'stt'));
  handle(CHANNELS.testTts, ['main'], (owner, p) => test(owner, p, 'tts'));
  handle(CHANNELS.testLlm, ['main'], (owner, p) => test(owner, p, 'llm'));
  const installed = [];
  try { for (const [channel, handler] of handlers) { ipcMain.handle(channel, handler); installed.push(channel); } }
  catch (error) { for (const channel of installed) ipcMain.removeHandler(channel); throw error; }
  const api = {
    attachRecallWindow(win) {
      if (disposed) fail('NOT_READY');
      if (recallWindow === win) return;
      if (win && (win === getMainWindow() || win === getOverlayWindow())) fail('INVALID_REQUEST');
      if (win && !alive(win)) fail('NOT_READY');
      if (recallContents) { invalidate(recallContents); unwatch(recallContents); }
      recallWindow = win; recallContents = win?.webContents || null; latestAnswer = null; if (win) watch(win);
    },
    dispose() {
      if (disposed) return;
      if (turn) turn.controller.abort(Object.assign(new Error(CODES.CANCELLED), { code: 'CANCELLED' }));
      if (settings) settings.controller.abort(Object.assign(new Error(CODES.CANCELLED), { code: 'CANCELLED' }));
      closeService(); disposed = true; turn = null; settings = null; recallWindow = null; recallContents = null;
      for (const wc of watches.keys()) unwatch(wc);
      ledgers.clear(); for (const channel of installed) ipcMain.removeHandler(channel);
      registrations.delete(ipcMain);
    },
  };
  registrations.set(ipcMain, api); return api;
}

module.exports = { registerRecallIpc, CHANNELS, EVENTS };
