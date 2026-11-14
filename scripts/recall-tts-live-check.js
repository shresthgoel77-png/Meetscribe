// Explicit live acceptance only: neutral TTS via the Settings handler, real local player.
// Reads saved credentials in main memory. Never initializes the user DB/config or records audio.
if (!process.argv.includes('--live') || !process.argv.includes('--isolated') || !process.env.RECALL_SMOKE_DIR) {
  console.log('Recall TTS live check: NOT_RUN (requires --live --isolated and a fresh TEMP profile).'); process.exit(2);
}
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { app, BrowserWindow, ipcMain } = require('electron');
assert(app, 'Electron GUI mode is required.');
const profile = path.resolve(process.env.RECALL_SMOKE_DIR);
assert(profile.toLowerCase().startsWith((path.resolve(os.tmpdir()) + path.sep).toLowerCase()) && /^meetscribe-recall-smoke-[a-z0-9-]+$/i.test(path.basename(profile)));
assert(!fs.existsSync(profile)); fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'recall-smoke-owned.txt'), 'MeetScribe Recall isolated smoke');
app.setPath('userData', profile); app.setPath('sessionData', profile);
const { registerRecallIpc, CHANNELS } = require('../electron/services/recall-ipc');
let win, bridge, passed = false;
const timer = setTimeout(() => { console.log(JSON.stringify({ liveTts: 'FAIL', stage: 'deadline' })); app.exit(1); }, 45000);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'NovaMeet', 'novameet-config.json'), 'utf8'));
  const handlers = new Map();
  const metadata = [];
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    metadata.push({ status: response.status, contentType: (response.headers.get('content-type') || '').split(';')[0] }); return response;
  };
  win = new BrowserWindow({ width: 420, height: 480, show: false, webPreferences: {
    preload: path.join(__dirname, '../electron/recall-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  bridge = registerRecallIpc({ ipcMain: { handle: (name, fn) => { handlers.set(name, fn); ipcMain.handle(name, fn); },
    removeHandler: name => { handlers.delete(name); ipcMain.removeHandler(name); } },
    getMainWindow: () => win, getConfig: () => ({ ...cfg, recallStartupMode: 'text' }), speechDeps: { fetchImpl },
    serviceDeps: { db: { listSessions: () => [], getSession: () => null } } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  await win.loadFile(path.join(__dirname, '../dist/renderer/recall.html'));
  const requestId = randomUUID();
  const values = Object.fromEntries(['recallGnaniApiKey', 'recallTtsModel', 'recallTtsVoice', 'recallTtsLanguage'].map(key => [key, cfg[key]]));
  const reply = await handlers.get(CHANNELS.testTts)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, {
    requestId, values, text: 'This is a Meeting Recall speech test.',
  });
  if (reply.status !== 'complete') {
    console.log(JSON.stringify({ requestId, liveTts: 'FAIL', stage: reply.stage, code: reply.error?.code,
      speechCode: reply.error?.speechCode, httpStatus: reply.error?.httpStatus, metadata })); return;
  }
  assert(reply.audio.byteLength < 1024 * 1024, 'Neutral test exceeded its playback bound.');
  const audioAsset = fs.readdirSync(path.join(__dirname, '../dist/renderer/assets')).find(name => name.startsWith('recallAudio-') && name.endsWith('.js'));
  assert(audioAsset);
  // Only validated non-secret audio crosses into this isolated renderer; never credentials.
  const playback = await win.webContents.executeJavaScript(`(async () => {
    navigator.mediaDevices.getUserMedia = () => { throw new Error('No recording allowed'); };
    navigator.mediaDevices.getDisplayMedia = () => { throw new Error('No display capture allowed'); };
    const module = await import('./assets/${audioAsset}');
    const factory = Object.values(module).find(value => typeof value === 'function' && value.toString().includes('decodeAudioData'));
    if (!factory) return { stage: 'player-import', status: 'failed' };
    let ended; const completion = new Promise(resolve => { ended = resolve; });
    class QuietContext extends AudioContext {
      createBufferSource() {
        const source = super.createBufferSource(), gain = this.createGain(); gain.gain.value = 0; gain.connect(this.destination);
        const connect = source.connect.bind(source); source.connect = () => connect(gain); return source;
      }
    }
    const player = factory({ onEnded: () => ended('complete'), AudioContextClass: ${process.argv.includes('--audible') ? 'AudioContext' : 'QuietContext'} });
    try {
      await player.load(new Uint8Array(${JSON.stringify([...reply.audio])}));
      if (!await player.play()) return { stage: 'playback', status: 'blocked', decoded: true };
      let timeout; const status = await Promise.race([completion, new Promise(resolve => { timeout = setTimeout(() => resolve('timeout'), 12000); })]);
      clearTimeout(timeout); return { stage: 'playback', status, decoded: true };
    } catch (error) { return { stage: 'local-audio', status: 'failed', code: error.code || 'LOCAL_AUDIO_ERROR' }; }
    finally { player.dispose(); }
  })()`, true);
  passed = playback.status === 'complete';
  console.log(JSON.stringify({ requestId, liveTts: passed ? 'PASS' : 'PENDING', metadata, validatedWav: true,
    sampleRate: reply.sampleRate, playback, output: process.argv.includes('--audible') ? 'audible requested' : 'zero-gain validation', physicalAudibility: 'not independently observed' }));
}).catch(error => { console.log(JSON.stringify({ liveTts: 'FAIL', stage: 'harness', error: error.name })); })
  .finally(() => { clearTimeout(timer); bridge?.dispose(); if (win && !win.isDestroyed()) win.destroy(); app.exit(passed ? 0 : 1); });
