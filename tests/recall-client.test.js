import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecallClient, validRecallAnswer, validRecallQuestion } from '../renderer/lib/recallClient.js';

const clients = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const source = { evidenceId: 'E' + 'a'.repeat(24), title: 'Synthetic meeting', section: 'Summary', text: 'Saved decision.', startedAt: '2026-11-10T03:00:00Z', locator: { kind: 'notes', from: 0, to: 15 } };
const answer = (id, extra = {}) => ({ requestId: id, status: 'answered', text: 'Saved decision.', sources: [structuredClone(source)],
  claims: [{ text: 'Saved decision.', evidenceIds: [source.evidenceId] }], coverage: { details: 'sufficient', exhaustive: false }, uncertainty: [], ...extra });
function setup(options = {}) {
  const listeners = {}, order = [], timers = [];
  let sequence = 0;
  const api = Object.fromEntries(['Stage', 'Answer', 'Error', 'Audio'].map(name => [`on${name}`, vi.fn(callback => { order.push(`on${name}`); listeners[name] = callback; return vi.fn(() => delete listeners[name]); })]));
  Object.assign(api, { getState: vi.fn(async () => { order.push('getState'); return { readiness: { text: { configured: true, access: 'unverified' } }, preferences: {} }; }),
    submitText: vi.fn(async request => ({ requestId: request.requestId, status: 'running' })), cancel: vi.fn(async () => ({ status: 'complete' })),
    openSource: vi.fn(async () => ({ navigation: 'requested' })), ...options.api });
  const onChange = vi.fn();
  const client = createRecallClient({ ...options, api, onChange, uuid: () => `request-${++sequence}`, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: vi.fn() });
  clients.push(client);
  const turn = async (text = 'A synthetic question') => { await flush(); client.setDraft(text); expect(client.submit()).toBe(true); return api.submitText.mock.calls.at(-1)[0].requestId; };
  const deliver = id => { listeners.Answer(answer(id)); listeners.Stage({ requestId: id, stage: 'idle', status: 'complete' }); };
  return { api, client, listeners, order, timers, turn, deliver, onChange };
}
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers(); });

describe('Recall renderer request ownership', () => {
  it('subscribes before state/submission; rejects duplicate clicks while the first ack is pending', async () => {
    const pending = deferred(); const s = setup({ api: { submitText: vi.fn(() => pending.promise) } });
    const id = await s.turn();
    expect(s.order).toEqual(['onStage', 'onAnswer', 'onError', 'onAudio', 'getState']);
    expect(s.client.submit()).toBe(false); expect(s.client.submit()).toBe(false); expect(s.api.submitText).toHaveBeenCalledOnce();
    s.deliver(id); pending.resolve({ requestId: id, status: 'running' }); await flush();
    expect(s.client.getState()).toMatchObject({ busy: false, draft: '', answer: { requestId: id }, error: null });
  });
  it('accepts answer/stages arriving before the invoke ack without stale state overwrites', async () => {
    const s = setup(); const id = await s.turn();
    s.listeners.Stage({ requestId: id, stage: 'answering', status: 'running' }); expect(s.client.getState().stage).toBe('answering');
    s.listeners.Answer(answer(id)); expect(s.client.getState().busy).toBe(true);
    s.listeners.Stage({ requestId: id, stage: 'idle', status: 'complete' }); await flush();
    expect(s.client.getState().answer.text).toBe('Saved decision.'); expect(s.client.getState().busy).toBe(false);
  });
  it.each(['TIMEOUT', 'RATE_LIMITED', 'NOT_READY', 'UNAVAILABLE', 'INVALID_ANSWER', 'MALFORMED_ANSWER', 'UNSUPPORTED_ANSWER', 'SOURCE_CHANGED'])('retains input and gives a safe %s error without raw provider text', async code => {
    const s = setup(); const id = await s.turn('Keep this question');
    s.listeners.Error({ requestId: id, stage: 'answering', error: { code, message: 'private provider body must never render' } });
    expect(s.client.getState()).toMatchObject({ draft: 'Keep this question', busy: false, answer: null, error: { code } });
    expect(JSON.stringify(s.client.getState())).not.toContain('private provider');
  });
  it('does not clear newer typed input when a previous question succeeds', async () => {
    const s = setup(); const id = await s.turn(); s.client.setDraft('The next question is already typed'); s.deliver(id);
    expect(s.client.getState().draft).toBe('The next question is already typed');
  });
  it('cancels immediately, sends an owned target ID, and rejects every late event from that turn', async () => {
    const s = setup(); const old = await s.turn('old'); s.client.cancel();
    expect(s.api.cancel).toHaveBeenCalledWith({ requestId: expect.any(String), targetRequestId: old });
    const next = await s.turn('new');
    s.listeners.Answer(answer(old)); s.listeners.Error({ requestId: old, error: { code: 'TIMEOUT' } });
    s.listeners.Stage({ requestId: old, stage: 'idle', status: 'complete' });
    expect(s.client.getState()).toMatchObject({ busy: true, answer: null, question: 'new' });
    s.deliver(next); expect(s.client.getState().answer.requestId).toBe(next);
  });
  it('discards uncorrelated/invalid/duplicate answer events and never renders a raw model draft', async () => {
    const s = setup(); const id = await s.turn(); s.listeners.Answer(answer('stale')); expect(s.client.getState().answer).toBeNull();
    s.listeners.Answer(answer(id, { sources: [{ ...source, evidenceId: 'invented' }] }));
    expect(s.client.getState().error.code).toBe('INVALID_ANSWER'); expect(s.client.getState().answer).toBeNull();
    const next = await s.turn(); s.listeners.Answer(answer(next)); s.listeners.Answer(answer(next, { text: 'Replacement draft' }));
    expect(s.client.getState().answer.text).toBe('Saved decision.');
  });
  it('keeps the already delivered answer readable if a later speaking failure arrives', async () => {
    const s = setup(); const id = await s.turn(); s.listeners.Answer(answer(id));
    s.listeners.Stage({ requestId: id, stage: 'speaking', status: 'running' });
    s.listeners.Error({ requestId: id, stage: 'speaking', error: { code: 'UNAVAILABLE' } });
    expect(s.client.getState().answer.text).toBe('Saved decision.'); expect(s.client.getState().error.code).toBe('UNAVAILABLE');
  });
  it('handles malformed terminal stage, rejected invoke and invalid ack without a stuck busy state', async () => {
    const s = setup(); let id = await s.turn(); s.listeners.Stage({ requestId: id, stage: 'idle', status: 'complete' });
    expect(s.client.getState().error.code).toBe('INVALID_ANSWER');
    s.api.submitText.mockRejectedValueOnce(new Error('private transport error')); await s.turn(); await flush();
    expect(s.client.getState().error.code).toBe('UNAVAILABLE');
    s.api.submitText.mockResolvedValueOnce({ requestId: 'wrong', status: 'running' }); id = await s.turn(); await flush();
    expect(s.client.getState().error.code).toBe('INVALID_ANSWER'); expect(s.client.getState().busy).toBe(false);
  });
});
describe('bounded renderer display context and source revalidation', () => {
  it('retains only three prior text pairs/8192 bytes, drops old evidence and never sends history back', async () => {
    const s = setup();
    for (let i = 0; i < 8; i++) { const id = await s.turn(`Question ${i}`); s.deliver(id); }
    const view = s.client.getState(); expect(view.history).toHaveLength(3);
    expect(new TextEncoder().encode(JSON.stringify(view.history)).byteLength).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(view.history)).not.toContain('evidenceId'); expect(JSON.stringify(view.history)).not.toContain('locator');
    expect(s.api.submitText.mock.calls.every(([request]) => Object.keys(request).sort().join(',') === 'question,requestId')).toBe(true);
    await s.turn(); expect(s.client.getState().answer).toBeNull();
    const next = setup(); await flush(); expect(next.client.getState().history).toEqual([]);
  });
  it('evicts complete Unicode pairs at the serialized byte cap, even before reaching three pairs', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) {
      const id = await s.turn('问'.repeat(1000));
      s.listeners.Answer(answer(id, { text: '答'.repeat(599) }));
      s.listeners.Stage({ requestId: id, stage: 'idle', status: 'complete' });
    }
    expect(s.client.getState().history).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(s.client.getState().history)).byteLength).toBeLessThanOrEqual(8192);
  });
  it('bounds a lost terminal event/ack with a local deadline and ignores late output after timeout', async () => {
    const pending = deferred(); const s = setup({ api: { submitText: vi.fn(() => pending.promise) } });
    const id = await s.turn('kept after local timeout'); s.timers[0]();
    expect(s.client.getState()).toMatchObject({ busy: false, draft: 'kept after local timeout', error: { code: 'TIMEOUT' } });
    expect(s.api.cancel).toHaveBeenCalledOnce(); s.listeners.Answer(answer(id));
    pending.resolve({ requestId: id, status: 'running' }); await flush(); expect(s.client.getState().answer).toBeNull();
  });
  it('uses only current answer/evidence IDs, reports dispatch rather than completed navigation', async () => {
    const s = setup(); const id = await s.turn(); s.deliver(id);
    await s.client.openSource('not-current'); expect(s.api.openSource).not.toHaveBeenCalled();
    await s.client.openSource(source.evidenceId);
    expect(s.api.openSource).toHaveBeenCalledWith({ requestId: expect.any(String), answerRequestId: id, evidenceId: source.evidenceId });
    expect(s.client.getState().sourceNotice).toContain('guard may keep');
    s.api.openSource.mockResolvedValueOnce({ error: { code: 'SOURCE_CHANGED' } }); await s.client.openSource(source.evidenceId);
    expect(s.client.getState().sourceStale).toBe(true); const count = s.api.openSource.mock.calls.length;
    await s.client.openSource(source.evidenceId); expect(s.api.openSource).toHaveBeenCalledTimes(count);
    expect(s.client.getState().answer.text).toBe('Saved decision.');
  });
  it('expires source handles and ignores an older source-opening reply after a newer question', async () => {
    const s = setup(); const id = await s.turn(); s.deliver(id); const pending = deferred();
    s.api.openSource.mockReturnValueOnce(pending.promise); const open = s.client.openSource(source.evidenceId);
    await s.turn('next'); pending.resolve({ error: { code: 'SOURCE_CHANGED' } }); await open;
    expect(s.client.getState().sourceStale).toBe(false); expect(s.client.getState().sourceNotice).toBe('');
    const nextId = s.api.submitText.mock.calls.at(-1)[0].requestId; s.deliver(nextId); s.timers.at(-1)();
    expect(s.client.getState()).toMatchObject({ sourceStale: true, answer: { text: 'Saved decision.', sources: [], claims: [] } });
  });
  it('Text/Voice selection and local mute never submit audio or start a provider request', async () => {
    const s = setup(); await flush(); s.client.setMuted(true); s.client.setMode('voice'); s.client.setDraft('voice must wait');
    expect(s.client.submit()).toBe(false); expect(s.api.submitText).not.toHaveBeenCalled();
    expect(s.client.getState()).toMatchObject({ mode: 'voice', muted: true, busy: false });
    s.client.setMode('text'); expect(s.client.submit()).toBe(true); s.client.setMode('voice');
    expect(s.api.cancel).toHaveBeenCalledOnce();
  });
  it('requires configuration, refreshes readiness without cloud tests, and preserves disabled/default preferences', async () => {
    const s = setup({ api: { getState: vi.fn(async () => ({ readiness: { text: { configured: false } }, preferences: { recallMuted: false, recallStartupMode: 'voice' } })) } });
    await flush(); expect(s.client.getState()).toMatchObject({ mode: 'voice', muted: false });
    s.client.setMode('text'); s.client.setDraft('question'); expect(s.client.submit()).toBe(false);
    expect(s.client.getState().error.code).toBe('NOT_READY'); expect(s.api.submitText).not.toHaveBeenCalled();
    s.api.getState.mockResolvedValue({ readiness: { text: { configured: true } }, preferences: { recallStartupMode: 'voice' } });
    await s.client.refresh(); expect(s.client.getState().mode).toBe('text'); expect(s.client.submit()).toBe(true);
  });
  it('unsubscribe/dispose clears RAM, cancels only its request and rejects late refresh/events', async () => {
    const s = setup(); const id = await s.turn(); const answerListener = s.listeners.Answer; s.client.dispose(); s.client.dispose();
    answerListener(answer(id)); expect(s.client.getState()).toMatchObject({ history: [], answer: null, draft: '', question: '' });
    expect(s.api.cancel).toHaveBeenCalledOnce(); expect(Object.keys(s.listeners)).toEqual([]);
  });
  it('validates hard bounds and accepts only fully delivered answered/insufficient shapes', () => {
    expect(validRecallQuestion(' ')).toBe(false); expect(validRecallQuestion('x'.repeat(1001))).toBe(false);
    expect(validRecallQuestion('😀'.repeat(500))).toBe(true); expect(validRecallQuestion('😀'.repeat(501))).toBe(false);
    expect(validRecallAnswer(answer('id'))).toBe(true); expect(validRecallAnswer(answer('id', { text: '' }))).toBe(false);
    expect(validRecallAnswer(answer('id', { status: 'insufficient_evidence', sources: [], claims: [] }))).toBe(true);
    expect(validRecallAnswer(answer('id', { uncertainty: {} }))).toBe(false);
    expect(validRecallAnswer(answer('id', { claims: [] }))).toBe(false);
  });
  it('maps prototype-shaped or unknown error codes to fixed public copy', async () => {
    const s = setup(); const id = await s.turn();
    s.listeners.Error({ requestId: id, error: { code: '__proto__' } });
    expect(s.client.getState().error).toMatchObject({ code: 'UNAVAILABLE', message: expect.any(String) });
  });
  it('accepts bounded longer scoped comparisons while preserving the ordinary answer bounds', () => {
    const text = 'Supported detail. '.repeat(50);
    const claims = Array.from({ length: 6 }, () => ({ text: 'Supported detail.', evidenceIds: [source.evidenceId] }));
    expect(validRecallAnswer(answer('id', { text, claims }))).toBe(false);
    const coverage = { meetings: { requested: 2, available: 2, retrieved: 2, cited: 1 }, details: 'partial', exhaustive: false };
    expect(validRecallAnswer(answer('id', { text, claims, coverage }))).toBe(true);
    expect(validRecallAnswer(answer('id', { text: 'x'.repeat(1901), claims, coverage }))).toBe(false);
    expect(validRecallAnswer(answer('id', { text, claims: [...claims, claims[0]], coverage }))).toBe(false);
  });
});
