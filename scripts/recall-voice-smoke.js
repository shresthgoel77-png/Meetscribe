// Native offline Voice acceptance. Chromium supplies fake microphone samples; providers are mocked.
// Never reads the saved profile, real credentials or real microphone. No remote traffic is allowed.
if (!process.argv.includes('--isolated') || !process.env.RECALL_SMOKE_DIR) {
  console.log('Recall Voice smoke: NOT_RUN (requires --isolated and a fresh TEMP profile).'); process.exit(2);
}
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert/strict');
const { app, BrowserWindow, screen, session, ipcMain } = require('electron');
if (!app) { console.error('Recall Voice smoke: NOT_RUN (requires Electron GUI mode).'); process.exit(2); }
const profile = path.resolve(process.env.RECALL_SMOKE_DIR);
assert(profile.toLowerCase().startsWith((path.resolve(os.tmpdir()) + path.sep).toLowerCase()) && /^meetscribe-recall-smoke-[a-z0-9-]+$/i.test(path.basename(profile)));
assert(!fs.existsSync(profile), 'Refusing an existing profile.');
fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'recall-smoke-owned.txt'), 'MeetScribe Recall isolated smoke');
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const db = require('../electron/db/sessions');
const { createRecallWindowController } = require('../electron/overlay/recall-window');
const { registerRecallIpc } = require('../electron/services/recall-ipc');
const { validateClip } = require('../electron/providers/speech/gnani');
const { llmRegistry } = require('../electron/providers');
const cfg = { recallLlmProvider: 'groq', recallLlmModels: { groq: 'offline-test-model' }, groqApiKey: 'offline-fixture-only',
  recallGnaniApiKey: 'offline-fixture-only', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN',
  recallTtsModel: 'timbre-v3.0', recallTtsVoice: 'Shivani', recallTtsLanguage: 'auto',
  recallContextBudget: 24000, recallStartupMode: 'voice', recallMuted: false, recallShortcut: '' };
let win, controller, bridge, completed = false, step = 'startup', scenario = 'normal', pendingSignal;
let sttCalls = 0, ttsCalls = 0, retrievalCalls = 0;
const clips = [];
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await wait(50); } throw new Error('Assertion timeout'); }
const read = code => win.webContents.executeJavaScript(code, true);
const click = text => read(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}).click()`);
const hasText = text => read(`document.body.textContent.includes(${JSON.stringify(text)})`);
const idle = () => read(`![...document.querySelectorAll('button')].some(b => b.textContent === 'Cancel' && !b.disabled)`);
const ownedTracksEnded = () => read(`window.testStreams.slice(1).every(s => s.getTracks().every(t => t.readyState === 'ended'))`);
async function start() { await click('Start microphone'); await until(() => hasText('Stop and ask')); }
async function stop() { await until(() => read(`Number(document.querySelector('.recall-capture-duration').textContent.match(/[0-9.]+/)[0]) >= 0.3`)); await click('Stop and ask'); }
function speechWav() {
  const b = Buffer.alloc(44 + 24000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
const watchdog = setTimeout(() => { console.error(`Recall Voice smoke: FAILED (${step}, deadline).`); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  global.fetch = () => { throw new Error('Live network forbidden in isolated smoke'); };
  await db.initialize(); db.createSession({ id: 'voice-fixture', title: 'Voice fixture', status: 'complete' });
  db.updateSession('voice-fixture', { notes: JSON.stringify({ summary: 'Atlas launch is approved.' }) });
  llmRegistry.get('groq').generate = async ({ userPrompt }) => {
    const p = JSON.parse(userPrompt);
    if (!p.evidence) return JSON.stringify({ terms: [] });
    if (p.verificationMode === 'claims') return JSON.stringify({ claims: p.draft.claims.map((_claim, index) => ({ index, supported: true, conflictsHandled: true, languageMatched: true, coverageHonest: true, reason: 'SUPPORTED' })) });
    if (p.draft) return JSON.stringify({ supported: true, conflictsHandled: true, languageMatched: true, coverageHonest: true });
    retrievalCalls++;
    await until(() => hasText('Recognized question'));
    assert(await read(`document.querySelector('.recall-question')?.textContent.includes('Atlas launch?')`));
    await wait(250);
    return JSON.stringify({ status: 'answered', coverage: 'partial', claims: [{ text: 'Atlas launch is approved.',
      unitIds: [p.evidence[0].unitId] }], uncertainty: [] });
  };
  const fetchImpl = async (url, init) => {
    assert(init.signal instanceof AbortSignal);
    if (url.endsWith('/stt/v3')) {
      sttCalls++;
      const audio = new Uint8Array(await init.body.get('audio_file').arrayBuffer()); clips.push(validateClip(audio));
      assert(await ownedTracksEnded(), 'Recall must stop microphone before STT');
      if (scenario === 'cancel-stt') { pendingSignal = init.signal; return new Promise(() => {}); }
      return new Response(JSON.stringify({ success: true, transcript: scenario === 'silence' ? '' : 'Atlas launch?' }), { headers: { 'content-type': 'application/json' } });
    }
    assert(url.endsWith('/tts/inference')); ttsCalls++;
    await until(() => read(`!!document.querySelector('.recall-answer-text') && !!document.querySelector('.recall-source-chip')`));
    assert(await read(`!!document.querySelector('.recall-answer-text') && !!document.querySelector('.recall-source-chip')`), 'Answer and sources must precede TTS');
    assert(await ownedTracksEnded(), 'Recall must stop microphone before playback');
    if (scenario === 'cancel-tts') { pendingSignal = init.signal; return new Promise(() => {}); }
    if (scenario === 'fail-tts') return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(speechWav(), { headers: { 'content-type': 'audio/wav' } });
  };
  bridge = registerRecallIpc({ ipcMain, getMainWindow: () => null, getConfig: () => cfg, llmRegistry, speechDeps: { fetchImpl },
    serviceDeps: { db }, openRecallWindow: () => controller.open(), resizeRecallWindow: (target, width, height) => controller.resize(target, width, height) });
  controller = createRecallWindowController({ BrowserWindow, screen, isDev: false, attachWindow: target => bridge.attachRecallWindow(target), getTheme: () => 'dark' });
  win = controller.open(); await until(() => !win.webContents.isLoading() && hasText('Start microphone'));
  step = 'independent fake-device recording setup';
  await read(`(async () => { window.testStreams = []; window.testMicRequests = []; const originalMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { window.testMicRequests.push(options); const s = await originalMic(options); window.testStreams.push(s); return s; };
    navigator.mediaDevices.getDisplayMedia = () => { throw new Error('Display capture forbidden'); };
    const sentinelStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    window.sentinelChunks = 0; window.sentinelRecorder = new MediaRecorder(sentinelStream);
    window.sentinelRecorder.ondataavailable = () => window.sentinelChunks++; window.sentinelRecorder.start(100); })()`);
  await wait(200); assert.equal(sttCalls, 0); assert.equal(ttsCalls, 0);
  step = 'real microphone/worklet/WAV and text before actual local playback';
  await start(); await stop(); await until(idle);
  await until(() => hasText('Playback completed; audibility depends on your output device'));
  assert(await ownedTracksEnded()); assert(retrievalCalls === 1 && sttCalls === 1 && ttsCalls === 1);
  step = 'mute and actual 25-second cap';
  await read(`document.querySelector('button[aria-label="Mute Recall speech"]').click()`);
  const begun = Date.now(); await start(); await until(idle, 30000);
  assert(Date.now() - begun >= 24000); assert(Date.now() - begun < 29000);
  assert(await hasText('Auto-stopped at the 25-second limit'));
  assert(clips.at(-1).durationSeconds > 23 && clips.at(-1).durationSeconds <= 25); assert.equal(ttsCalls, 1);
  step = 'cancel pending STT and retry'; scenario = 'cancel-stt'; pendingSignal = null;
  await start(); await stop(); await until(() => !!pendingSignal); await click('Cancel'); await until(() => pendingSignal.aborted);
  await wait(150); assert(await ownedTracksEnded());
  step = 'silence is an honest error'; scenario = 'silence'; await start(); await stop(); await until(idle);
  assert(await hasText('No speech was detected'));
  step = 'synthesis failure keeps readable answer'; scenario = 'fail-tts';
  await read(`document.querySelector('button[aria-label="Unmute Recall speech"]').click()`);
  await start(); await stop(); await until(idle); assert(await hasText('delivered answer and sources remain available'));
  assert(await read(`!!document.querySelector('.recall-answer-text') && !!document.querySelector('.recall-source-chip')`));
  step = 'mute aborts pending synthesis'; scenario = 'cancel-tts'; pendingSignal = null;
  await start(); await stop(); await until(() => !!pendingSignal);
  await read(`document.querySelector('button[aria-label="Mute Recall speech"]').click()`);
  await until(() => pendingSignal.aborted); await until(idle);
  assert(await read(`!!document.querySelector('.recall-answer-text') && !document.querySelector('.recall-error')`));
  step = 'independent recording remained active';
  assert(await read(`window.sentinelRecorder.state === 'recording' && window.sentinelChunks > 20 && window.testStreams[0].getTracks().every(t => t.readyState === 'live')`));
  assert(await read(`window.testMicRequests.slice(1).every(o => o.video === false && o.audio.channelCount === 1)`));
  await read(`window.sentinelRecorder.stop(); window.testStreams[0].getTracks().forEach(t => t.stop())`);
  step = 'Voice controls fit both themes and compact/expanded layouts';
  for (const theme of ['light', 'dark']) {
    controller.setTheme(theme); await until(() => read(`document.documentElement.classList.contains('${theme}')`));
    for (const size of [[420, 480], [640, 800], [320, 220]]) {
      controller.resize(win, ...size); await wait(80);
      assert(await read(`document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth + 1`));
      assert(await hasText('even through headphones'));
    }
  }
  step = 'close while listening and reopen idle'; scenario = 'normal';
  await start(); const old = win; old.close(); await until(() => old.isDestroyed()); win = controller.open();
  await until(() => !win.webContents.isLoading() && hasText('Voice is idle until you press Start'));
  assert.equal(await read(`document.querySelectorAll('.recall-answer,.recall-history').length`), 0);
  completed = true;
  console.log(JSON.stringify({ recallVoiceSmoke: 'PASS', microphone: 'native getUserMedia with Chromium fake device; actual AudioWorklet/PCM WAV',
    speech: 'real Gnani adapter with mocked HTTP responses; remote traffic blocked', database: 'real SQLite synthetic TEMP records',
    checks: ['explicit Start/Stop', 'microphone stopped before STT/playback', 'recognized question and cited text precede TTS', 'native WAV decode/play to completion',
      '25-second auto-stop', 'mute skips TTS', 'silence', 'cancel STT', 'TTS failure retains text', 'mute aborts synthesis', 'independent MediaRecorder continues', 'both themes/three sizes', 'close/reopen idle'],
    clipDurations: clips.map(c => Math.round(c.durationSeconds * 100) / 100), sampleRates: [...new Set(clips.map(c => c.sampleRate))],
    pending: ['live Gnani/LLM and human English/Hinglish', 'actual meeting mixed recording/device contention', 'audible output and installer'] }));
}).catch(async error => {
  console.error(`Recall Voice smoke: FAILED (${step}, ${error.name}: ${error.message}).`);
  if (win && !win.isDestroyed()) try { console.log(JSON.stringify({ diagnostics: await read(`({ error: document.querySelector('.recall-error')?.textContent || '', duration: document.querySelector('.recall-capture-duration')?.textContent || '', answers: document.querySelectorAll('.recall-answer').length })`), sttCalls, ttsCalls })); } catch { /* teardown */ }
}).finally(() => { clearTimeout(watchdog); controller?.dispose(); bridge?.dispose(); app.exit(completed ? 0 : 1); });
