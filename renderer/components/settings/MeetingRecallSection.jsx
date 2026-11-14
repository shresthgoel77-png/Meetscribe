import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../lib/app-context.js';
import { PasswordField, TextField, Switch } from '../ui/index.jsx';
import { SettingsGroup, SettingRow, RadioCardGroup, TestAction, TestResult } from './SettingsParts.jsx';
import ModelSelect from './providers/ModelSelect.jsx';
import { createRecallRecorder, createRecallPlayer } from '../../lib/recallAudio.js';
import { RECALL_DEFAULTS, RECALL_VOICES, RECALL_TTS_LANGUAGES, recallTestValues, validRecallShortcut } from '../../lib/recallSettings.js';

function Choice({ field, label, value, options, onChange }) {
  return <div>
    <label htmlFor={field} className="label">{label}</label>
    <select id={field} className="input" value={value} onChange={event => onChange(field, event.target.value)}>
      {!options.some(option => option.id === value) && <option value={value}>{value || 'Choose…'} (unsupported)</option>}
      {options.map(option => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}
    </select>
  </div>;
}
const choices = values => values.map(id => ({ id }));
const languageNames = { auto: 'Auto (from text)', 'hi-IN': 'Hindi', 'en-IN': 'Indian English', 'hi-en': 'Hinglish',
  'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi',
  'pa-IN': 'Punjabi', 'bn-IN': 'Bengali', 'gu-IN': 'Gujarati' };

export default function MeetingRecallSection({ form, onChange, active = false, resetToken = 0, savedShortcut }) {
  const { providers } = useApp();
  const provider = providers?.llm?.find(item => item.id === form.recallLlmProvider);
  const [results, setResults] = useState({});
  const [phase, setPhase] = useState('');
  const [transcript, setTranscript] = useState('');
  const [testText, setTestText] = useState('MeetScribe speech playback test.');
  const [playback, setPlayback] = useState('');
  const [shortcutStatus, setShortcutStatus] = useState(null);
  const resources = useRef({ job: null, recorder: null, player: null });
  const voices = RECALL_VOICES[form.recallTtsModel] || [];
  const validVoice = voices.includes(form.recallTtsVoice);
  const validTts = validVoice && RECALL_TTS_LANGUAGES.includes(form.recallTtsLanguage);
  const speechFingerprint = JSON.stringify(recallTestValues('stt', form)) + JSON.stringify(recallTestValues('tts', form));
  const llmFingerprint = JSON.stringify(provider ? recallTestValues('llm', form, provider) : [form.recallLlmProvider, form.recallLlmModels]);

  useEffect(() => {
    if (!active || !window.meetscribe?.recall?.getState) return;
    let current = true;
    void window.meetscribe.recall.getState({ requestId: crypto.randomUUID() }).then(reply => {
      if (current) setShortcutStatus(reply?.readiness?.shortcut || null);
    }).catch(() => { if (current) setShortcutStatus(null); });
    return () => { current = false; };
  }, [active, savedShortcut]);

  const release = useCallback(() => {
    const owned = resources.current;
    const job = owned.job; owned.job = null;
    owned.recorder?.dispose(); owned.recorder = null;
    owned.player?.dispose(); owned.player = null;
    if (job?.network) {
      void window.meetscribe?.recall?.cancelTest?.({ requestId: crypto.randomUUID(), targetRequestId: job.id })?.catch(() => {});
    }
  }, []);

  // Hidden panels remain mounted by Settings: stop on hide as well as unmount/discard.
  // Fingerprints include unsaved credentials/choices. Late replies cannot restore stale proof.
  useEffect(() => {
    release(); setResults({}); setTranscript(''); setPlayback(''); setPhase('');
    return release;
  }, [active, resetToken, speechFingerprint, llmFingerprint, testText, release]);
  useEffect(() => {
    const stop = () => release();
    window.addEventListener('pagehide', stop);
    return () => window.removeEventListener('pagehide', stop);
  }, [release]);

  const current = job => resources.current.job === job;
  const begin = kind => {
    if (!active || resources.current.job) return null;
    resources.current.player?.dispose(); resources.current.player = null; setPlayback('');
    const job = { id: crypto.randomUUID(), kind, network: false };
    resources.current.job = job; setPhase(kind); setResults(previous => ({ ...previous, [kind]: null }));
    return job;
  };
  const fail = (job, message) => {
    if (!current(job)) return;
    resources.current.recorder?.dispose(); resources.current.recorder = null;
    resources.current.player?.dispose(); resources.current.player = null;
    resources.current.job = null; setPhase(''); setPlayback('');
    setResults(previous => ({ ...previous, [job.kind]: { success: false, error: message } }));
  };
  const play = async player => {
    try {
      const started = await player.play();
      if (resources.current.player !== player) return;
      setPlayback(started ? 'playing' : 'blocked'); setPhase(started ? 'playing' : '');
    } catch {
      if (resources.current.player !== player) return;
      setPlayback('failed'); setPhase('');
    }
  };
  const run = async (kind, job = begin(kind), audio) => {
    if (!job) return;
    try {
      const api = window.meetscribe?.recall;
      const method = { stt: 'testStt', tts: 'testTts', llm: 'testLlm' }[kind];
      if (!api?.[method]) { fail(job, 'Recall test IPC is unavailable.'); return; }
      const values = recallTestValues(kind, form, provider);
      if (kind === 'tts' && (!validTts || !testText.trim())) { fail(job, 'Choose a compatible voice/language and enter test text.'); return; }
      if (kind === 'stt') setTranscript('');
      job.network = true; setPhase(kind);
      const reply = await api[method]({ requestId: job.id, values,
        ...(kind === 'stt' ? { audio, mimeType: 'audio/wav' } : kind === 'tts' ? { text: testText } : {}) });
      if (!current(job)) return;
      job.network = false;
      if (reply?.requestId !== job.id || reply.status !== 'complete' || reply.verified !== true || reply.test !== kind) {
        fail(job, reply?.error?.message || 'The test did not complete.'); return;
      }
      setResults(previous => ({ ...previous, [kind]: { success: true } }));
      if (kind === 'stt') setTranscript(reply.transcript);
      if (kind === 'tts') {
        setPlayback('decoding');
        const player = createRecallPlayer({ onEnded: () => {
          if (resources.current.player !== player) return;
          setPlayback('complete'); setPhase('');
        } });
        resources.current.player = player;
        try {
          await player.load(reply.audio);
          if (!current(job)) return;
          resources.current.job = null;
          await play(player);
        } catch {
          if (!current(job)) return;
          player.dispose(); resources.current.player = null;
          setPlayback('decode-failed'); resources.current.job = null; setPhase('');
        }
        return;
      }
      resources.current.job = null; setPhase('');
    } catch { fail(job, 'The test is unavailable. Check the settings and try again.'); }
  };
  const finishStt = job => {
    if (!job || !current(job) || !resources.current.recorder || job.network) return;
    try {
      const audio = resources.current.recorder.stop(); resources.current.recorder = null;
      void run('stt', job, audio);
    } catch { fail(job, 'No usable audio was captured. Start a new microphone test.'); }
  };
  const startStt = async () => {
    const job = begin('stt'); if (!job) return;
    setTranscript(''); setPhase('starting');
    const recorder = createRecallRecorder({ onLimit: () => finishStt(job),
      onError: () => fail(job, 'The microphone stopped. Start a new test.') });
    resources.current.recorder = recorder;
    try {
      await recorder.start();
      if (current(job)) setPhase('recording');
    } catch (error) { fail(job, error.code === 'MIC_DENIED' ? 'Microphone permission was denied. Allow access and try again.' : 'The microphone is unavailable. Check access and try again.'); }
  };
  const stopTests = () => { release(); setPhase(''); setPlayback('stopped'); };
  const setProvider = id => {
    onChange('recallLlmProvider', id);
    if (!form.recallLlmModels?.[id]) {
      const selected = providers.llm.find(item => item.id === id);
      onChange('recallLlmModels', { ...form.recallLlmModels,
        [id]: RECALL_DEFAULTS.recallLlmModels[id] || selected.defaultModel });
    }
  };
  const disabled = !!phase || !active;

  return <div className="space-y-24">
    <SettingsGroup title="Meeting Recall" description="Ask about complete saved meetings, including imports and pasted transcripts. Follow-ups stay bounded in memory and retrieve fresh evidence each turn.">
      <p className="text-caption text-graphite">Questions and selected saved-meeting evidence go to the answering LLM. Voice audio and synthesized text go to Gnani. Tests make real cloud requests only when you start them; they use the current unsaved values and never save settings.</p>
      <p className="text-caption text-graphite">System loopback may record spoken assistant answers, even through headphones. Mute or stop Recall playback; MeetScribe will never pause a meeting to avoid capture.</p>
    </SettingsGroup>

    <SettingsGroup title="Gnani speech" description="Gnani is used only for Recall speech. Meeting transcription keeps its existing service.">
      <PasswordField id="recall-gnani-key" label="Gnani API key" value={form.recallGnaniApiKey} maxLength={4096}
        onChange={event => onChange('recallGnaniApiKey', event.target.value)} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-16">
        <Choice field="recallSttModel" label="STT model" value={form.recallSttModel} options={[{ id: 'prisma-v3.0', name: 'Prisma v3.0' }]} onChange={onChange} />
        <Choice field="recallSttLanguage" label="STT language hints (language_code)" value={form.recallSttLanguage} options={[{ id: 'hi-IN,en-IN', name: 'Hindi + Indian English (hi-IN,en-IN)' }]} onChange={onChange} />
      </div>
      <p className="hint">Start explicitly enables only the Recall test microphone. Stop sends one PCM WAV clip to Prisma; the test also stops at 25 seconds. No microphone starts on opening Settings or selecting Voice.</p>
      <fieldset disabled={disabled}>
        <TestAction label="Start microphone STT test" testing={['starting', 'recording', 'stt'].includes(phase)} onClick={startStt} result={results.stt} successLabel="STT network test passed" />
      </fieldset>
      {phase === 'starting' && <p role="status" className="hint">Waiting for microphone access… Cancel remains available.</p>}
      {phase === 'recording' && <div className="flex items-center gap-16">
        <p role="status" className="hint">Recording Recall test only (up to 25 seconds)…</p>
        <button type="button" className="btn-ghost btn-sm" onClick={() => finishStt(resources.current.job)}>Stop and test STT</button>
      </div>}
      {transcript && <p className="text-caption text-ink break-words" role="status">Test transcript: {transcript}</p>}

      <Choice field="recallTtsModel" label="TTS model" value={form.recallTtsModel} options={choices(Object.keys(RECALL_VOICES))} onChange={onChange} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-16">
        <Choice field="recallTtsVoice" label="Compatible TTS voice" value={form.recallTtsVoice} options={choices(voices)} onChange={onChange} />
        <Choice field="recallTtsLanguage" label="TTS language (language)" value={form.recallTtsLanguage} options={RECALL_TTS_LANGUAGES.map(id => ({ id, name: `${languageNames[id]} — ${id}` }))} onChange={onChange} />
      </div>
      {!validVoice && <p role="alert" className="text-caption text-signal">Choose a compatible voice for this Timbre model before testing or saving.</p>}
      <TextField id="recall-test-text" label="TTS test text (not saved)" value={testText} maxLength={2000} onChange={event => setTestText(event.target.value)} />
      <fieldset disabled={disabled}>
        <TestAction label="Test Gnani TTS" testing={phase === 'tts'} onClick={() => run('tts')} result={results.tts} successLabel="TTS network test passed; WAV received" />
      </fieldset>
      {playback === 'decoding' && <p role="status" className="hint">Decoding received audio…</p>}
      {playback === 'playing' && <p role="status" className="hint">Playback started; audibility has not been confirmed.</p>}
      {playback === 'complete' && <TestResult result={{ success: true }} successLabel="Playback completed; confirm you heard the test" />}
      {playback === 'blocked' && <p role="status" className="hint">Automatic playback was blocked. Press Play to try with a user gesture.</p>}
      {(playback === 'failed' || playback === 'decode-failed') && <TestResult result={{ success: false, error: 'Network succeeded; local audio decode/playback failed.' }} />}
      {resources.current.player && !phase && <button type="button" className="btn-ghost btn-sm" onClick={() => play(resources.current.player)}>Play test audio</button>}
      {(phase || resources.current.player) && <button type="button" className="btn-ghost btn-sm" onClick={stopTests}>Cancel test / stop playback</button>}
    </SettingsGroup>

    <SettingsGroup title="Answering LLM" description="Uses credentials from existing provider settings, including unsaved credential edits. Changing this choice does not change Notes provider/model selection or its fallback.">
      <Choice field="recallLlmProvider" label="Recall answer provider" value={form.recallLlmProvider} options={providers?.llm || []} onChange={(_field, value) => setProvider(value)} />
      {provider && <ModelSelect idPrefix="recall-answer" label="Recall answer model"
        provider={{ ...provider, defaultModel: RECALL_DEFAULTS.recallLlmModels[provider.id] || provider.defaultModel }}
        value={form.recallLlmModels?.[provider.id] || ''}
        onChange={value => onChange('recallLlmModels', { ...form.recallLlmModels, [provider.id]: value })} />}
      <fieldset disabled={disabled}>
        <TestAction label="Test Recall answering LLM" testing={phase === 'llm'} onClick={() => run('llm')} result={results.llm} successLabel="Selected Recall provider/model network test passed" />
      </fieldset>
      <p className="hint">This checks connectivity with a small fixed request. It does not generate notes, test answer quality or save credentials.</p>
    </SettingsGroup>

    <SettingsGroup title="Open and playback preferences" description="These preferences apply after Save. A shortcut conflict keeps the previous saved binding; choose another shortcut or disable it.">
      {shortcutStatus && <p role="status" className="hint">Saved shortcut: {shortcutStatus}. Unsaved edits are not registered.</p>}
      <TextField id="recall-shortcut" label="Global shortcut" value={form.recallShortcut} maxLength={80}
        hint="For example CommandOrControl+Shift+Space. Use Plus for the + key. Leave empty to disable. Syntax checks do not reserve a shortcut or prove availability."
        aria-invalid={!validRecallShortcut(form.recallShortcut)} onChange={event => onChange('recallShortcut', event.target.value)} />
      {!validRecallShortcut(form.recallShortcut) && <p role="alert" className="text-caption text-signal">Enter modifiers joined with + and one supported key, or disable the shortcut.</p>}
      <button type="button" className="btn-quiet btn-sm" onClick={() => onChange('recallShortcut', '')}>Disable shortcut</button>
      <RadioCardGroup label="Recall startup mode" options={[{ id: 'text', name: 'Text' }, { id: 'voice', name: 'Voice (waits for Start)' }]}
        value={form.recallStartupMode} onChange={value => onChange('recallStartupMode', value)} className="grid grid-cols-1 md:grid-cols-2 gap-16"
        renderOption={option => <span className="text-body-sm font-medium">{option.name}</span>} />
      <SettingRow label="Mute Recall answers" description="Skips spoken answers. The explicit TTS test above can still play sound." htmlFor="recall-muted">
        <Switch id="recall-muted" label="Mute Recall answers" checked={form.recallMuted} onChange={value => onChange('recallMuted', value)} />
      </SettingRow>
      <TextField id="recall-context-budget" type="number" min={1000} max={24000} step={1} label="Evidence context budget (UTF-8 bytes)"
        hint="1000–24000 bytes of serialized selected evidence. This is not a token count."
        value={form.recallContextBudget} onChange={event => onChange('recallContextBudget', Number(event.target.value))} />
    </SettingsGroup>
  </div>;
}
