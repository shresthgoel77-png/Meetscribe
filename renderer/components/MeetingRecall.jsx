import React, { useEffect, useRef, useState } from 'react';
import { X, Maximize2, Minimize2, MessageSquareText, Volume2, VolumeX, Square } from 'lucide-react';
import { IconButton } from './ui/index.jsx';
import { createRecallClient, validRecallQuestion } from '../lib/recallClient.js';

const STAGES = { starting: 'Waiting for microphone access…', listening: 'Listening to your Recall microphone…',
  retrieving: 'Finding saved evidence…', answering: 'Checking an answer against evidence…', transcribing: 'Transcribing with Gnani Prisma…', speaking: 'Synthesizing with Gnani Timbre…' };
export function recallEnterAction(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return 'edit';
  return event.repeat ? 'ignore' : 'submit';
}
export function recallSourceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}
export function recallSourceLocator(source) {
  const locator = source.locator;
  if (locator.kind === 'transcript') {
    if (typeof locator.startSeconds === 'number' && Number.isFinite(locator.startSeconds) && locator.startSeconds >= 0) {
      const seconds = Math.floor(locator.startSeconds);
      return `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return Number.isInteger(locator.segmentIndex) && locator.segmentIndex >= 0
      ? `Transcript segment ${locator.segmentIndex + 1} · no recording timestamp` : 'Transcript · no recording timestamp';
  }
  const range = Number.isInteger(locator.from) && Number.isInteger(locator.to) && locator.from >= 0 && locator.to > locator.from
    ? ` · characters ${locator.from + 1}–${locator.to}` : '';
  return `${locator.kind === 'markdown' ? 'Saved Markdown notes' : 'Saved notes'}${range}`;
}
export function RecallAnswer({ view, openSource }) {
  const answer = view.answer;
  if (!answer) return null;
  const reasons = { empty_scope: 'No eligible saved content in this scope. Complete or import a meeting, or broaden the date range.',
    context_limit: 'Matching passages did not fit the evidence budget. Increase Recall’s context budget in Settings or narrow the question.',
    no_match: 'No matching saved passages were found. Try names, topics or a different date range.',
    ambiguous_date: 'Clarify the date in Text mode using YYYY-MM-DD or an explicit range. Confirm any misrecognized names.',
    ambiguous_meetings: 'Specify one to five latest meetings in Text mode.', insufficient_support: 'Matching passages did not support a verifiable answer.' };
  return <article className="recall-answer" aria-label="Latest Recall answer">
    <p className="recall-label">{answer.status === 'answered' ? 'Answer' : 'Insufficient evidence'}</p>
    {view.sourceStale && <p className="recall-notice" role="status">Earlier answer · sources need fresh retrieval.</p>}
    <p className="recall-answer-text" dir="auto">{answer.text}</p>
    {answer.status === 'insufficient_evidence' && reasons[answer.coverage?.reason] && <p className="recall-notice">{reasons[answer.coverage.reason]}</p>}
    {answer.coverage?.details === 'partial' && <p className="recall-notice">Partial coverage: some requested details remain unsupported.</p>}
    {answer.coverage?.withheldClaims && <p className="recall-notice">Some generated claims were withheld during validation. Only the verified claims are shown.</p>}
    {answer.coverage?.meetings && <p className="recall-notice">Verified sources cover {answer.coverage.meetings.cited} of {answer.coverage.meetings.requested} requested meetings ({answer.coverage.meetings.available} eligible meetings selected; passages retrieved from {answer.coverage.meetings.retrieved}).</p>}
    {answer.uncertainty?.includes('conflicting_evidence') && <p className="recall-notice">Saved sources disagree. Both decisions are retained; a later date alone does not resolve the conflict.</p>}
    {answer.uncertainty?.includes('reduced_retrieval') && <p className="recall-notice">Query expansion was unavailable. Relevant passages may have been missed.</p>}
    {answer.status === 'answered' && <p className="recall-meta">Based on selected passages. Other saved material may be relevant.</p>}
    {answer.sources.length > 0 && !view.sourceStale && <section className="recall-sources" aria-label="Answer sources">
      <p className="recall-meta">Evidence was checked when this answer was delivered. Open a source to recheck its current saved record.</p>
      {answer.sources.map(source => <div key={source.evidenceId} className="recall-source">
        <button type="button" className="recall-source-chip" disabled={!!view.openingSource}
          onClick={() => openSource(source.evidenceId)} aria-label={`Request meeting viewer: ${source.title}, ${recallSourceDate(source.startedAt)}`}>
          <span>{source.title}</span><span className="recall-meta">{recallSourceDate(source.startedAt)}</span>
        </button>
        <details><summary>Show saved evidence</summary>
          <p className="recall-meta">{source.section || 'Saved passage'} · {recallSourceLocator(source)}</p>
          <blockquote dir="auto">{source.text}</blockquote>
        </details>
      </div>)}
    </section>}
  </article>;
}

export function RecallFeedback({ view }) {
  if (!view?.error) return null;
  return <p className="recall-error" role="alert">{view.error.message}{view.answer ?
    !view.sourceStale && view.answer.sources?.length ? ' The delivered answer and sources remain available.' : ' The delivered text remains readable above.' : ''}</p>;
}

export default function MeetingRecall({ api, lifecycle, expanded, onToggleExpand, onClose }) {
  const client = useRef(null), input = useRef(null);
  const [view, setView] = useState(null);
  const [windowError, setWindowError] = useState('');
  useEffect(() => {
    if (!api || !lifecycle) return;
    const owner = createRecallClient({ api, onChange: setView }); client.current = owner;
    const remove = lifecycle.addCleanup(() => owner.dispose()); input.current?.focus();
    return () => { remove(); owner.dispose(); client.current = null; };
  }, [api, lifecycle]);
  useEffect(() => { if (view?.ready && view.mode === 'text') input.current?.focus(); }, [view?.ready, view?.mode]);
  const submit = () => { client.current?.submit(); input.current?.focus(); };
  const resize = async () => { try { await onToggleExpand(); setWindowError(''); } catch { setWindowError('Could not resize Meeting Recall.'); } };
  return <main className={`meeting-recall ${expanded ? 'is-expanded' : ''}`} aria-label="Meeting Recall">
    <header className="recall-header titlebar-drag">
      <MessageSquareText size={18} aria-hidden="true" /><h1>Meeting Recall</h1>
      <div className="titlebar-no-drag recall-actions">
        <IconButton label={expanded ? 'Compact Recall window' : 'Expand Recall window'} onClick={resize}>
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </IconButton>
        <IconButton label="Close Meeting Recall" onClick={onClose}><X size={16} /></IconButton>
      </div>
    </header>
    <div className="recall-toolbar" aria-label="Recall mode and audio controls">
      <div className="recall-modes" role="group" aria-label="Recall mode">
        {['text', 'voice'].map(mode => <button type="button" key={mode} aria-pressed={(view?.mode || 'text') === mode}
          onClick={() => client.current?.setMode(mode)}>{mode === 'text' ? 'Text' : 'Voice'}</button>)}
      </div>
      <IconButton label={view?.muted ? 'Unmute Recall speech' : 'Mute Recall speech'} pressed={view?.muted}
        onClick={() => client.current?.setMuted(!view?.muted)}>{view?.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</IconButton>
      <IconButton label="Stop Recall audio" disabled={!(view?.mode === 'voice' && view.busy) && !['decoding', 'playing', 'blocked', 'complete'].includes(view?.playback)}
        onClick={() => client.current?.stopAudio()}><Square size={14} /></IconButton>
    </div>
    <div className="recall-scroll" tabIndex={0} aria-label="Recall answers and evidence">
      {!api && <p role="alert">Open Meeting Recall in the MeetScribe desktop app.</p>}
      {api && !view?.ready && <p className="recall-meta" role="status">Loading Recall readiness…</p>}
      {view?.ready && !view.readiness?.text?.configured && <p className="recall-notice" role="status">Configure Meeting Recall in the main window’s Settings. Choose an answer provider/model and add its credential in the existing provider settings.</p>}
      {view?.ready && !view.answer && !view.busy && <div className="recall-welcome">
        <h2>Ask your saved meetings</h2><p>Complete recordings, imports and pasted transcripts can provide evidence. Current recordings and unfinished work are excluded.</p>
      </div>}
      {view?.history.length > 0 && <details className="recall-history"><summary>Earlier turns in memory ({view.history.length})</summary>
        <p className="recall-meta">Earlier answers are conversational context. Each new answer needs freshly retrieved evidence.</p>
        {view.history.map((pair, index) => <div key={index}><p className="recall-label" dir="auto">{pair.question}</p><p dir="auto">{pair.answer}</p></div>)}
      </details>}
      {view?.question && <div className="recall-question" dir="auto">
        {view.questionOrigin === 'voice' && <p className="recall-label">Recognized question</p>}{view.question}
      </div>}
      {view?.busy && <p className="recall-notice" role="status">{STAGES[view.stage] || 'Working…'}</p>}
      {view?.answer && <RecallAnswer view={view} openSource={id => client.current?.openSource(id)} />}
      {view?.sourceNotice && <p className="recall-notice" role="status">{view.sourceNotice}</p>}
      {view?.sourceStale && <button type="button" className="btn-quiet btn-sm" onClick={() => { client.current?.setDraft(view.question); input.current?.focus(); }}>Reuse question for fresh evidence</button>}
      <RecallFeedback view={view} />
      {view?.playback === 'decoding' && <p className="recall-meta" role="status">Speech WAV received. Decoding locally…</p>}
      {view?.playback === 'playing' && <p className="recall-meta" role="status">Playing the spoken answer. Use Stop or Mute to halt it.</p>}
      {view?.playback === 'blocked' && <p className="recall-notice" role="status">Automatic playback was blocked. Press Play spoken answer.</p>}
      {view?.playback === 'complete' && <p className="recall-meta" role="status">Playback completed; audibility depends on your output device.</p>}
      {['blocked', 'complete'].includes(view?.playback) && !view.muted && <button type="button" className="btn-ghost btn-sm" onClick={() => client.current?.playAudio()}>Play spoken answer</button>}
      {windowError && <p className="recall-error" role="alert">{windowError}</p>}
      <details className="recall-disclosures"><summary>Cloud, audio and memory</summary>
        <p>Questions and selected saved-meeting evidence go to the answering LLM. Voice audio and synthesized text go to Gnani after explicit Start.</p>
        <p>System loopback may record spoken answers, even through headphones. Mute or stop Recall audio; MeetScribe never pauses a meeting to avoid playback capture.</p>
        <p>Conversation context stays bounded in memory and clears when this window is destroyed. Each turn retrieves fresh evidence. Configuration checks do not prove provider access.</p>
      </details>
    </div>
    <footer className="recall-composer">
      <p className="recall-meta">Questions and selected saved excerpts go to your answering LLM.</p>
      {view?.mode === 'voice' ? <div className="recall-voice-controls">
        <p className="recall-meta">Voice audio/text goes to Gnani. System loopback may record spoken answers, even through headphones. Mute or stop Recall audio; the meeting continues.</p>
        {!view.busy && <p className="recall-meta" role="status">Voice is idle until you press Start. Starting a new recording stops Recall playback first.</p>}
        {['starting', 'listening'].includes(view.stage) && <p role="status" className="recall-capture-duration">Microphone: {view.captureSeconds.toFixed(1)} / 25 seconds</p>}
        {view.autoStopped && <p className="recall-meta" role="status">Auto-stopped at the 25-second limit.</p>}
        {view.ready && (!view.readiness?.stt?.configured || (!view.muted && !view.readiness?.tts?.configured)) && <p className="recall-notice">Configure Gnani speech in Meeting Recall Settings. Mute skips spoken replies.</p>}
        {view.stage === 'listening' ? <button type="button" className="btn-sunshine btn-sm" onClick={() => client.current?.stopVoice()}>Stop and ask</button> :
          <button type="button" className="btn-sunshine btn-sm" disabled={!view.ready || view.busy || !view.readiness?.text?.configured || !view.readiness?.stt?.configured || (!view.muted && !view.readiness?.tts?.configured)} onClick={() => client.current?.startVoice()}>Start microphone</button>}
        <button type="button" className="btn-quiet btn-sm" onClick={() => client.current?.setMode('text')}>Ask in Text mode</button>
      </div> : <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <label htmlFor="recall-question" className="sr-only">Question about saved meetings</label>
        <textarea ref={input} id="recall-question" rows={2} maxLength={1000} disabled={!view?.ready} value={view?.draft || ''} dir="auto"
          placeholder="What did we decide?" aria-describedby="recall-question-help" onChange={event => client.current?.setDraft(event.target.value)}
          onKeyDown={event => {
            const action = recallEnterAction(event);
            if (action !== 'edit') event.preventDefault();
            if (action === 'submit') submit();
          }} />
        <div className="recall-composer-row"><span id="recall-question-help" className="recall-meta">Enter sends · Shift+Enter adds a line</span>
          <button type="submit" className="btn-sunshine btn-sm" disabled={!view?.ready || !view.readiness?.text?.configured || view.busy || !validRecallQuestion(view.draft)}>Send</button>
        </div>
      </form>}
      <div className="recall-composer-row">
        <button type="button" className="btn-quiet btn-sm" onClick={() => client.current?.refresh()} disabled={view?.busy}>Refresh readiness</button>
        <button type="button" className="btn-ghost btn-sm" disabled={!view?.busy} onClick={() => { client.current?.cancel(); input.current?.focus(); }}>Cancel</button>
      </div>
    </footer>
  </main>;
}
