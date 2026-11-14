import processorUrl from './recallAudioProcessor.js?url&no-inline';

// Only Recall-owned mic tracks/graphs. Inert until explicit start/play; no meeting bridge,
// capture singleton, network, persistent storage, Blob URL or browser speech API.
const audioError = (code) => Object.assign(new Error(code), { code });
const closeContext = context => { if (context && context.state !== 'closed') void context.close().catch(() => {}); };

export function encodeRecallWav(chunks, sampleRate) {
  const count = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || !count || count > sampleRate * 25) throw audioError('INVALID_AUDIO');
  const audio = new Uint8Array(44 + count * 2);
  const view = new DataView(audio.buffer);
  const word = (offset, text) => { for (let i = 0; i < text.length; i++) audio[offset + i] = text.charCodeAt(i); };
  word(0, 'RIFF'); view.setUint32(4, audio.length - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const value of chunk) {
    if (!Number.isFinite(value)) throw audioError('INVALID_AUDIO');
    const clamped = Math.max(-1, Math.min(1, value));
    view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true); offset += 2;
  }
  return audio;
}

export function createRecallRecorder({ onLimit = () => {}, onError = () => {}, onDuration = () => {},
  AudioContextClass = globalThis.AudioContext, WorkletNodeClass = globalThis.AudioWorkletNode,
  mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
  let context, stream, source, processor, timer;
  let disposed = false, started = false, chunks = [], frames = 0, reportedDuration = -1;
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearTimeout(timer);
    if (processor) { processor.port.onmessage = null; processor.onprocessorerror = null; processor.disconnect(); processor.port.close(); }
    source?.disconnect(); stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    closeContext(context); chunks = []; frames = 0;
  };
  const limit = () => { if (!disposed) { try { onLimit(); } finally { dispose(); } } };
  return {
    async start() {
      if (started || disposed) throw audioError('CANCELLED');
      started = true;
      try {
        if (!mediaDevices?.getUserMedia || !AudioContextClass || !WorkletNodeClass) throw audioError('UNAVAILABLE');
        stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
        if (disposed) { stream.getTracks().forEach(track => track.stop()); throw audioError('CANCELLED'); }
        // Bound ownership from permission grant, even if graph/module setup stalls.
        timer = setTimeout(limit, 25000);
        context = new AudioContextClass({ sampleRate: 16000 });
        if (context.sampleRate < 8000 || context.sampleRate > 48000) throw audioError('UNAVAILABLE');
        await context.resume();
        if (disposed) throw audioError('CANCELLED');
        if (context.state !== 'running') throw audioError('UNAVAILABLE');
        await context.audioWorklet.addModule(processorUrl);
        if (disposed) throw audioError('CANCELLED');
        source = context.createMediaStreamSource(stream);
        processor = new WorkletNodeClass(context, 'recall-pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
        processor.port.onmessage = ({ data }) => {
          if (disposed || !(data instanceof Float32Array)) return;
          const copy = data.slice(0, Math.max(0, context.sampleRate * 25 - frames));
          chunks.push(copy); frames += copy.length;
          const duration = Math.floor(frames / context.sampleRate * 10) / 10;
          if (duration !== reportedDuration) { reportedDuration = duration; onDuration(duration); }
          if (frames >= context.sampleRate * 25) limit();
        };
        processor.onprocessorerror = () => { dispose(); onError(); };
        stream.getTracks().forEach(track => { track.onended = () => { dispose(); onError('MIC_REMOVED'); }; });
        source.connect(processor); processor.connect(context.destination); // processor outputs silence
      } catch (error) {
        const cancelled = disposed || error?.code === 'CANCELLED';
        dispose();
        throw audioError(cancelled ? 'CANCELLED' : ({ NotAllowedError: 'MIC_DENIED', NotFoundError: 'MIC_MISSING',
          NotReadableError: 'MIC_BUSY', AbortError: 'MIC_BUSY' }[error?.name] || 'UNAVAILABLE'));
      }
    },
    stop() {
      if (disposed || !context) throw audioError('CANCELLED');
      try { return encodeRecallWav(chunks, context.sampleRate); } finally { dispose(); }
    },
    getDuration: () => context ? frames / context.sampleRate : 0,
    dispose,
  };
}

export function createRecallPlayer({ onEnded = () => {}, AudioContextClass = globalThis.AudioContext } = {}) {
  let context, buffer, source;
  let disposed = false, playing = false, playPending = null, epoch = 0;
  const stop = () => {
    epoch++;
    if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); source = null; }
    playing = false;
  };
  return {
    async load(audio) {
      if (disposed || context || !AudioContextClass || !(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > 4 * 1024 * 1024) throw audioError('INVALID_AUDIO');
      context = new AudioContextClass({ sampleRate: 24000 });
      // decodeAudioData may detach its input. Preserve only the view's selected bytes.
      buffer = await context.decodeAudioData(audio.slice().buffer);
      if (disposed) { buffer = null; throw audioError('CANCELLED'); }
      if (buffer.numberOfChannels !== 1 || !buffer.length || buffer.duration > 90 || buffer.length > 48000 * 90) throw audioError('INVALID_AUDIO');
    },
    async play() {
      if (disposed || !buffer) throw audioError('CANCELLED');
      if (playing) return true;
      if (playPending) return playPending;
      const generation = epoch;
      playPending = (async () => {
      // Suspended/rejected autoplay is a recoverable state: the UI offers explicit Play.
      let timer;
      try {
        if (context.state !== 'running') await Promise.race([
          context.resume(), new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
        ]);
      } catch { return false; } finally { clearTimeout(timer); }
      if (disposed || epoch !== generation) throw audioError('CANCELLED');
      if (context.state !== 'running') return false;
      source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      source.onended = () => { stop(); if (!disposed) onEnded(); };
      source.start(); playing = true; return true;
      })();
      try { return await playPending; } finally { playPending = null; }
    },
    stop,
    dispose() { disposed = true; stop(); buffer = null; closeContext(context); },
  };
}
