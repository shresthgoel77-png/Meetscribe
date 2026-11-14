/* global window */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import Settings from '../renderer/components/Settings.jsx';
import MeetingRecallSection from '../renderer/components/settings/MeetingRecallSection.jsx';
import { createRecallRecorder, createRecallPlayer } from '../renderer/lib/recallAudio.js';
import { RECALL_DEFAULTS, RECALL_VOICES, RECALL_TTS_LANGUAGES, recallFormFromConfig, recallTestValues, validRecallShortcut } from '../renderer/lib/recallSettings.js';

// No browser/DOM test dependency is installed. This hook harness runs the actual component
// event handlers/effect cleanups and inspects their React elements. It does not prove DOM,
// keyboard focus, CSS, desktop navigation or audibility; those remain manual checks.
const state = vi.hoisted(() => ({ harness: null, app: null }));
vi.mock('../renderer/lib/app-context.js', () => ({ useApp: () => state.app }));
vi.mock('../renderer/components/settings/providers/providerIcons.js', () => ({ providerIcon: () => () => null }));
vi.mock('../renderer/components/NotionIcon.jsx', () => ({ default: () => null }));
vi.mock('../renderer/components/GoogleCalendarIcon.jsx', () => ({ default: () => null }));
vi.mock('../renderer/lib/recallAudio.js', () => ({ createRecallRecorder: vi.fn(), createRecallPlayer: vi.fn() }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual,
    useState: initial => state.harness.useState(initial), useRef: initial => state.harness.useRef(initial),
    useEffect: (effect, deps) => state.harness.useEffect(effect, deps),
    useMemo: (fn, deps) => state.harness.useMemo(fn, deps),
    useCallback: (fn, deps) => state.harness.useMemo(() => fn, deps),
  };
});
class Harness {
  constructor(Component, props) { this.Component = Component; this.props = props; this.cells = []; this.effects = []; this.render(); }
  useState(initial) {
    const index = this.index++;
    if (!(index in this.cells)) this.cells[index] = typeof initial === 'function' ? initial() : initial;
    return [this.cells[index], value => { this.cells[index] = typeof value === 'function' ? value(this.cells[index]) : value; }];
  }
  useRef(initial) { const [cell] = this.useState(() => ({ current: initial })); return cell; }
  useMemo(fn, deps) {
    const index = this.index++, old = this.cells[index];
    if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) this.cells[index] = { deps, value: fn() };
    return this.cells[index].value;
  }
  useEffect(effect, deps) {
    const index = this.index++, old = this.cells[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
      this.effects.push(() => { old?.cleanup?.(); this.cells[index] = { deps, cleanup: effect() }; });
    }
  }
  render() {
    this.index = 0; state.harness = this;
    this.tree = this.Component(this.props);
    this.effects.splice(0).forEach(effect => effect());
    return this;
  }
  async settle() { for (let i = 0; i < 5; i++) { await Promise.resolve(); this.render(); } return this; }
  nodes() {
    const out = [];
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!React.isValidElement(node)) return;
      out.push(node); visit(node.props.children);
    };
    visit(this.tree); return out;
  }
  find(match) { const node = this.nodes().find(match); expect(node, 'expected React element').toBeTruthy(); return node; }
  named(name) { return this.find(node => node.type?.name === name); }
  label(label) { return this.find(node => node.props.label === label); }
  text(text) { return this.find(node => node.props.children === text); }
  unmount() { this.cells.forEach(cell => cell?.cleanup?.()); }
}
const require = createRequire(import.meta.url);
const { llmRegistry, sttRegistry } = require('../electron/providers');
const providers = { llm: llmRegistry.describeAll(), stt: sttRegistry.describeAll() };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let api, recorder, player, harnesses;
function section(form = {}, active = true) {
  let h;
  const onChange = vi.fn((key, value) => { h.props.form = { ...h.props.form, [key]: value }; });
  h = new Harness(MeetingRecallSection, { form: { ...structuredClone(RECALL_DEFAULTS), groqApiKey: 'unsaved-test-key', ...form }, onChange, active });
  harnesses.push(h); h.render(); return h;
}
function result(h, kind) {
  return h.label({ stt: 'Start microphone STT test', tts: 'Test Gnani TTS', llm: 'Test Recall answering LLM' }[kind]).props.result;
}
beforeEach(() => {
  vi.clearAllMocks(); harnesses = [];
  state.app = { providers, confirm: vi.fn(async () => true), setNavGuard: vi.fn(), addToast: vi.fn(), keysNotSet: false };
  api = { testStt: vi.fn(), testTts: vi.fn(), testLlm: vi.fn(), cancelTest: vi.fn(async () => ({ status: 'cancelled' })) };
  recorder = { start: vi.fn(async () => {}), stop: vi.fn(() => new Uint8Array([1, 2, 3])), dispose: vi.fn() };
  player = { load: vi.fn(async () => {}), play: vi.fn(async () => true), dispose: vi.fn() };
  createRecallRecorder.mockReturnValue(recorder); createRecallPlayer.mockReturnValue(player);
  vi.stubGlobal('window', { meetscribe: { recall: api }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
});
afterEach(() => { harnesses.forEach(h => h.unmount()); vi.unstubAllGlobals(); });

describe('Recall choices, privacy and form mapping', () => {
  it('maps every persisted Recall field independently, retaining false and disabled shortcut', () => {
    const config = { ...RECALL_DEFAULTS, recallShortcut: '', recallMuted: false, llmModels: { groq: 'meeting-only' } };
    const form = recallFormFromConfig(config);
    expect(Object.keys(form)).toEqual(Object.keys(RECALL_DEFAULTS));
    expect(form.recallShortcut).toBe(''); expect(form.recallMuted).toBe(false);
    form.recallLlmModels.groq = 'changed'; expect(config.recallLlmModels.groq).toBe('openai/gpt-oss-120b');
  });
  it('keeps UI speech choices exactly compatible with actual main transport validation', () => {
    const speech = require('../electron/providers/speech/gnani');
    for (const [model, voices] of Object.entries(RECALL_VOICES)) for (const voice of voices) for (const language of RECALL_TTS_LANGUAGES) {
      expect(() => speech.validateTtsOptions({ text: 'test', model, voice, language })).not.toThrow();
    }
    expect(validRecallShortcut('Ctrl+Space')).toBe(true);
    expect(validRecallShortcut('Ctrl+Foo')).toBe(false);
  });
  it('constructs separate allowlisted unsaved STT, TTS and LLM test payloads', () => {
    const form = { ...RECALL_DEFAULTS, recallGnaniApiKey: 'unsaved-gnani', groqApiKey: 'unsaved-groq', geminiApiKey: 'do-not-send', llmProvider: 'gemini' };
    expect(recallTestValues('stt', form)).toEqual({ recallGnaniApiKey: 'unsaved-gnani', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN' });
    expect(Object.keys(recallTestValues('tts', form))).toEqual(['recallGnaniApiKey', 'recallTtsModel', 'recallTtsVoice', 'recallTtsLanguage']);
    expect(recallTestValues('llm', form, providers.llm.find(p => p.id === 'groq'))).toEqual({ recallLlmProvider: 'groq', recallLlmModels: { groq: 'openai/gpt-oss-120b' }, groqApiKey: 'unsaved-groq' });
  });
});

describe('actual Settings save/discard/navigation handlers', () => {
  async function settings() {
    const stored = { ...structuredClone(RECALL_DEFAULTS), recallShortcut: '', recallMuted: false,
      recallTtsModel: 'timbre-v2.5', recallTtsVoice: 'Nalini', recallTtsLanguage: 'hi-IN',
      recallLlmProvider: 'claude', recallLlmModels: { claude: 'custom-answer' }, recallContextBudget: 8000,
      sttService: 'google', sttModels: { google: 'meeting-stt' }, llmProvider: 'gemini',
      llmModels: { gemini: 'meeting-notes' }, llmFallback: { provider: 'groq', model: 'meeting-fallback' } };
    window.meetscribe.config = { get: vi.fn(async () => structuredClone(stored)) };
    const onSave = vi.fn(async form => Object.assign(stored, structuredClone(form)));
    const h = new Harness(Settings, { onSave }); harnesses.push(h); await h.settle();
    return { h, stored, onSave };
  }
  it('inserts Recall immediately after Notes and retains mounted hidden panels', async () => {
    const { h } = await settings();
    expect(h.named('SegmentedControl').props.options.map(tab => tab.value)).toEqual(['general', 'transcription', 'notes', 'recall', 'integrations', 'system']);
    expect(h.named('MeetingRecallSection').props.form).toMatchObject({ recallTtsVoice: 'Nalini', recallShortcut: '', recallMuted: false });
    expect(h.nodes().filter(node => node.props.role === 'tabpanel')).toHaveLength(6);
    expect(h.named('MeetingRecallSection').props.active).toBe(false);
  });
  it('edits stay dirty with guarded navigation; discard restores all fields without saving', async () => {
    const { h, stored, onSave } = await settings();
    h.named('MeetingRecallSection').props.onChange('recallGnaniApiKey', 'unsaved-key'); h.render();
    expect(onSave).not.toHaveBeenCalled(); expect(h.named('SaveBar').props.dirty).toBe(true);
    const guard = state.app.setNavGuard.mock.calls.at(-1)[0]; await guard();
    expect(state.app.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Discard', cancelLabel: 'Keep editing' }));
    const reset = h.named('MeetingRecallSection').props.resetToken;
    h.named('SaveBar').props.onDiscard(); h.render();
    expect(h.named('MeetingRecallSection').props.form.recallGnaniApiKey).toBe(stored.recallGnaniApiKey);
    expect(h.named('MeetingRecallSection').props.resetToken).toBe(reset + 1);
    expect(state.app.setNavGuard).toHaveBeenLastCalledWith(null); expect(onSave).not.toHaveBeenCalled();
  });
  it('saves all twelve Recall fields through onSave, reloads them, preserves meeting selections', async () => {
    const { h, stored, onSave } = await settings();
    const meeting = { sttService: stored.sttService, sttModels: stored.sttModels, llmProvider: stored.llmProvider, llmModels: stored.llmModels, llmFallback: stored.llmFallback };
    h.named('MeetingRecallSection').props.onChange('recallStartupMode', 'voice'); h.render();
    await h.named('SaveBar').props.onSave(); h.render();
    expect(onSave).toHaveBeenCalledOnce();
    const payload = onSave.mock.calls[0][0];
    for (const key of Object.keys(RECALL_DEFAULTS)) expect(payload).toHaveProperty(key);
    expect(payload).toMatchObject(meeting); expect(h.named('SaveBar').props.dirty).toBe(false);
    h.unmount();
    const reopened = new Harness(Settings, { onSave }); harnesses.push(reopened); await reopened.settle();
    expect(reopened.named('MeetingRecallSection').props.form).toMatchObject({ ...meeting, ...recallFormFromConfig(stored), recallStartupMode: 'voice' });
  });
  it('rejects invalid shortcuts and cross-model voices before onSave', async () => {
    const { h, onSave } = await settings();
    h.named('MeetingRecallSection').props.onChange('recallShortcut', 'Ctrl+Bogus'); h.render();
    await h.named('SaveBar').props.onSave(); expect(onSave).not.toHaveBeenCalled();
    h.named('MeetingRecallSection').props.onChange('recallShortcut', '');
    h.named('MeetingRecallSection').props.onChange('recallTtsVoice', 'Shivani'); h.render();
    await h.named('SaveBar').props.onSave(); expect(onSave).not.toHaveBeenCalled();
    expect(state.app.addToast).toHaveBeenCalledWith(expect.stringContaining('compatible voice'), 'error');
  });
  it('rejects an empty Recall answer model before onSave, retaining unsaved changes', async () => {
    const { h, onSave } = await settings();
    h.named('MeetingRecallSection').props.onChange('recallLlmModels', { claude: '' }); h.render();
    await h.named('SaveBar').props.onSave(); h.render();
    expect(onSave).not.toHaveBeenCalled(); expect(h.named('SaveBar').props.dirty).toBe(true);
    expect(state.app.addToast).toHaveBeenCalledWith(expect.stringContaining('non-empty model ID'), 'error');
  });
  it('a failed save keeps the form dirty and navigation protected', async () => {
    const { h, onSave } = await settings();
    onSave.mockRejectedValueOnce(new Error('Synthetic save failure'));
    h.named('MeetingRecallSection').props.onChange('recallMuted', true); h.render();
    await h.named('SaveBar').props.onSave(); h.render();
    expect(h.named('SaveBar').props.dirty).toBe(true);
    expect(state.app.setNavGuard.mock.calls.at(-1)[0]).toBeTypeOf('function');
  });
});

describe('actual Recall test handlers with mocked IPC and browser audio', () => {
  it('reports saved shortcut conflict/readiness without reserving unsaved edits', async () => {
    api.getState = vi.fn(async () => ({ readiness: { shortcut: 'conflict' } }));
    const h = section(); await h.settle();
    h.find(node => node.props.children?.includes?.('conflict'));
    expect(api.getState).toHaveBeenCalledOnce(); expect(h.props.onChange).not.toHaveBeenCalled();
    h.props.onChange('recallShortcut', 'Ctrl+P'); await h.settle();
    expect(api.getState).toHaveBeenCalledOnce();
    api.getState.mockResolvedValue({ readiness: { shortcut: 'registered' } });
    h.props.savedShortcut = 'Ctrl+P'; await h.settle();
    expect(api.getState).toHaveBeenCalledTimes(2);
    h.find(node => node.props.children?.includes?.('registered'));
    expect(api.testStt).not.toHaveBeenCalled(); expect(api.testTts).not.toHaveBeenCalled(); expect(api.testLlm).not.toHaveBeenCalled();
  });
  it('does not acquire a microphone or test on opening, Voice selection or editing', () => {
    const h = section(); h.props.onChange('recallStartupMode', 'voice'); h.render();
    h.props.onChange('recallShortcut', 'Ctrl+Space'); h.render();
    expect(createRecallRecorder).not.toHaveBeenCalled(); expect(api.testStt).not.toHaveBeenCalled();
    expect(api.testTts).not.toHaveBeenCalled(); expect(api.testLlm).not.toHaveBeenCalled();
    expect(h.props.onChange.mock.calls.every(([key]) => key.startsWith('recall'))).toBe(true);
  });
  it('Start/Stop sends the captured clip and unsaved Prisma hints, never a fabricated test', async () => {
    api.testStt.mockImplementation(async request => ({ requestId: request.requestId, test: 'stt', status: 'complete', verified: true, transcript: 'synthetic mocked response' }));
    const h = section({ recallGnaniApiKey: 'unsaved-gnani' });
    await h.label('Start microphone STT test').props.onClick(); h.render();
    expect(api.testStt).not.toHaveBeenCalled(); expect(recorder.start).toHaveBeenCalledOnce();
    h.text('Stop and test STT').props.onClick(); await h.settle();
    expect(api.testStt).toHaveBeenCalledWith({ requestId: expect.any(String), values: { recallGnaniApiKey: 'unsaved-gnani', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN' }, audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' });
    expect(result(h, 'stt')).toEqual({ success: true });
    expect(api.testTts).not.toHaveBeenCalled(); expect(api.testLlm).not.toHaveBeenCalled();
  });
  it('a TTS network success waits for explicit Play after autoplay rejection and ends truthfully', async () => {
    api.testTts.mockImplementation(async request => ({ requestId: request.requestId, test: 'tts', status: 'complete', verified: true, audio: new Uint8Array([3]) }));
    player.play.mockResolvedValueOnce(false);
    const h = section({ recallGnaniApiKey: 'unsaved', recallTtsLanguage: 'hi-en' });
    await h.label('Test Gnani TTS').props.onClick(); h.render();
    expect(api.testTts.mock.calls[0][0].values).toEqual({ recallGnaniApiKey: 'unsaved', recallTtsModel: 'timbre-v3.0', recallTtsVoice: 'Shivani', recallTtsLanguage: 'hi-en' });
    expect(result(h, 'tts')).toEqual({ success: true }); expect(player.load).toHaveBeenCalledWith(new Uint8Array([3]));
    h.text('Automatic playback was blocked. Press Play to try with a user gesture.');
    await h.text('Play test audio').props.onClick(); h.render();
    h.text('Playback started; audibility has not been confirmed.');
    createRecallPlayer.mock.calls[0][0].onEnded(); h.render();
    h.find(node => node.props.successLabel === 'Playback completed; confirm you heard the test');
  });
  it('preserves network success when local TTS decoding fails', async () => {
    api.testTts.mockImplementation(async request => ({ requestId: request.requestId, test: 'tts', status: 'complete', verified: true, audio: new Uint8Array([3]) }));
    player.load.mockRejectedValueOnce(new Error('Decode failed'));
    const h = section(); await h.label('Test Gnani TTS').props.onClick(); h.render();
    expect(result(h, 'tts')).toEqual({ success: true });
    h.find(node => node.props.result?.error === 'Network succeeded; local audio decode/playback failed.');
  });
  it('the independent LLM test uses only selected unsaved provider/model/credentials', async () => {
    api.testLlm.mockImplementation(async request => ({ requestId: request.requestId, test: 'llm', status: 'complete', verified: true }));
    const h = section({ llmProvider: 'gemini', llmModels: { gemini: 'notes-model' }, geminiApiKey: 'do-not-send' });
    await h.label('Test Recall answering LLM').props.onClick(); h.render();
    expect(api.testLlm.mock.calls[0][0].values).toEqual({ recallLlmProvider: 'groq', recallLlmModels: { groq: 'openai/gpt-oss-120b' }, groqApiKey: 'unsaved-test-key' });
    expect(h.props.onChange).not.toHaveBeenCalled(); expect(api.testStt).not.toHaveBeenCalled();
    expect(result(h, 'llm')).toEqual({ success: true });
  });
  it('provider/model edits use only Recall keys and keep the independent Groq candidate as the picker default', () => {
    const h = section();
    expect(h.named('ModelSelect').props.provider.defaultModel).toBe('openai/gpt-oss-120b');
    h.named('ModelSelect').props.onChange('custom-recall'); h.render();
    expect(h.props.onChange).toHaveBeenCalledWith('recallLlmModels', { groq: 'custom-recall' });
    h.label('Recall answer provider').props.onChange('recallLlmProvider', 'claude'); h.render();
    expect(h.props.onChange.mock.calls.every(([key]) => key.startsWith('recall'))).toBe(true);
    expect(h.props.form.recallLlmProvider).toBe('claude');
  });
  it('separate error/success results never certify a different test; credential edits invalidate old proof', async () => {
    api.testTts.mockImplementation(async request => ({ requestId: request.requestId, status: 'error', error: { message: 'Gnani is unavailable.' } }));
    api.testLlm.mockImplementation(async request => ({ requestId: request.requestId, status: 'complete', verified: true, test: 'llm' }));
    const h = section(); await h.label('Test Gnani TTS').props.onClick(); h.render();
    await h.label('Test Recall answering LLM').props.onClick(); h.render();
    expect(result(h, 'tts')).toEqual({ success: false, error: 'Gnani is unavailable.' });
    expect(result(h, 'llm')).toEqual({ success: true });
    h.props.form = { ...h.props.form, groqApiKey: 'different-unsaved-key' }; await h.settle();
    expect(result(h, 'llm')).toBeFalsy();
  });
  it('ignores a late TTS decode after explicit Cancel and disposes its player', async () => {
    const pending = deferred(); player.load.mockReturnValue(pending.promise);
    api.testTts.mockImplementation(async request => ({ requestId: request.requestId, status: 'complete', verified: true, test: 'tts', audio: new Uint8Array([3]) }));
    const h = section(); const running = h.label('Test Gnani TTS').props.onClick();
    await h.settle(); h.text('Cancel test / stop playback').props.onClick(); h.render();
    pending.resolve(); await running;
    expect(player.dispose).toHaveBeenCalled(); expect(player.play).not.toHaveBeenCalled();
  });
  it.each(['hide', 'discard', 'voice', 'model', 'language', 'key', 'unmount'])('invalidates and cancels pending speech on %s; ignores late results', async reason => {
    const pending = deferred(); api.testTts.mockReturnValue(pending.promise);
    const h = section(); const running = h.label('Test Gnani TTS').props.onClick(); h.render();
    const id = api.testTts.mock.calls[0][0].requestId;
    if (reason === 'hide') h.props.active = false;
    else if (reason === 'discard') h.props.resetToken++;
    else if (reason === 'unmount') h.unmount();
    else h.props.form = { ...h.props.form, [{ voice: 'recallTtsVoice', model: 'recallTtsModel', language: 'recallTtsLanguage', key: 'recallGnaniApiKey' }[reason]]: 'changed' };
    if (reason !== 'unmount') h.render();
    expect(api.cancelTest).toHaveBeenCalledWith({ requestId: expect.any(String), targetRequestId: id });
    pending.resolve({ requestId: id, test: 'tts', status: 'complete', verified: true, audio: new Uint8Array([3]) });
    await running;
    expect(createRecallPlayer).not.toHaveBeenCalled();
    if (reason !== 'unmount') { h.render(); expect(result(h, 'tts')).toBeFalsy(); }
  });
  it('model/voice mismatch is visible and prevents a TTS call without replacing the voice', async () => {
    const h = section({ recallTtsModel: 'timbre-v2.5', recallTtsVoice: 'Shivani' });
    h.text('Choose a compatible voice for this Timbre model before testing or saving.');
    await h.label('Test Gnani TTS').props.onClick(); h.render();
    expect(api.testTts).not.toHaveBeenCalled(); expect(h.props.form.recallTtsVoice).toBe('Shivani');
    expect(result(h, 'tts').success).toBe(false);
  });
  it('stops the owned recording when the hidden panel is left, without submitting', async () => {
    const h = section(); await h.label('Start microphone STT test').props.onClick(); h.render();
    h.props.active = false; h.render();
    expect(recorder.dispose).toHaveBeenCalled(); expect(api.testStt).not.toHaveBeenCalled();
  });
});
