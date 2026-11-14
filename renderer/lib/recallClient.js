import { createRecallRecorder, createRecallPlayer } from './recallAudio.js';

// One document, one active turn. This is display state only; main owns bounded follow-up
// context and fresh retrieval. Never persist or log questions, answers, sources or audio.
export const RECALL_ERRORS = {
  INVALID_REQUEST: 'Enter a question within 1000 characters and 4000 UTF-8 bytes.',
  NOT_READY: 'Recall is not ready. Check its provider, model, credentials, account access and credits in Settings.',
  BUSY: 'Recall is still finishing another operation. Wait briefly, then send again.',
  INVALID_ANSWER: 'The response could not be validated. No unverified answer is shown. Try asking again.',
  MALFORMED_ANSWER: 'The provider returned malformed answer data. Your question is kept; no unverified answer is shown.',
  UNSUPPORTED_ANSWER: 'Generated claims did not pass evidence verification. Your question is kept; no unverified answer is shown.',
  SOURCE_CHANGED: 'A source changed, was deleted, became ineligible or expired. Ask again for fresh evidence.',
  RATE_LIMITED: 'The provider reached a rate or usage limit. Wait before retrying.',
  UNAVAILABLE: 'Recall could not complete this request. Check provider access, limits and connectivity.',
  TIMEOUT: 'Recall timed out. Your question is kept; you can retry.', CANCELLED: 'Cancelled. Your question is kept.',
  NO_SPEECH: 'No speech was detected. Record a new question.', INCOMPLETE_TRANSCRIPT: 'Speech was incomplete. Record a shorter question.',
  MIC_DENIED: 'Microphone permission was denied. Allow access and try again.',
  MIC_MISSING: 'No microphone is available. Connect one and try again.',
  MIC_BUSY: 'The microphone is busy or unavailable. Choose an available device and retry; meeting recording was not stopped.',
  MIC_REMOVED: 'The Recall microphone disconnected. Reconnect it and start a new question.',
  INVALID_AUDIO: 'No usable microphone audio was captured. Start a new recording.',
  AUDIO_DECODE_FAILED: 'The spoken answer could not be decoded locally. No audio was played.',
  AUDIO_PLAYBACK_FAILED: 'Local speech playback failed. Check the output device and try again.',
};
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const validRecallQuestion = value => typeof value === 'string' && !!value.trim() && value.trim().length <= 1000 &&
  new TextEncoder().encode(value.trim()).byteLength <= 4000;
export function validRecallAnswer(value) {
  const scoped = Number.isInteger(value?.coverage?.meetings?.requested) && value.coverage.meetings.requested >= 1 && value.coverage.meetings.requested <= 5;
  if (!value || !['answered', 'insufficient_evidence'].includes(value.status) || typeof value.text !== 'string' ||
      !value.text.trim() || value.text.length > (scoped ? 1900 : 600) || !Array.isArray(value.sources) || value.sources.length > 12 ||
      !Array.isArray(value.claims) || !value.coverage || typeof value.coverage !== 'object' ||
      !Array.isArray(value.uncertainty) || value.uncertainty.some(item => typeof item !== 'string') || bytes(value) > 65536) return false;
  if (value.status === 'insufficient_evidence') return !value.sources.length && !value.claims.length;
  const ids = new Set();
  if (!value.sources.length || !value.claims.length || value.claims.length > 6) return false;
  return value.sources.every(source => {
    if (!source || !/^E[0-9a-f]{24}$/.test(source.evidenceId) || ids.has(source.evidenceId) ||
        typeof source.title !== 'string' || source.title.length > 240 || typeof source.section !== 'string' ||
        source.section.length > 120 || typeof source.text !== 'string' || !source.text || source.text.length > 1600 ||
        !source.locator || !['transcript', 'notes', 'markdown'].includes(source.locator.kind)) return false;
    ids.add(source.evidenceId); return true;
  });
}

export function createRecallClient({ api, onChange, uuid = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout,
  createRecorder = createRecallRecorder, createPlayer = createRecallPlayer }) {
  let disposed = false, active = null, sourceTimer = null, turnTimer = null, stateVersion = 0;
  let recorder = null, audioOwner = null, playbackTimer = null;
  let state = { draft: '', mode: 'text', muted: false, ready: false, readiness: null, stage: 'idle', busy: false,
    answer: null, question: '', history: [], error: null, sourceNotice: '', sourceStale: false, openingSource: null,
    captureSeconds: 0, autoStopped: false, questionOrigin: 'text', playback: 'idle' };
  const emit = patch => { if (!disposed) { state = { ...state, ...patch }; onChange(state); } };
  const isCurrent = id => !disposed && active?.id === id;
  const errorOf = (code, stage, speechCode) => {
    const safe = Object.hasOwn(RECALL_ERRORS, code) ? code : 'UNAVAILABLE';
    let message = RECALL_ERRORS[safe];
    if (['speaking', 'transcribing'].includes(stage) && !['CANCELLED', 'NO_SPEECH', 'INCOMPLETE_TRANSCRIPT'].includes(safe)) {
      const operation = stage === 'speaking' ? 'synthesis' : 'transcription';
      message = ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(speechCode) ? `Gnani returned invalid ${stage === 'speaking' ? 'speech audio' : 'transcription data'}.` :
        safe === 'NOT_READY' ? `Gnani ${operation} access is unavailable. Check the speech key, service scope and credits in Settings.` :
        safe === 'RATE_LIMITED' ? `Gnani ${operation} is rate limited. Wait before retrying.` :
        safe === 'TIMEOUT' ? `Gnani ${operation} timed out.` :
        safe === 'INVALID_REQUEST' ? `Gnani ${operation} settings or input are invalid. Check Meeting Recall Settings.` :
        `Gnani ${operation} failed. Check speech access and connectivity.`;
    }
    return { code: safe, stage, message };
  };
  function sendCancel(id) {
    try { void Promise.resolve(api.cancel({ requestId: uuid(), targetRequestId: id })).catch(() => {}); } catch { /* local cleanup already completed */ }
  }
  function releaseCapture() { recorder?.dispose(); recorder = null; }
  function releasePlayback() { const owner = audioOwner; audioOwner = null; owner?.player.dispose(); clearTimer(playbackTimer); }
  function fail(id, code, stage = state.stage, speechCode) {
    if (!isCurrent(id)) return;
    clearTimer(turnTimer);
    releaseCapture(); releasePlayback();
    const speechError = active.kind === 'voice' && active.answered;
    active = null;
    emit({ busy: false, stage: 'idle', error: errorOf(code, stage, speechCode), playback: speechError ? 'failed' : 'idle',
      ...(code === 'SOURCE_CHANGED' ? { sourceStale: true } : {}) });
  }
  const off = [];
  // Install every fixed event subscription before getState or submit can cause an event.
  off.push(api.onStage(event => {
    if (!isCurrent(event?.requestId)) return;
    if (active.kind === 'voice' && validRecallQuestion(event.question)) {
      active.question = event.question.trim(); active.rawQuestion = active.question;
      emit({ question: active.question, draft: active.question, questionOrigin: 'voice' });
    }
    if (event.status === 'running' && ['transcribing', 'retrieving', 'answering', 'speaking'].includes(event.stage)) emit({ stage: event.stage });
    else if (['complete', 'cancelled', 'error'].includes(event.status)) {
      if (event.status === 'complete' && !active.answered) { fail(event.requestId, 'INVALID_ANSWER'); return; }
      const error = event.status === 'cancelled' ? errorOf('CANCELLED') : event.status === 'error' && !state.error ? errorOf('UNAVAILABLE') : state.error;
      clearTimer(turnTimer); active = null; emit({ busy: false, stage: 'idle', error });
    }
  }));
  off.push(api.onAnswer(answer => {
    if (!isCurrent(answer?.requestId) || active.answered) return;
    try { if (!validRecallAnswer(answer)) { fail(answer.requestId, 'INVALID_ANSWER'); return; } }
    catch { fail(answer.requestId, 'INVALID_ANSWER'); return; }
    active.answered = true;
    const unchanged = state.draft === active.rawQuestion;
    emit({ answer, question: active.question, sourceStale: false, sourceNotice: '', error: null,
      ...(unchanged ? { draft: ['ambiguous_date', 'ambiguous_meetings'].includes(answer.coverage?.reason) ? active.question : '' } : {}) });
    clearTimer(sourceTimer);
    // Main handles expire after ten minutes from service start; a conservative display lease
    // ends at nine minutes from delivery. Opening always asks main to revalidate meanwhile.
    sourceTimer = setTimer(() => {
      if (!disposed && state.answer?.requestId === answer.requestId) emit({ sourceStale: true,
        answer: { ...state.answer, sources: [], claims: [] }, sourceNotice: 'Source handles expired. Ask again for fresh evidence.' });
    }, 9 * 60 * 1000);
  }));
  off.push(api.onError(event => {
    if (!isCurrent(event?.requestId)) return;
    if (active.kind === 'voice' && active.answered && event.error?.code === 'CANCELLED' && active.speechStopped) {
      clearTimer(turnTimer); active = null; emit({ busy: false, stage: 'idle', error: null }); return;
    }
    fail(event.requestId, event.error?.code, event.stage, event.error?.speechCode);
  }));
  async function playAudio(owner = audioOwner) {
    if (disposed || !owner || owner !== audioOwner || state.muted || recorder) return;
    clearTimer(playbackTimer);
    playbackTimer = setTimer(() => { if (audioOwner === owner) { releasePlayback(); emit({ playback: 'failed', error: errorOf('AUDIO_PLAYBACK_FAILED', 'playback') }); } }, 100000);
    try {
      const playing = await owner.player.play();
      if (!disposed && owner === audioOwner) emit({ playback: playing ? 'playing' : 'blocked' });
    } catch { if (!disposed && owner === audioOwner) { releasePlayback(); emit({ playback: 'failed', error: errorOf('AUDIO_PLAYBACK_FAILED', 'playback') }); } }
  }
  off.push(api.onAudio(event => {
    if (!isCurrent(event?.requestId) || active.kind !== 'voice' || !active.answered || active.audioReceived || state.muted || active.speechStopped || recorder) return;
    active.audioReceived = true;
    const audio = event.audio instanceof ArrayBuffer ? new Uint8Array(event.audio) : event.audio;
    if (event.mimeType !== 'audio/wav' || event.sampleRate !== 24000 || !(audio instanceof Uint8Array) ||
        !audio.byteLength || audio.byteLength > 4 * 1024 * 1024) { fail(event.requestId, 'UNAVAILABLE', 'speaking', 'INVALID_RESPONSE'); return; }
    releasePlayback();
    const owner = { id: event.requestId, player: null };
    owner.player = createPlayer({ onEnded: () => { if (!disposed && audioOwner === owner) { clearTimer(playbackTimer); emit({ playback: 'complete' }); } } });
    audioOwner = owner; emit({ playback: 'decoding' });
    playbackTimer = setTimer(() => { if (audioOwner === owner) { releasePlayback(); emit({ playback: 'failed', error: errorOf('AUDIO_DECODE_FAILED', 'decoding') }); } }, 100000);
    void owner.player.load(audio).then(() => {
      if (audioOwner === owner && !disposed && !state.muted && !recorder) return playAudio(owner);
    }).catch(() => { if (!disposed && audioOwner === owner) { releasePlayback(); emit({ playback: 'failed', error: errorOf('AUDIO_DECODE_FAILED', 'decoding') }); } });
  }));

  async function refresh() {
    const version = ++stateVersion;
    try {
      const reply = await api.getState({ requestId: uuid() });
      if (disposed || version !== stateVersion) return;
      if (!reply?.readiness || reply.error) { emit({ ready: false, error: errorOf('UNAVAILABLE') }); return; }
      emit({ ready: true, readiness: reply.readiness, ...(state.readiness ? {} : {
        mode: reply.preferences?.recallStartupMode === 'voice' ? 'voice' : 'text', muted: reply.preferences?.recallMuted === true }) });
    } catch { if (!disposed && version === stateVersion) emit({ ready: false, error: errorOf('UNAVAILABLE') }); }
  }
  function submit() {
    if (disposed || active || state.busy || state.mode !== 'text') return false;
    if (!validRecallQuestion(state.draft)) { emit({ error: errorOf('INVALID_REQUEST') }); return false; }
    if (!state.ready || !state.readiness?.text?.configured) { emit({ error: errorOf('NOT_READY') }); return false; }
    const question = state.draft.trim(), id = uuid();
    releasePlayback();
    active = { id, kind: 'text', network: true, question, rawQuestion: state.draft, answered: false };
    turnTimer = setTimer(() => { if (isCurrent(id)) { sendCancel(id); fail(id, 'TIMEOUT'); } }, 35000);
    const history = [...state.history];
    if (state.answer) history.push({ question: state.question, answer: state.answer.text });
    while (history.length > 3 || bytes(history) > 8192) history.shift();
    clearTimer(sourceTimer);
    emit({ busy: true, stage: 'retrieving', question, answer: null, history, error: null, sourceStale: false,
      sourceNotice: '', openingSource: null, questionOrigin: 'text', playback: 'idle', autoStopped: false });
    try {
      void Promise.resolve(api.submitText({ requestId: id, question })).then(reply => {
        if (!isCurrent(id)) return;
        if (reply?.requestId !== id || reply.status !== 'running') fail(id, reply?.error?.code || 'INVALID_ANSWER');
      }).catch(() => fail(id, 'UNAVAILABLE'));
    } catch { fail(id, 'UNAVAILABLE'); }
    return true;
  }
  function cancel() {
    if (disposed) return;
    if (!active) { releasePlayback(); emit({ playback: 'stopped' }); return; }
    const id = active.id, network = active.network; active = null;
    clearTimer(turnTimer);
    releaseCapture(); releasePlayback();
    emit({ busy: false, stage: 'idle', error: errorOf('CANCELLED'), playback: 'stopped' });
    if (network) sendCancel(id);
  }
  async function startVoice() {
    if (disposed || active || state.busy || state.mode !== 'voice') return false;
    if (!state.ready || !state.readiness?.text?.configured || !state.readiness?.stt?.configured || (!state.muted && !state.readiness?.tts?.configured)) {
      emit({ error: errorOf('NOT_READY') }); return false;
    }
    releasePlayback(); releaseCapture();
    const id = uuid(), token = { id, kind: 'voice', network: false, answered: false, question: '', rawQuestion: state.draft };
    active = token;
    const history = [...state.history];
    if (state.answer) history.push({ question: state.question, answer: state.answer.text });
    while (history.length > 3 || bytes(history) > 8192) history.shift();
    clearTimer(sourceTimer);
    emit({ busy: true, stage: 'starting', captureSeconds: 0, question: '', questionOrigin: 'voice', answer: null,
      history, autoStopped: false, playback: 'idle', error: null, sourceNotice: '', sourceStale: false, openingSource: null });
    turnTimer = setTimer(() => { if (isCurrent(id) && !token.network) fail(id, 'TIMEOUT'); }, 30000);
    recorder = createRecorder({ onLimit: () => stopVoice(true),
      onDuration: seconds => { if (isCurrent(id) && !token.network) emit({ captureSeconds: Math.min(25, seconds) }); },
      onError: code => fail(id, code || 'UNAVAILABLE') });
    try {
      await recorder.start();
      if (!isCurrent(id)) return false;
      clearTimer(turnTimer); emit({ stage: 'listening' }); return true;
    } catch (error) { if (isCurrent(id)) fail(id, error.code || 'UNAVAILABLE'); return false; }
  }
  function stopVoice(autoStopped = false) {
    const token = active;
    if (disposed || token?.kind !== 'voice' || token.network || !recorder) return false;
    let audio;
    try {
      const seconds = recorder.getDuration?.() ?? state.captureSeconds;
      audio = recorder.stop(); recorder = null;
      if (!(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > 3 * 1024 * 1024) throw new Error();
      emit({ captureSeconds: Math.min(25, seconds), autoStopped });
    } catch { fail(token.id, 'INVALID_AUDIO'); return false; }
    token.network = true;
    clearTimer(turnTimer);
    turnTimer = setTimer(() => { if (isCurrent(token.id)) { sendCancel(token.id); fail(token.id, 'TIMEOUT'); } }, 95000);
    emit({ stage: 'transcribing' });
    try {
      void Promise.resolve(api.submitAudio({ requestId: token.id, audio, mimeType: 'audio/wav', muted: state.muted })).then(reply => {
        if (isCurrent(token.id) && (reply?.requestId !== token.id || reply.status !== 'running')) fail(token.id, reply?.error?.code || 'INVALID_ANSWER', reply?.stage || 'delivery', reply?.error?.speechCode);
      }).catch(() => fail(token.id, 'UNAVAILABLE', 'delivery'));
    } catch { fail(token.id, 'UNAVAILABLE', 'delivery'); }
    return true;
  }
  function stopAudio() {
    releasePlayback();
    if (active?.kind === 'voice') {
      active.speechStopped = true;
      if (!active.network) cancel();
      else { const id = active.id; active = null; clearTimer(turnTimer); sendCancel(id); emit({ busy: false, stage: 'idle' }); }
    }
    emit({ playback: 'stopped' });
  }
  function setMuted(muted) {
    muted = !!muted;
    emit({ muted });
    if (muted) { releasePlayback(); emit({ playback: 'muted' }); }
    else if (state.playback === 'muted') emit({ playback: 'stopped' });
    if (active?.kind !== 'voice' || !active.network) return;
    const token = active, id = token.id;
    if (muted && state.stage === 'speaking') token.speechStopped = true;
    try {
      void Promise.resolve(api.setMuted({ requestId: uuid(), targetRequestId: id, muted })).then(reply => {
        if (!isCurrent(id)) return;
        if (reply?.status !== 'complete' && !muted) emit({ muted: true, error: errorOf('NOT_READY') });
      }).catch(() => { if (isCurrent(id)) { sendCancel(id); fail(id, 'UNAVAILABLE'); } });
    } catch { if (isCurrent(id)) { sendCancel(id); fail(id, 'UNAVAILABLE'); } }
  }
  async function openSource(evidenceId) {
    const answer = state.answer;
    if (disposed || state.sourceStale || state.openingSource || !answer?.sources.some(item => item.evidenceId === evidenceId)) return;
    emit({ openingSource: evidenceId, sourceNotice: '' });
    try {
      const reply = await api.openSource({ requestId: uuid(), answerRequestId: answer.requestId, evidenceId });
      if (disposed || state.answer?.requestId !== answer.requestId) return;
      if (reply?.navigation === 'requested') emit({ sourceNotice: 'Meeting viewer requested. Its unsaved-changes guard may keep you in the current view.' });
      else if (reply?.error?.code === 'SOURCE_CHANGED') emit({ sourceStale: true, sourceNotice: RECALL_ERRORS.SOURCE_CHANGED });
      else emit({ sourceNotice: 'Could not request the meeting viewer. Try again.' });
    } catch {
      if (!disposed && state.answer?.requestId === answer.requestId) emit({ sourceNotice: 'Could not request the meeting viewer. Try again.' });
    } finally { if (!disposed && state.answer?.requestId === answer.requestId) emit({ openingSource: null }); }
  }
  emit({});
  void refresh();
  return { getState: () => state, submit, cancel, refresh, openSource, startVoice, stopVoice, stopAudio, playAudio,
    setDraft: draft => emit({ draft }),
    setMode: mode => { if (!['text', 'voice'].includes(mode) || mode === state.mode) return; cancel(); releaseCapture(); releasePlayback(); emit({ mode, playback: 'idle' }); },
    setMuted,
    dispose() {
      if (disposed) return;
      const id = active?.network ? active.id : null; active = null; disposed = true; stateVersion++;
      clearTimer(sourceTimer); clearTimer(turnTimer); off.forEach(unsubscribe => unsubscribe());
      releaseCapture(); releasePlayback();
      state = { ...state, draft: '', question: '', answer: null, history: [], error: null, sourceNotice: '' };
      if (id) sendCancel(id);
    },
  };
}
