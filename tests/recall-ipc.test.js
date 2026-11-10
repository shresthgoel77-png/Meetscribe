import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { registerRecallIpc, CHANNELS: C, EVENTS: E } = require('../electron/services/recall-ipc');
const { createRecallService } = require('../electron/services/recall');
const { llmRegistry } = require('../electron/providers');
const controllers = [];
let sequence = 0;
const id = () => randomUUID();
const wav = (seconds = 0.1, rate = 16000) => {
  const samples = Math.round(seconds * rate); const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40); return b;
};
function windowFixture() {
  const wc = new EventEmitter(); wc.id = ++sequence; wc.dead = false; wc.isDestroyed = () => wc.dead;
  wc.mainFrame = { parent: null, detached: false, processId: sequence, routingId: sequence, send: vi.fn() };
  const win = { webContents: wc, dead: false, isDestroyed() { return this.dead; }, show: vi.fn(), focus: vi.fn(), setContentSize: vi.fn() };
  win.close = vi.fn(() => { win.dead = true; wc.dead = true; wc.emit('destroyed'); }); return win;
}
const message = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const text = extra => ({ requestId: id(), question: 'Atlas budget?', ...extra });
const clip = extra => ({ requestId: id(), audio: wav(), mimeType: 'audio/wav', ...extra });
const stt = extra => ({ requestId: id(), audio: wav(), mimeType: 'audio/wav', values: {
  recallGnaniApiKey: 'unsaved-speech-key', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN' }, ...extra });
const tts = extra => ({ requestId: id(), text: 'Recall speech test.', values: {
  recallGnaniApiKey: 'unsaved-speech-key', recallTtsModel: 'timbre-v2.5', recallTtsVoice: 'Nalini', recallTtsLanguage: 'en-IN' }, ...extra });
const llm = extra => ({ requestId: id(), values: {
  recallLlmProvider: 'groq', recallLlmModels: { groq: 'selected-unsaved-model' }, groqApiKey: 'unsaved-llm-key' }, ...extra });
const success = requestId => ({ requestId, status: 'answered', text: 'Atlas budget is 50000.', claims: [], sources: [],
  coverage: { exhaustive: false }, uncertainty: [] });
function setup(options = {}) {
  const handlers = new Map([['old:channel', vi.fn(() => 'untouched')]]);
  const ipcMain = { handle: vi.fn((channel, fn) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel, fn); }),
    removeHandler: vi.fn(channel => handlers.delete(channel)) };
  const main = windowFixture(); const overlay = windowFixture(); const recall = windowFixture();
  const config = { recallGnaniApiKey: 'saved-speech-key', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN',
    recallTtsModel: 'timbre-v3.0', recallTtsVoice: 'Shivani', recallTtsLanguage: 'auto', recallLlmProvider: 'groq',
    recallLlmModels: { groq: 'saved-recall-model' }, recallShortcut: 'CommandOrControl+Shift+Space', recallStartupMode: 'text',
    recallMuted: false, recallContextBudget: 24000, groqApiKey: 'saved-llm-key', notionToken: 'private-notion-key',
    systemPrompt: 'PRIVATE NOTE PROMPT', llmProvider: 'gemini', llmModels: { gemini: 'meeting-model' }, ...options.config };
  const records = new Map([['atlas', { id: 'atlas', title: 'Atlas planning', status: 'complete', started_at: '2026-11-09T10:00:00Z',
    transcript: [], notes: { summary: 'Atlas budget is 50000.' } }]]);
  const db = { listSessions: vi.fn(() => structuredClone([...records.values()])), getSession: vi.fn(key => structuredClone(records.get(key) || null)) };
  let emitStage;
  const fakeService = { ask: vi.fn(async p => success(p.requestId)), cancel: vi.fn(), close: vi.fn(),
    getState: vi.fn(p => ({ requestId: p.requestId, historyTurns: 0, historyBytes: 2 })), resolveSource: vi.fn() };
  const speech = { transcribe: vi.fn(async () => ({ text: 'Atlas budget?' })),
    synthesize: vi.fn(async () => ({ audio: wav(0.1, 24000), mimeType: 'audio/wav' })), ...options.speech };
  if (options.actual) vi.spyOn(llmRegistry.get('groq'), 'generate').mockImplementation(async args => {
    const p = JSON.parse(args.userPrompt);
    if (!p.evidence) return JSON.stringify({ terms: [] });
    if (p.draft) return JSON.stringify({ supported: true, conflictsHandled: true, languageMatched: true, coverageHonest: true });
    const e = p.evidence[0];
    return JSON.stringify({ status: 'answered', claims: [{ text: 'Atlas budget is 50000.', evidenceIds: [e.evidenceId],
      citations: [{ evidenceId: e.evidenceId, quote: e.text }] }], coverage: 'sufficient', uncertainty: [] });
  });
  const openSource = vi.fn(() => true); const getConfig = vi.fn(() => config);
  const deps = { ipcMain, getMainWindow: () => main, getOverlayWindow: () => overlay, getConfig, llmRegistry, speech, openSource,
    serviceDeps: { db }, createService: args => { emitStage = args.onEvent; return options.actual ? createRecallService(args) : fakeService; }, ...options.deps };
  const api = registerRecallIpc(deps); controllers.push(api); if (!options.noWindow) api.attachRecallWindow(recall);
  const call = (channel, win, p, frame) => handlers.get(channel)(message(win, frame), p);
  const events = (win = recall, channel) => win.webContents.mainFrame.send.mock.calls.filter(([name]) => !channel || channel === name).map(([name, data]) => ({ name, ...data }));
  return { api, deps, call, events, main, overlay, recall, ipcMain, handlers, config, records, db, speech, fakeService, openSource, getConfig,
    emitStage: data => emitStage(data) };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live APIs forbidden in ordinary tests'); })));
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Recall channel authorization and capability boundaries', () => {
  it('registers once, owns exactly the fixed handlers, and cleans up without touching old IPC', () => {
    const s = setup(); const count = s.ipcMain.handle.mock.calls.length;
    expect(registerRecallIpc(s.deps)).toBe(s.api); expect(s.ipcMain.handle).toHaveBeenCalledTimes(count);
    expect([...s.handlers.keys()].sort()).toEqual(['old:channel', ...Object.values(C)].sort());
    expect(s.recall.webContents.listenerCount('destroyed')).toBe(1);
    const outside = vi.fn(); s.recall.webContents.on('destroyed', outside);
    s.api.dispose(); s.api.dispose(); expect([...s.handlers.keys()]).toEqual(['old:channel']);
    expect(s.handlers.get('old:channel')()).toBe('untouched'); expect(s.recall.webContents.listeners('destroyed')).toEqual([outside]);
    expect(s.fakeService.close).toHaveBeenCalled();
  });
  it('open is inert without an attached Recall window; attaching constructs nothing', async () => {
    const s = setup({ noWindow: true });
    expect((await s.call(C.open, s.main, { requestId: id() })).error.code).toBe('NOT_READY');
    expect(s.fakeService.ask).not.toHaveBeenCalled(); expect(s.speech.transcribe).not.toHaveBeenCalled();
    s.api.attachRecallWindow(s.recall); expect((await s.call(C.open, s.overlay, { requestId: id() })).opened).toBe(true);
    expect(s.recall.show).toHaveBeenCalledOnce(); expect(s.recall.focus).toHaveBeenCalledOnce();
  });
  it('rejects role aliasing and extra IPC arguments rather than widening window capabilities', async () => {
    const s = setup(); expect(() => s.api.attachRecallWindow(s.main)).toThrow(/Invalid/); expect(() => s.api.attachRecallWindow(s.overlay)).toThrow(/Invalid/);
    const result = await s.handlers.get(C.text)(message(s.recall), text(), { sql: 'arbitrary' });
    expect(result.error.code).toBe('INVALID_REQUEST'); expect(s.fakeService.ask).not.toHaveBeenCalled();
  });
  it.each(Object.values(C))('rejects a foreign webContents on %s, even with the real main frame', async channel => {
    const s = setup(); const foreign = windowFixture();
    const result = await s.handlers.get(channel)({ sender: foreign.webContents, senderFrame: s.recall.webContents.mainFrame }, { requestId: id() });
    expect(result.error.code).toBe('INVALID_REQUEST'); expect(s.getConfig).not.toHaveBeenCalled();
    expect(s.fakeService.ask).not.toHaveBeenCalled(); expect(s.speech.transcribe).not.toHaveBeenCalled();
  });
  it.each(['main', 'overlay', 'recall'])('rejects child, missing, detached and mismatched top frames for %s', async role => {
    const s = setup(); const win = s[role]; const channel = role === 'overlay' ? C.open : C.state;
    for (const frame of [null, { parent: win.webContents.mainFrame }, windowFixture().webContents.mainFrame]) {
      expect((await s.call(channel, win, { requestId: id() }, frame)).error.code).toBe('INVALID_REQUEST');
    }
    win.webContents.mainFrame.detached = true;
    expect((await s.call(channel, win, { requestId: id() })).error.code).toBe('INVALID_REQUEST');
  });
  it.each(Object.values(C).filter(c => c !== C.open))('overlay can only open Recall, rejects %s', async channel => {
    const s = setup(); expect((await s.call(channel, s.overlay, { requestId: id() })).error.code).toBe('INVALID_REQUEST');
  });
  it.each([C.text, C.audio, C.source, C.resize])('main settings cannot act as the assistant on %s', async channel => {
    const s = setup(); expect((await s.call(channel, s.main, text())).error.code).toBe('INVALID_REQUEST');
  });
  it.each([C.testStt, C.testTts, C.testLlm])('assistant cannot submit credential/model tests on %s', async channel => {
    const s = setup(); expect((await s.call(channel, s.recall, llm())).error.code).toBe('INVALID_REQUEST');
  });
  it('state is secret-free, explicitly selected, bounded, and performs no API calls', async () => {
    const s = setup({ config: { recallLlmModels: { groq: 'selected', apiKey: 'should-not-leak' } } });
    s.fakeService.getState.mockReturnValue({ historyTurns: 0, historyBytes: 2, fullConfig: s.config });
    for (const win of [s.main, s.recall]) {
      const state = await s.call(C.state, win, { requestId: id() });
      expect(state.preferences.recallLlmModels).toEqual({ groq: 'selected' });
      expect(JSON.stringify(state)).not.toMatch(/saved-speech-key|saved-llm-key|notion|PRIVATE NOTE|should-not-leak|fullConfig/);
      expect(state.readiness.text).toEqual({ configured: true, access: 'unverified' });
      expect(state.disclosures.loopback).toContain('even through headphones'); expect(state.disclosures.explicitVoiceStart).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(8192);
    }
    expect(s.speech.transcribe).not.toHaveBeenCalled(); expect(s.fakeService.ask).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('preflight validation before service calls', () => {
  it.each([null, [], { requestId: 'bad', question: 'hi' }, text({ question: '' }), text({ question: 'x'.repeat(1001) }),
    text({ locale: 'bad locale' }), text({ config: {} }), text({ sql: 'SELECT *' }), text({ path: 'C:/private' }), text({ url: 'https://example.com' })])('rejects bad text envelope (%#)', async p => {
    const s = setup(); expect((await s.call(C.text, s.recall, p)).error.code).toBe('INVALID_REQUEST'); expect(s.fakeService.ask).not.toHaveBeenCalled();
  });
  it.each(['base64', 'Blob', 'object', 'DataView', 'SharedArrayBuffer', 'oversized', 'empty', 'stereo', 'float', 'duration', 'header', 'rate', 'mime'])('rejects %s audio before STT', async kind => {
    const s = setup(); let audio = wav(); let mimeType = 'audio/wav';
    if (kind === 'base64') audio = 'UklGRg==';
    if (kind === 'Blob') audio = new Blob([audio]);
    if (kind === 'object') audio = { type: 'Buffer', data: [...audio] };
    if (kind === 'DataView') audio = new DataView(new ArrayBuffer(64));
    if (kind === 'SharedArrayBuffer') audio = new Uint8Array(new SharedArrayBuffer(64));
    if (kind === 'oversized') audio = new Uint8Array(3 * 1024 * 1024 + 1);
    if (kind === 'empty') audio = new Uint8Array();
    if (kind === 'stereo') audio.writeUInt16LE(2, 22);
    if (kind === 'float') audio.writeUInt16LE(3, 20);
    if (kind === 'duration') audio = wav(25.1, 8000);
    if (kind === 'header') audio.writeUInt32LE(100, 4);
    if (kind === 'rate') audio.writeUInt32LE(96000, 24);
    if (kind === 'mime') mimeType = 'audio/webm';
    expect((await s.call(C.audio, s.recall, clip({ audio, mimeType }))).error.code).toBe('INVALID_REQUEST');
    expect(s.speech.transcribe).not.toHaveBeenCalled(); expect(s.fakeService.ask).not.toHaveBeenCalled();
  });
  it.each(['view', 'ArrayBuffer'])('accepts a supported %s and snapshots only the selected bytes', async kind => {
    const s = setup(); const original = wav(); const padded = Buffer.concat([Buffer.alloc(9, 123), original, Buffer.alloc(11, 222)]);
    const audio = kind === 'view' ? new Uint8Array(padded.buffer, padded.byteOffset + 9, original.byteLength) : Uint8Array.from(original).buffer;
    const p = clip({ audio, muted: true }); expect((await s.call(C.audio, s.recall, p)).status).toBe('running'); await flush();
    expect(s.speech.transcribe.mock.calls[0][0].audio).toEqual(original);
    new Uint8Array(audio.buffer || audio, audio.byteOffset || 0, audio.byteLength).fill(0);
    expect(s.speech.transcribe.mock.calls[0][0].audio).toEqual(original);
    expect(s.fakeService.ask.mock.calls[0][0].requestId).toBe(p.requestId); expect(s.speech.synthesize).not.toHaveBeenCalled();
  });
  it('rejects replayed IDs, busy asks and invalid resize bounds', async () => {
    const s = setup(); const p = text(); await s.call(C.text, s.recall, p); await flush();
    expect((await s.call(C.text, s.recall, p)).error.code).toBe('INVALID_REQUEST');
    s.fakeService.ask.mockReturnValue(new Promise(() => {})); await s.call(C.text, s.recall, text());
    expect((await s.call(C.text, s.recall, text())).error.code).toBe('BUSY');
    for (const [width, height] of [[0, 300], [641, 300], [400, 801], [400.5, 300]]) {
      expect((await s.call(C.resize, s.recall, { requestId: id(), width, height })).error.code).toBe('INVALID_REQUEST');
    }
    expect((await s.call(C.resize, s.recall, { requestId: id(), width: 420, height: 500 })).status).toBe('complete');
    expect(s.recall.setContentSize).toHaveBeenCalledWith(420, 500);
  });
});

describe('owned events, cancellation and voice sequencing', () => {
  it('routes stage/answer/audio only to the owning actual Recall frame using one turn ID', async () => {
    const s = setup(); const p = clip(); await s.call(C.audio, s.recall, p); await flush();
    expect(s.speech.transcribe).toHaveBeenCalledOnce(); expect(s.fakeService.ask).toHaveBeenCalledOnce(); expect(s.speech.synthesize).toHaveBeenCalledOnce();
    expect(s.events().map(e => e.name)).toEqual([E.stage, E.answer, E.stage, E.audio, E.stage]);
    expect(s.events().every(e => e.requestId === p.requestId)).toBe(true);
    expect(s.events(s.main)).toEqual([]); expect(s.events(s.overlay)).toEqual([]);
    expect(s.events(undefined, E.audio)[0]).toMatchObject({ mimeType: 'audio/wav', sampleRate: 24000 });
    expect(s.events(undefined, E.audio)[0].audio).toBeInstanceOf(Uint8Array);
  });
  it('text never starts speech, and muted voice never synthesizes', async () => {
    const s = setup(); await s.call(C.text, s.recall, text()); await flush(); expect(s.speech.transcribe).not.toHaveBeenCalled(); expect(s.speech.synthesize).not.toHaveBeenCalled();
    await s.call(C.audio, s.recall, clip({ muted: true })); await flush(); expect(s.speech.synthesize).not.toHaveBeenCalled();
  });
  it('failed delivery aborts owned transport instead of continuing speech for an unreachable frame', async () => {
    const s = setup(); s.recall.webContents.mainFrame.send.mockImplementation(() => { throw new Error('Frame gone'); });
    await s.call(C.audio, s.recall, clip()); await flush();
    expect(s.speech.transcribe.mock.calls[0][0].signal.aborted).toBe(true); expect(s.fakeService.ask).not.toHaveBeenCalled();
  });
  it('retains a delivered text answer if subsequent TTS fails, but emits a separate speaking error', async () => {
    const s = setup({ speech: { synthesize: vi.fn(async () => { throw new Error('saved-speech-key PRIVATE'); }) } });
    await s.call(C.audio, s.recall, clip()); await flush();
    expect(s.events(undefined, E.answer)).toHaveLength(1);
    expect(s.events(undefined, E.error)[0]).toMatchObject({ stage: 'speaking', error: { code: 'UNAVAILABLE' } });
    expect(JSON.stringify(s.events())).not.toMatch(/saved-speech-key|PRIVATE/); expect(s.events(undefined, E.audio)).toEqual([]);
  });
  it('rejects cross-owner cancellation and suppresses late service events/results after a new request', async () => {
    const s = setup(); let release; let signal;
    s.fakeService.ask.mockImplementationOnce(p => { signal = p.signal; return new Promise(resolve => { release = resolve; }); });
    const p = text(); await s.call(C.text, s.recall, p); await flush();
    expect((await s.call(C.cancel, s.main, { requestId: id(), targetRequestId: p.requestId })).error.code).toBe('INVALID_REQUEST');
    expect((await s.call(C.cancel, s.recall, { requestId: id(), targetRequestId: p.requestId })).cancelled).toBe(true); await flush();
    expect(signal.aborted).toBe(true);
    const next = text(); await s.call(C.text, s.recall, next); await flush();
    const before = s.events().length; s.emitStage({ requestId: p.requestId, stage: 'answering', status: 'running' }); release(success(p.requestId)); await flush();
    expect(s.events()).toHaveLength(before); expect(s.events(undefined, E.answer).map(e => e.requestId)).toEqual([next.requestId]);
    expect(s.events(undefined, E.stage).some(e => e.requestId === p.requestId && e.status === 'cancelled')).toBe(true);
  });
  it.each(['destroy', 'navigation', 'legacy-navigation', 'crash', 'replacement', 'close', 'dispose'])('cancels and clears owned work on %s; rejects late audio', async action => {
    const s = setup(); let release; let signal;
    s.speech.transcribe.mockImplementationOnce(p => { signal = p.signal; return new Promise(resolve => { release = resolve; }); });
    const p = clip(); await s.call(C.audio, s.recall, p); await flush(); const before = s.events().length;
    if (action === 'destroy') s.recall.close();
    if (action === 'navigation') s.recall.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    if (action === 'legacy-navigation') s.recall.webContents.emit('did-start-navigation', {}, 'unused', false, true);
    if (action === 'crash') s.recall.webContents.emit('render-process-gone');
    if (action === 'replacement') s.api.attachRecallWindow(windowFixture());
    if (action === 'close') await s.call(C.close, s.main, { requestId: id() });
    if (action === 'dispose') s.api.dispose();
    release({ text: 'Atlas budget?' }); await flush(); expect(signal.aborted).toBe(true);
    expect(s.events().length).toBe(before); expect(s.fakeService.ask).not.toHaveBeenCalled(); expect(s.fakeService.close).toHaveBeenCalled();
  });
  it('ignores child/in-page navigations and rejects a reply with a stale requestId', async () => {
    const s = setup(); let release;
    s.fakeService.ask.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await s.call(C.text, s.recall, text()); await flush();
    s.recall.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    s.recall.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(s.fakeService.close).not.toHaveBeenCalled(); release(success(id())); await flush();
    expect(s.events(undefined, E.answer)).toEqual([]); expect(s.events(undefined, E.error)[0].error.code).toBe('INVALID_ANSWER');
  });
  it('a voice deadline aborts STT, suppresses late data and holds its speech lease until underlying settlement', async () => {
    vi.useFakeTimers(); const s = setup(); let release; let signal;
    s.speech.transcribe.mockImplementationOnce(p => { signal = p.signal; return new Promise(resolve => { release = resolve; }); });
    await s.call(C.audio, s.recall, clip()); await flush(); await vi.advanceTimersByTimeAsync(90001);
    expect(signal.aborted).toBe(true); expect(s.events(undefined, E.error)[0].error.code).toBe('TIMEOUT');
    expect((await s.call(C.testStt, s.main, stt())).error.code).toBe('BUSY');
    release({ text: 'Late transcript' }); await flush();
    expect((await s.call(C.testStt, s.main, stt())).status).toBe('complete'); expect(s.events(undefined, E.answer)).toEqual([]);
  });
  it('close before a deferred pipeline starts does not leak a speech lease', async () => {
    const s = setup(); const pending = s.call(C.audio, s.recall, clip());
    s.api.attachRecallWindow(null); await pending; await flush();
    expect((await s.call(C.testStt, s.main, stt())).status).toBe('complete');
  });
});

describe('settings-only independent tests with unsaved values', () => {
  it('tests STT with the supplied real-format clip and current unsaved values, without saving or using saved credentials', async () => {
    const s = setup(); const before = structuredClone(s.config); const p = stt();
    const result = await s.call(C.testStt, s.main, p);
    expect(result).toMatchObject({ requestId: p.requestId, status: 'complete', test: 'stt', transcript: 'Atlas budget?', verified: true });
    expect(s.speech.transcribe.mock.calls[0][0]).toMatchObject({ apiKey: p.values.recallGnaniApiKey, audio: p.audio });
    expect(s.getConfig).not.toHaveBeenCalled(); expect(s.config).toEqual(before); expect(s.speech.synthesize).not.toHaveBeenCalled();
    expect(s.events()).toEqual([]); expect(s.events(s.main).every(e => e.requestId === p.requestId)).toBe(true);
  });
  it('TTS returns validated serializable WAV bytes for later playback, with independently unsaved model/voice/language', async () => {
    const s = setup(); const p = tts(); const result = await s.call(C.testTts, s.main, p);
    expect(result).toMatchObject({ requestId: p.requestId, test: 'tts', status: 'complete', mimeType: 'audio/wav', sampleRate: 24000 });
    expect(result.audio).toBeInstanceOf(Uint8Array); expect(Buffer.from(result.audio).subarray(0, 4).toString()).toBe('RIFF');
    expect(s.speech.synthesize.mock.calls[0][0]).toMatchObject({ apiKey: 'unsaved-speech-key', model: 'timbre-v2.5', voice: 'Nalini', language: 'en-IN' });
    expect(s.speech.transcribe).not.toHaveBeenCalled(); expect(s.getConfig).not.toHaveBeenCalled();
  });
  it('LLM tests the exact unsaved Recall provider/model with bounded abortable generation, not note defaults', async () => {
    const s = setup(); const selected = vi.spyOn(llmRegistry.get('groq'), 'generate').mockResolvedValue('{"ok":true}');
    const oldTest = vi.spyOn(llmRegistry.get('groq'), 'test'); const other = vi.spyOn(llmRegistry.get('gemini'), 'generate');
    const p = llm(); expect(await s.call(C.testLlm, s.main, p)).toMatchObject({ status: 'complete', verified: true, model: 'selected-unsaved-model' });
    expect(selected.mock.calls[0][0]).toMatchObject({ config: { groqApiKey: 'unsaved-llm-key' }, model: 'selected-unsaved-model', maxTokens: 512, maxResponseBytes: 8192 });
    expect(selected.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal); expect(other).not.toHaveBeenCalled(); expect(oldTest).not.toHaveBeenCalled();
    expect(s.getConfig).not.toHaveBeenCalled(); expect(s.config.groqApiKey).toBe('saved-llm-key');
  });
  it.each([stt({ values: { recallGnaniApiKey: 'key', recallSttModel: 'other', recallSttLanguage: 'hi-IN,en-IN' } }),
    stt({ values: { recallGnaniApiKey: 'key', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'en' } }),
    stt({ values: { recallGnaniApiKey: 'key', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN', sttService: 'google' } })])('rejects unsupported or unrelated STT settings (%#)', async p => {
    const s = setup(); expect((await s.call(C.testStt, s.main, p)).status).toBe('error'); expect(s.speech.transcribe).not.toHaveBeenCalled();
  });
  it.each([tts({ values: { recallGnaniApiKey: 'key', recallTtsModel: 'timbre-v3.0', recallTtsVoice: 'Nalini', recallTtsLanguage: 'auto' } }),
    tts({ text: 'x'.repeat(2001) }), tts({ values: { recallGnaniApiKey: '', recallTtsModel: 'timbre-v3.0', recallTtsVoice: 'Shivani', recallTtsLanguage: 'auto' } })])('rejects invalid TTS before invoking speech (%#)', async p => {
    const s = setup(); expect((await s.call(C.testTts, s.main, p)).status).toBe('error'); expect(s.speech.synthesize).not.toHaveBeenCalled();
  });
  it.each([llm({ values: { recallLlmProvider: 'groq', recallLlmModels: { groq: 'x' }, groqApiKey: 'key', llmFallback: {} } }),
    llm({ values: { recallLlmProvider: 'groq', recallLlmModels: { groq: 'x', gemini: 'y' }, groqApiKey: 'key' } }),
    llm({ values: { recallLlmProvider: 'groq', recallLlmModels: { groq: 'x' }, geminiApiKey: 'key' } })])('rejects unrelated credentials/models/fallback (%#)', async p => {
    const s = setup(); const spy = vi.spyOn(llmRegistry.get('groq'), 'generate');
    expect((await s.call(C.testLlm, s.main, p)).status).toBe('error'); expect(spy).not.toHaveBeenCalled();
  });
  it('rejects malformed TTS response bytes, never claims decode/playback succeeded', async () => {
    const s = setup(); s.speech.synthesize.mockResolvedValue({ audio: wav(0.1, 16000), mimeType: 'audio/wav' });
    const result = await s.call(C.testTts, s.main, tts()); expect(result.error.code).toBe('UNAVAILABLE'); expect(result.audio).toBeUndefined();
  });
  it('keeps STT no-speech separate from an independent successful TTS test, and rejects omitted unsaved choices', async () => {
    const s = setup(); s.speech.transcribe.mockRejectedValueOnce(Object.assign(new Error('private provider text'), { code: 'NO_SPEECH' }));
    expect((await s.call(C.testStt, s.main, stt())).error.code).toBe('NO_SPEECH');
    expect((await s.call(C.testTts, s.main, tts())).test).toBe('tts');
    const p = tts(); p.values.recallTtsModel = undefined;
    expect((await s.call(C.testTts, s.main, p)).error.code).toBe('INVALID_REQUEST'); expect(s.speech.synthesize).toHaveBeenCalledOnce();
  });
  it('does not overlap STT/TTS settings tests with Voice turns or each other; text remains independent', async () => {
    const s = setup(); let release;
    s.speech.transcribe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = s.call(C.testStt, s.main, stt()); await flush();
    expect((await s.call(C.audio, s.recall, clip())).error.code).toBe('BUSY');
    expect((await s.call(C.testTts, s.main, tts())).error.code).toBe('BUSY');
    expect((await s.call(C.text, s.recall, text())).status).toBe('running'); await flush();
    release({ text: 'Short supported clip' }); expect((await pending).status).toBe('complete');
    await s.call(C.audio, s.recall, clip()); await flush(); expect(s.speech.synthesize).toHaveBeenCalledOnce();
  });
  it('cancels a settings request using its owner, suppresses late private output and releases on settlement', async () => {
    const s = setup(); let release; let signal;
    s.speech.synthesize.mockImplementationOnce(p => { signal = p.signal; return new Promise(resolve => { release = resolve; }); });
    const p = tts(); const pending = s.call(C.testTts, s.main, p); await flush();
    expect((await s.call(C.cancel, s.recall, { requestId: id(), targetRequestId: p.requestId })).error.code).toBe('INVALID_REQUEST');
    await s.call(C.cancel, s.main, { requestId: id(), targetRequestId: p.requestId }); expect((await pending).status).toBe('cancelled');
    expect(signal.aborted).toBe(true); release({ audio: wav(0.1, 24000), mimeType: 'audio/wav' }); await flush();
    expect(s.events(s.main, E.audio)).toEqual([]);
  });
  it('settings timeout propagates to the real supplied signal and does not expose provider errors', async () => {
    vi.useFakeTimers(); const s = setup(); let signal;
    const selected = vi.spyOn(llmRegistry.get('groq'), 'generate').mockImplementation(p => { signal = p.signal; return new Promise(() => {}); });
    const pending = s.call(C.testLlm, s.main, llm()); await flush(); await vi.advanceTimersByTimeAsync(30001);
    expect((await pending).error.code).toBe('TIMEOUT'); expect(signal.aborted).toBe(true); expect(selected).toHaveBeenCalledOnce();
  });
});

describe('current-evidence source navigation through the real answering/retrieval services', () => {
  const answer = async s => { const p = text(); await s.call(C.text, s.recall, p); await vi.waitFor(() => expect(s.events(undefined, E.answer)).toHaveLength(1)); return s.events(undefined, E.answer)[0]; };
  const open = (s, a, extra = {}) => s.call(C.source, s.recall, { requestId: id(), answerRequestId: a.requestId, evidenceId: a.sources[0].evidenceId, ...extra });
  it('dispatches trusted session/locator intent, honestly reports only requested navigation', async () => {
    const s = setup({ actual: true }); const a = await answer(s); const result = await open(s, a);
    expect(result.navigation).toBe('requested'); expect(result.opened).toBeUndefined();
    expect(s.openSource.mock.calls[0][0]).toEqual(a.sources[0]); expect(s.openSource.mock.calls[0][0].sessionId).toBe('atlas');
  });
  it.each(['edit', 'delete', 'incomplete', 'processing', 'active'])('rejects %s sources before focus/navigation callback', async change => {
    const exclusions = { activeRecordingId: null, processingSessionIds: [] };
    const s = setup({ actual: true, deps: { getRecordingState: () => exclusions } }); const a = await answer(s);
    if (change === 'edit') s.records.get('atlas').notes.summary = 'Atlas budget changed.';
    if (change === 'delete') s.records.delete('atlas');
    if (change === 'incomplete') s.records.get('atlas').status = 'generating';
    if (change === 'processing') exclusions.processingSessionIds = ['atlas'];
    if (change === 'active') exclusions.activeRecordingId = 'atlas';
    expect((await open(s, a)).error.code).toBe('SOURCE_CHANGED'); expect(s.openSource).not.toHaveBeenCalled();
  });
  it('rejects arbitrary sessions/locators, unknown IDs and a response not owned by this assistant', async () => {
    const s = setup({ actual: true }); const a = await answer(s);
    expect((await open(s, a, { sessionId: 'atlas' })).error.code).toBe('INVALID_REQUEST');
    expect((await open(s, a, { locator: { path: '/private' } })).error.code).toBe('INVALID_REQUEST');
    expect((await open(s, a, { evidenceId: 'E' + '0'.repeat(24) })).error.code).toBe('SOURCE_CHANGED');
    expect((await open(s, a, { answerRequestId: id() })).error.code).toBe('SOURCE_CHANGED');
    s.api.attachRecallWindow(windowFixture()); expect((await open(s, a)).error.code).toBe('INVALID_REQUEST');
    expect(s.openSource).not.toHaveBeenCalled();
  });
});

describe('existing main preload compatibility', () => {
  it('adds only fixed main Settings wrappers and leaves old event/navigation APIs in place', async () => {
    let bridge;
    const ipcRenderer = { invoke: vi.fn(async () => false), on: vi.fn(), removeListener: vi.fn() };
    vm.runInNewContext(readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8'), {
      require: name => { if (name !== 'electron') throw new Error('Unexpected preload import'); return { ipcRenderer,
        contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }; },
      process: { argv: [], platform: 'win32' }, window: { matchMedia: () => ({ matches: false }) },
      document: { documentElement: { classList: { add: vi.fn() } } },
    });
    expect(Object.keys(bridge.recall).sort()).toEqual(['open', 'close', 'getState', 'testStt', 'testTts', 'testLlm', 'cancelTest'].sort());
    const p = { requestId: id() }; await bridge.recall.testStt(p); expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(C.testStt, p);
    const previous = ipcRenderer.on.mock.calls.length; expect(bridge.on(E.answer, vi.fn())).toBeUndefined(); expect(ipcRenderer.on).toHaveBeenCalledTimes(previous);
    const callback = vi.fn(); const unsubscribe = bridge.on('app:open-session', callback); expect(typeof unsubscribe).toBe('function'); unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalled(); expect(typeof bridge.recording.start).toBe('function'); expect(typeof bridge.config.get).toBe('function');
  });
});

describe('small main hooks executing current owning code with injected dependencies', () => {
  const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  function between(start, end) {
    const a = source.indexOf(start); const b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error('Main hook boundaries changed'); return source.slice(a, b);
  }
  const tracker = between('const recallProcessingSessions = new Map();', '// ── Renderer capture IPC helpers');
  const logger = { info: () => {}, error: () => {} };
  it('marks a regular retry before its first tick and reference-counts overlapping jobs through cancellation/finally', async () => {
    const ctx = { setImmediate, cancelledSessions: new Set(), db: { getSession: () => null }, logger,
      sendToRenderer: vi.fn(), broadcastStatus: vi.fn(), syncOverlayWithStatus: vi.fn() };
    vm.runInNewContext(tracker + between('async function runProcessingPipeline(', '// ── Meeting overlay') +
      '\nglobalThis.run = runProcessingPipeline; globalThis.counts = recallProcessingSessions;', ctx);
    const a = ctx.run('missing', 'unused'); const b = ctx.run('missing', 'unused');
    expect(ctx.counts.get('missing')).toBe(2); await Promise.all([a, b]); expect(ctx.counts.size).toBe(0);
    expect(ctx.sendToRenderer.mock.calls.filter(([channel]) => channel === 'processing:cancelled')).toHaveLength(2);
  });
  it.each(['notion:upload', 'processing:retry'])('tracks %s until caller writes/returns, including failure cleanup, preserving existing responses', async channel => {
    let handler; let release;
    const ctx = { ipcMain: { handle: (_name, fn) => { handler = fn; } }, getConfig: () => ({ notionToken: 'test', notionPageId: 'test' }),
      logger, db: { getSession: () => ({ notes: {}, transcript: [] }), updateSession: vi.fn() },
      uploadSessionToNotion: vi.fn(() => new Promise(resolve => { release = resolve; })) };
    const code = channel === 'notion:upload' ? between("  ipcMain.handle('notion:upload'", "  ipcMain.handle('notion:test'") :
      between("  ipcMain.handle('processing:retry'", '  // Create a session from a pasted transcript');
    vm.runInNewContext(tracker + code + '\nglobalThis.counts = recallProcessingSessions;', ctx);
    const pending = handler({}, 'session', 'notion'); expect(ctx.counts.get('session')).toBe(1);
    release('https://notion.example/test'); expect(await pending).toMatchObject({ success: true, url: 'https://notion.example/test' });
    expect(ctx.db.updateSession).toHaveBeenCalled(); expect(ctx.counts.size).toBe(0);
    ctx.uploadSessionToNotion.mockRejectedValueOnce(new Error('existing failure'));
    expect(await handler({}, 'session', 'notion')).toMatchObject({ success: false, error: 'existing failure' }); expect(ctx.counts.size).toBe(0);
  });
  it('pasted work remains excluded across its early complete status and optional upload, clearing in finally', async () => {
    const pasted = between("  ipcMain.handle('session:create-from-transcript'", "  ipcMain.handle('updater:check'");
    const start = pasted.indexOf('(async () => {'); const end = pasted.indexOf('})();', start) + 5;
    let notesDone; let uploadDone;
    const saved = { status: 'generating' };
    const ctx = { sessionId: 'paste', title: 'Pasted', transcript: [], config: { notionToken: 'test', notionPageId: 'test' }, logger,
      sendToRenderer: vi.fn(), broadcastToExtension: vi.fn(), db: { updateSession: (_id, change) => Object.assign(saved, change) },
      generateAndStampNotes: () => new Promise(resolve => { notesDone = resolve; }),
      uploadSessionToNotion: () => new Promise(resolve => { uploadDone = resolve; }) };
    vm.runInNewContext(tracker + '\nglobalThis.pending = ' + pasted.slice(start, end) + '\nglobalThis.counts = recallProcessingSessions;', ctx);
    expect(ctx.counts.get('paste')).toBe(1); notesDone({ title: 'Pasted' }); await flush();
    expect(saved.status).toBe('uploading'); expect(ctx.counts.get('paste')).toBe(1);
    uploadDone('https://notion.example/paste'); await ctx.pending; expect(saved.status).toBe('complete'); expect(ctx.counts.size).toBe(0);
  });
  it('uses actual active recording state and dispatches a validated source through focusMainWindow and the guarded existing route', () => {
    let captured;
    const ctx = { registerRecallIpc: d => { captured = d; }, ipcMain: {}, mainWindow: {}, getOverlayWindow: () => null,
      getConfig: () => ({}), isRecording: false, currentSessionId: 'last-completed', recallProcessingSessions: new Map([['in-flight', 1]]),
      focusMainWindow: vi.fn(), sendToRenderer: vi.fn(() => true) };
    const a = source.indexOf('  recallIpc = registerRecallIpc('); const b = source.indexOf('\n  });', a) + 6;
    vm.runInNewContext('let recallIpc;\n' + source.slice(a, b), ctx);
    expect(captured.getRecordingState()).toEqual({ activeRecordingId: null, processingSessionIds: ['in-flight'] });
    ctx.isRecording = true; expect(captured.getRecordingState().activeRecordingId).toBe('last-completed');
    const evidence = { sessionId: 'saved', evidenceId: 'E' + 'a'.repeat(24), locator: { kind: 'notes', path: ['summary'], from: 0, to: 10 } };
    const request = { requestId: id(), answerRequestId: id() }; expect(captured.openSource(evidence, request)).toBe(true);
    expect(ctx.focusMainWindow.mock.invocationCallOrder[0]).toBeLessThan(ctx.sendToRenderer.mock.invocationCallOrder[0]);
    expect(ctx.sendToRenderer).toHaveBeenCalledWith('app:open-session', { sessionId: 'saved', recallSource: { ...request,
      evidenceId: evidence.evidenceId, locator: evidence.locator } });
  });
});
