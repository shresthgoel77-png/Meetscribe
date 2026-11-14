import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecallRecorder, createRecallPlayer, encodeRecallWav } from '../renderer/lib/recallAudio.js';

const require = createRequire(import.meta.url);
const gnani = require('../electron/providers/speech/gnani');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function browserAudio() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const processor = { connect: vi.fn(), disconnect: vi.fn(), port: { close: vi.fn(), onmessage: null } };
  const context = { sampleRate: 16000, state: 'running', destination: {},
    resume: vi.fn(async () => { context.state = 'running'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => source), createBufferSource: vi.fn(() => source),
    decodeAudioData: vi.fn(async () => ({ numberOfChannels: 1, duration: 1, length: 16000 })),
  };
  const AudioContextClass = vi.fn(function () { return context; });
  const WorkletNodeClass = vi.fn(function () { return processor; });
  const mediaDevices = { getUserMedia: vi.fn(async () => stream) };
  return { track, stream, source, processor, context, AudioContextClass, WorkletNodeClass, mediaDevices };
}
afterEach(() => vi.useRealTimers());

describe('Recall-only PCM recording', () => {
  it.each([['NotFoundError', 'MIC_MISSING'], ['NotReadableError', 'MIC_BUSY'], ['AbortError', 'MIC_BUSY']])('maps %s without exposing device details', async (name, code) => {
    const env = browserAudio(); env.mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('private device'), { name }));
    await expect(createRecallRecorder(env).start()).rejects.toMatchObject({ code, message: code });
    expect(env.AudioContextClass).not.toHaveBeenCalled();
  });
  it('reports captured sample duration and releases its graph on device removal', async () => {
    const env = browserAudio(), onDuration = vi.fn(), onError = vi.fn();
    const recorder = createRecallRecorder({ ...env, onDuration, onError }); await recorder.start();
    env.processor.port.onmessage({ data: new Float32Array(8000) });
    expect(recorder.getDuration()).toBe(0.5); expect(onDuration).toHaveBeenCalledWith(0.5);
    env.track.onended(); expect(onError).toHaveBeenCalledWith('MIC_REMOVED');
    expect(env.context.close).toHaveBeenCalledOnce(); expect(env.track.stop).toHaveBeenCalledOnce();
    expect(env.processor.port.onmessage).toBeNull();
  });
  it('is inert until Start, captures microphone only and produces transport-valid PCM WAV', async () => {
    const env = browserAudio(), recorder = createRecallRecorder(env);
    expect(env.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(env.AudioContextClass).not.toHaveBeenCalled();
    await recorder.start();
    expect(env.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    expect(env.WorkletNodeClass).toHaveBeenCalledWith(env.context, 'recall-pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
    env.processor.port.onmessage({ data: new Float32Array([0, -1, 1, 0.5]) });
    const audio = recorder.stop();
    expect(gnani.validateClip(audio)).toEqual({ sampleRate: 16000, durationSeconds: 4 / 16000 });
    expect(new DataView(audio.buffer).getInt16(46, true)).toBe(-32768);
    expect(new DataView(audio.buffer).getInt16(48, true)).toBe(32767);
    expect(env.track.stop).toHaveBeenCalledOnce();
    expect(env.context.close).toHaveBeenCalledOnce();
    expect(env.processor.port.onmessage).toBeNull();
  });
  it('releases a late permission grant after cancellation without opening a graph', async () => {
    const env = browserAudio(), pending = deferred();
    env.mediaDevices.getUserMedia.mockReturnValue(pending.promise);
    const recorder = createRecallRecorder(env), start = recorder.start();
    recorder.dispose(); pending.resolve(env.stream);
    await expect(start).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(env.track.stop).toHaveBeenCalled();
    expect(env.AudioContextClass).not.toHaveBeenCalled();
  });
  it('cleans up if cancelled during worklet loading', async () => {
    const env = browserAudio(), pending = deferred();
    env.context.audioWorklet.addModule.mockReturnValue(pending.promise);
    const recorder = createRecallRecorder(env), start = recorder.start();
    await vi.waitFor(() => expect(env.context.audioWorklet.addModule).toHaveBeenCalled());
    recorder.dispose(); pending.resolve();
    await expect(start).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(env.track.stop).toHaveBeenCalled();
    expect(env.WorkletNodeClass).not.toHaveBeenCalled();
  });
  it('releases the microphone at the wall limit even if worklet loading stalls', async () => {
    vi.useFakeTimers();
    const env = browserAudio(), pending = deferred(), onLimit = vi.fn();
    env.context.audioWorklet.addModule.mockReturnValue(pending.promise);
    const recorder = createRecallRecorder({ ...env, onLimit }), start = recorder.start();
    await vi.advanceTimersByTimeAsync(25000);
    expect(onLimit).toHaveBeenCalledOnce(); expect(env.track.stop).toHaveBeenCalledOnce();
    pending.resolve(); await expect(start).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(env.WorkletNodeClass).not.toHaveBeenCalled();
  });
  it('caps samples and wall time at 25 seconds, without touching another stream', async () => {
    vi.useFakeTimers();
    const env = browserAudio(), meetingTrack = { stop: vi.fn() };
    let recorder;
    let audio;
    const onLimit = vi.fn(() => { audio = recorder.stop(); });
    recorder = createRecallRecorder({ ...env, onLimit }); await recorder.start();
    env.processor.port.onmessage({ data: new Float32Array(16000 * 26) });
    expect(gnani.validateClip(audio).durationSeconds).toBe(25);
    await vi.advanceTimersByTimeAsync(26000);
    expect(onLimit).toHaveBeenCalledOnce();
    expect(meetingTrack.stop).not.toHaveBeenCalled();
    const wallLimit = vi.fn();
    const timedEnv = browserAudio();
    const timed = createRecallRecorder({ ...timedEnv, onLimit: wallLimit });
    await timed.start(); await vi.advanceTimersByTimeAsync(25000);
    expect(wallLimit).toHaveBeenCalledOnce();
    expect(timedEnv.track.stop).toHaveBeenCalledOnce();
    expect(timedEnv.context.close).toHaveBeenCalledOnce(); timed.dispose();
  });
  it.each(['permission', 'module', 'processor'])('sanitizes %s failure and releases owned resources', async kind => {
    const env = browserAudio(), onError = vi.fn(), recorder = createRecallRecorder({ ...env, onError });
    if (kind === 'permission') env.mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('private device detail'), { name: 'NotAllowedError' }));
    if (kind === 'module') env.context.audioWorklet.addModule.mockRejectedValue(new Error('private path'));
    if (kind !== 'processor') {
      await expect(recorder.start()).rejects.toMatchObject({ code: kind === 'permission' ? 'MIC_DENIED' : 'UNAVAILABLE' });
    } else { await recorder.start(); env.processor.onprocessorerror(); expect(onError).toHaveBeenCalledOnce(); }
    if (kind !== 'permission') expect(env.track.stop).toHaveBeenCalled();
  });
  it('rejects empty, oversize, nonfinite or unsupported-rate PCM', () => {
    expect(() => encodeRecallWav([], 16000)).toThrow();
    expect(() => encodeRecallWav([new Float32Array(16000 * 25 + 1)], 16000)).toThrow();
    expect(() => encodeRecallWav([new Float32Array([NaN])], 16000)).toThrow();
    expect(() => encodeRecallWav([new Float32Array([0])], 96000)).toThrow();
  });
  it('the actual worklet emits capped mono samples and no microphone monitoring output', () => {
    let Processor;
    const postMessage = vi.fn();
    vm.runInNewContext(readFileSync(new URL('../renderer/lib/recallAudioProcessor.js', import.meta.url), 'utf8'), {
      sampleRate: 8000, AudioWorkletProcessor: class { constructor() { this.port = { postMessage }; } },
      registerProcessor: (_name, processor) => { Processor = processor; },
    });
    const processor = new Processor();
    const output = new Float32Array(200001);
    expect(processor.process([[new Float32Array(200001).fill(0.5)]], [[output]])).toBe(false);
    expect(postMessage.mock.calls[0][0]).toHaveLength(200000);
    expect(output.every(sample => sample === 0)).toBe(true);
    processor.process([[new Float32Array([1])]]);
    expect(postMessage).toHaveBeenCalledOnce();
  });
});

describe('Recall-only TTS decoding and playback', () => {
  it('coalesces concurrent Play during resume and cancels a pending Play on Stop', async () => {
    const env = browserAudio(), pending = deferred(), player = createRecallPlayer(env);
    await player.load(new Uint8Array([1])); env.context.state = 'suspended'; env.context.resume.mockImplementation(() => pending.promise.then(() => { env.context.state = 'running'; }));
    const first = player.play(), second = player.play(); pending.resolve(); await Promise.all([first, second]);
    expect(env.source.start).toHaveBeenCalledOnce(); player.dispose();
    const env2 = browserAudio(), later = deferred(), stopped = createRecallPlayer(env2);
    await stopped.load(new Uint8Array([1])); env2.context.state = 'suspended'; env2.context.resume.mockReturnValue(later.promise);
    const play = stopped.play(); stopped.stop(); later.resolve();
    await expect(play).rejects.toMatchObject({ code: 'CANCELLED' }); expect(env2.source.start).not.toHaveBeenCalled(); stopped.dispose();
  });
  it('copies exactly the selected view, and reports completion only after source ended', async () => {
    const env = browserAudio(), onEnded = vi.fn(), player = createRecallPlayer({ ...env, onEnded });
    const bytes = new Uint8Array([99, 1, 2, 3, 99]);
    await player.load(bytes.subarray(1, 4));
    expect([...new Uint8Array(env.context.decodeAudioData.mock.calls[0][0])]).toEqual([1, 2, 3]);
    expect(bytes).toEqual(new Uint8Array([99, 1, 2, 3, 99]));
    expect(env.source.start).not.toHaveBeenCalled();
    expect(await player.play()).toBe(true);
    expect(onEnded).not.toHaveBeenCalled(); env.source.onended();
    expect(onEnded).toHaveBeenCalledOnce(); player.dispose();
    expect(env.context.close).toHaveBeenCalledOnce();
  });
  it('offers an explicit retry after autoplay rejection', async () => {
    const env = browserAudio(), player = createRecallPlayer(env);
    env.context.state = 'suspended'; env.context.resume.mockRejectedValueOnce(new Error('Autoplay blocked'));
    await player.load(new Uint8Array([1]));
    expect(await player.play()).toBe(false); expect(env.source.start).not.toHaveBeenCalled();
    expect(await player.play()).toBe(true); expect(env.source.start).toHaveBeenCalledOnce(); player.dispose();
  });
  it('also offers Play when blocked resume never settles; late resume does not start sound', async () => {
    vi.useFakeTimers();
    const env = browserAudio(), pending = deferred(), player = createRecallPlayer(env);
    env.context.state = 'suspended'; env.context.resume.mockReturnValueOnce(pending.promise);
    await player.load(new Uint8Array([1]));
    const play = player.play(); await vi.advanceTimersByTimeAsync(1000);
    expect(await play).toBe(false);
    pending.resolve(); await Promise.resolve();
    expect(env.source.start).not.toHaveBeenCalled(); player.dispose();
  });
  it('does not start after close during decode or resume', async () => {
    for (const boundary of ['decode', 'resume']) {
      const env = browserAudio(), player = createRecallPlayer(env), pending = deferred();
      if (boundary === 'decode') {
        env.context.decodeAudioData.mockReturnValue(pending.promise);
        const load = player.load(new Uint8Array([1])); player.dispose();
        pending.resolve({ numberOfChannels: 1, length: 1, duration: 1 });
        await expect(load).rejects.toMatchObject({ code: 'CANCELLED' });
      } else {
        await player.load(new Uint8Array([1])); env.context.state = 'suspended'; env.context.resume.mockReturnValue(pending.promise);
        const play = player.play(); player.dispose(); pending.resolve();
        await expect(play).rejects.toMatchObject({ code: 'CANCELLED' });
      }
      expect(env.source.start).not.toHaveBeenCalled();
    }
  });
  it('rejects oversized or non-mono decoded audio, without calling play', async () => {
    const env = browserAudio(), player = createRecallPlayer(env);
    await expect(player.load(new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow();
    expect(env.AudioContextClass).not.toHaveBeenCalled();
    env.context.decodeAudioData.mockResolvedValue({ numberOfChannels: 2, length: 100, duration: 1 });
    await expect(player.load(new Uint8Array([1]))).rejects.toThrow(); player.dispose();
    expect(env.source.start).not.toHaveBeenCalled();
  });
});
