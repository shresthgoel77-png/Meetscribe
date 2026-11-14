import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecallClient } from '../renderer/lib/recallClient.js';
import { encodeRecallWav } from '../renderer/lib/recallAudio.js';

const clients = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const wav = () => encodeRecallWav([new Float32Array(1600)], 16000);
const answer = id => ({ requestId: id, status: 'answered', text: 'Saved decision.', claims: [{ text: 'Saved decision.' }],
  sources: [{ evidenceId: 'E' + 'a'.repeat(24), title: 'Fixture', section: 'Notes', text: 'Saved decision.', locator: { kind: 'notes' } }], coverage: {}, uncertainty: [] });
function setup(options = {}) {
  const events = {}, timers = [], order = [];
  let sequence = 0, recorderOptions, playerOptions;
  const api = Object.fromEntries(['Stage', 'Answer', 'Error', 'Audio'].map(name => [`on${name}`, callback => { events[name] = callback; return () => delete events[name]; }]));
  Object.assign(api, {
    getState: vi.fn(async () => ({ readiness: { text: { configured: true }, stt: { configured: true }, tts: { configured: true } }, preferences: {} })),
    submitAudio: vi.fn(async request => { order.push('submitAudio'); return { requestId: request.requestId, status: 'running' }; }),
    submitText: vi.fn(async request => ({ requestId: request.requestId, status: 'running' })),
    setMuted: vi.fn(async request => ({ requestId: request.requestId, status: 'complete' })),
    cancel: vi.fn(async () => ({ status: 'complete' })), ...options.api,
  });
  const recorder = { start: vi.fn(async () => { order.push('mic:start'); }), stop: vi.fn(() => { order.push('mic:stop'); return wav(); }), getDuration: () => 25, dispose: vi.fn(() => order.push('mic:dispose')), ...options.recorder };
  const player = { load: vi.fn(async () => { order.push('decode'); }), play: vi.fn(async () => { order.push('play'); return true; }), dispose: vi.fn(() => order.push('player:dispose')), ...options.player };
  const createRecorder = vi.fn(value => { recorderOptions = value; return recorder; });
  const createPlayer = vi.fn(value => { playerOptions = value; return player; });
  const client = createRecallClient({ api, onChange: vi.fn(), createRecorder, createPlayer, uuid: () => `id-${++sequence}`,
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimer: vi.fn() });
  clients.push(client);
  const start = async () => { await flush(); client.setMode('voice'); expect(await client.startVoice()).toBe(true); return client; };
  const submit = async () => { await start(); client.stopVoice(); await flush(); return api.submitAudio.mock.calls.at(-1)[0].requestId; };
  const text = id => { events.Stage({ requestId: id, stage: 'retrieving', status: 'running', question: 'Recognized question?' }); events.Answer(answer(id)); };
  const audio = id => events.Audio({ requestId: id, audio: wav(), mimeType: 'audio/wav', sampleRate: 24000 });
  const complete = id => events.Stage({ requestId: id, stage: 'idle', status: 'complete' });
  return { client, api, events, timers, recorder, player, createRecorder, createPlayer, order, start, submit, text, audio, complete,
    recorderOptions: () => recorderOptions, playerOptions: () => playerOptions };
}
afterEach(() => clients.splice(0).forEach(client => client.dispose()));
describe('explicit Recall-owned Voice lifecycle', () => {
  it('keeps a post-answer synthesis error stage-specific and ignores stale errors', async () => {
    const s = setup(); const id = await s.submit(); s.text(id);
    s.events.Error({ requestId: 'old', stage: 'speaking', error: { code: 'UNAVAILABLE' } }); expect(s.client.getState().error).toBeNull();
    s.events.Error({ requestId: id, stage: 'speaking', error: { code: 'UNAVAILABLE', speechCode: 'INVALID_RESPONSE' } });
    expect(s.client.getState()).toMatchObject({ answer: { text: 'Saved decision.' }, error: { stage: 'speaking', message: 'Gnani returned invalid speech audio.' } });
    expect(s.client.getState().error.message).not.toContain('answering service');
  });
  it('distinguishes local decode failure from synthesis and blocked autoplay', async () => {
    const s = setup({ player: { load: vi.fn(async () => { throw new Error('decoder'); }) } }); const id = await s.submit();
    s.text(id); s.audio(id); await flush();
    expect(s.client.getState()).toMatchObject({ playback: 'failed', error: { code: 'AUDIO_DECODE_FAILED', stage: 'decoding' } });
    expect(s.player.play).not.toHaveBeenCalled();
  });
  it('opening/switching Voice stays idle; Start/Stop sends one genuine WAV using the same capture ID', async () => {
    const s = setup(); await flush(); s.client.setMode('voice'); expect(s.createRecorder).not.toHaveBeenCalled();
    await s.client.startVoice(); expect(s.api.submitAudio).not.toHaveBeenCalled();
    expect(s.client.getState()).toMatchObject({ busy: true, stage: 'listening', captureSeconds: 0 });
    s.recorderOptions().onDuration(1.25); expect(s.client.getState().captureSeconds).toBe(1.25);
    expect(s.client.stopVoice()).toBe(true); expect(s.client.stopVoice()).toBe(false); await flush();
    expect(s.api.submitAudio).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), audio: expect.any(Uint8Array), mimeType: 'audio/wav', muted: false });
    expect(s.order.indexOf('mic:stop')).toBeLessThan(s.order.indexOf('submitAudio'));
  });
  it('auto-stop at the cap submits once and leaves a visible cap/duration result', async () => {
    const s = setup(); await s.start(); s.recorderOptions().onDuration(25); s.recorderOptions().onLimit(); s.recorderOptions().onLimit(); await flush();
    expect(s.api.submitAudio).toHaveBeenCalledOnce(); expect(s.client.getState()).toMatchObject({ captureSeconds: 25, autoStopped: true, stage: 'transcribing' });
  });
  it.each(['cancel', 'mode', 'dispose'])('cancels during permission via %s and ignores a late acquisition', async action => {
    const pending = deferred(); const s = setup({ recorder: { start: vi.fn(() => pending.promise) } });
    await flush(); s.client.setMode('voice'); const start = s.client.startVoice();
    expect(await s.client.startVoice()).toBe(false);
    if (action === 'cancel') s.client.cancel(); else if (action === 'mode') s.client.setMode('text'); else s.client.dispose();
    expect(s.recorder.dispose).toHaveBeenCalled(); pending.resolve(); expect(await start).toBe(false);
    expect(s.api.submitAudio).not.toHaveBeenCalled(); expect(s.api.cancel).not.toHaveBeenCalled();
  });
  it.each(['MIC_DENIED', 'MIC_BUSY', 'MIC_MISSING', 'MIC_REMOVED', 'NO_SPEECH', 'INCOMPLETE_TRANSCRIPT'])('handles %s without touching other audio', async code => {
    const s = setup(); const id = await s.submit(); s.events.Error({ requestId: id, stage: 'transcribing', error: { code } });
    expect(s.client.getState()).toMatchObject({ busy: false, error: { code } }); expect(s.createPlayer).not.toHaveBeenCalled();
  });
  it('publishes the recognized question and answer before audio; main completion does not discard pending decode', async () => {
    const pending = deferred(); const s = setup({ player: { load: vi.fn(() => pending.promise) } }); const id = await s.submit();
    s.text(id); expect(s.client.getState()).toMatchObject({ question: 'Recognized question?', questionOrigin: 'voice', answer: { text: 'Saved decision.' } });
    expect(s.createPlayer).not.toHaveBeenCalled(); s.audio(id); s.complete(id);
    expect(s.client.getState()).toMatchObject({ busy: false, playback: 'decoding' });
    pending.resolve(); await flush(); expect(s.player.play).toHaveBeenCalledOnce(); expect(s.client.getState().playback).toBe('playing');
    s.playerOptions().onEnded(); expect(s.client.getState().playback).toBe('complete');
  });
  it('handles blocked autoplay with an explicit Play action and no duplicate decoded source', async () => {
    const s = setup({ player: { play: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true) } }); const id = await s.submit();
    s.text(id); s.audio(id); await flush(); s.complete(id);
    expect(s.client.getState().playback).toBe('blocked'); await s.client.playAudio();
    expect(s.client.getState().playback).toBe('playing'); expect(s.player.load).toHaveBeenCalledOnce();
  });
  it('muted capture sends the current policy and ignores any unexpected late audio', async () => {
    const s = setup(); await s.start(); s.client.setMuted(true); s.client.stopVoice(); await flush();
    const request = s.api.submitAudio.mock.calls[0][0]; expect(request.muted).toBe(true); s.text(request.requestId); s.audio(request.requestId);
    expect(s.createPlayer).not.toHaveBeenCalled();
  });
  it('muting mid-answer updates only the owned turn; muting synthesis aborts late playback without losing text', async () => {
    const s = setup(); const id = await s.submit(); s.client.setMuted(true);
    expect(s.api.setMuted).toHaveBeenCalledWith({ requestId: expect.any(String), targetRequestId: id, muted: true });
    s.client.setMuted(false); s.text(id); s.events.Stage({ requestId: id, stage: 'speaking', status: 'running' }); s.client.setMuted(true);
    s.events.Error({ requestId: id, stage: 'speaking', error: { code: 'CANCELLED' } }); s.audio(id);
    expect(s.client.getState()).toMatchObject({ busy: false, error: null, answer: { text: 'Saved decision.' } }); expect(s.createPlayer).not.toHaveBeenCalled();
  });
  it.each(['stop', 'cancel', 'mode', 'dispose', 'timeout'])('%s disposes pending decode and rejects late playback', async action => {
    const pending = deferred(); const s = setup({ player: { load: vi.fn(() => pending.promise) } }); const id = await s.submit(); s.text(id); s.audio(id);
    if (action === 'stop') s.client.stopAudio(); else if (action === 'mode') s.client.setMode('text'); else if (action === 'dispose') s.client.dispose();
    else if (action === 'timeout') s.timers.find(t => t.ms === 95000).callback(); else s.client.cancel();
    pending.resolve(); await flush(); expect(s.player.dispose).toHaveBeenCalled(); expect(s.player.play).not.toHaveBeenCalled();
  });
  it('a new Start stops prior playback before requesting the microphone; no automatic re-listening', async () => {
    const s = setup(); const id = await s.submit(); s.text(id); s.audio(id); await flush(); s.complete(id);
    expect(s.createRecorder).toHaveBeenCalledOnce(); await s.client.startVoice();
    const disposal = s.order.lastIndexOf('player:dispose'), acquisition = s.order.lastIndexOf('mic:start');
    expect(disposal).toBeLessThan(acquisition); expect(s.createRecorder).toHaveBeenCalledTimes(2);
  });
  it('Cancel also releases playback after the main turn has completed', async () => {
    const s = setup(); const id = await s.submit(); s.text(id); s.audio(id); await flush(); s.complete(id);
    s.client.cancel(); expect(s.player.dispose).toHaveBeenCalled(); expect(s.client.getState().playback).toBe('stopped');
    expect(s.api.cancel).not.toHaveBeenCalled();
  });
  it('silence/TTS failure cannot remove a validated text answer or replace the speech service', async () => {
    const s = setup(); const id = await s.submit(); s.text(id); s.events.Error({ requestId: id, stage: 'speaking', error: { code: 'UNAVAILABLE' } });
    expect(s.client.getState()).toMatchObject({ playback: 'failed', answer: { text: 'Saved decision.' } }); expect(s.api.submitText).not.toHaveBeenCalled();
  });
  it('bounds permission and network waits and releases only Recall resources', async () => {
    const pending = deferred(); const s = setup({ recorder: { start: vi.fn(() => pending.promise) } });
    await flush(); s.client.setMode('voice'); const start = s.client.startVoice(); s.timers.find(t => t.ms === 30000).callback();
    expect(s.recorder.dispose).toHaveBeenCalled(); expect(s.client.getState().error.code).toBe('TIMEOUT'); pending.resolve(); await start;
    const second = setup(); const id = await second.submit(); second.timers.find(t => t.ms === 95000).callback();
    expect(second.api.cancel).toHaveBeenCalledWith({ requestId: expect.any(String), targetRequestId: id });
  });
});
