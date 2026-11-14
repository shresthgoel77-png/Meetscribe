// Explicit isolated desktop check. Does NOT import main.js/config/db or contact providers.
// Run with the installed Electron binary, --isolated, and a fresh RECALL_SMOKE_DIR under TEMP.
if (!process.argv.includes('--isolated') || !process.env.RECALL_SMOKE_DIR) {
  console.log('Recall desktop smoke: NOT_RUN (requires --isolated and a fresh temporary profile).');
  process.exit(2);
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { app, BrowserWindow, screen, ipcMain, session } = require('electron');
if (!app) { console.error('Recall desktop smoke: NOT_RUN (Electron GUI mode is required).'); process.exit(2); }
const profile = path.resolve(process.env.RECALL_SMOKE_DIR);
const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
assert(profile.toLowerCase().startsWith(temporaryRoot.toLowerCase()) && /^meetscribe-recall-smoke-[a-z0-9-]+$/i.test(path.basename(profile)), 'Use a fresh Recall smoke folder inside TEMP.');
assert(!fs.existsSync(profile), 'Refusing to touch an existing profile.');
fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'recall-smoke-owned.txt'), 'MeetScribe Recall isolated smoke');
app.setPath('userData', profile); app.setPath('sessionData', profile);
const { createRecallWindowController } = require('../electron/overlay/recall-window');
const { registerRecallIpc } = require('../electron/services/recall-ipc');
const { llmRegistry } = require('../electron/providers');
const overlay = require('../electron/overlay/overlay-window');
let controller, bridge, activeSignal;
let step = 'startup';
let completed = false;
// Match the product's tray-style lifecycle: closing the last test window must not terminate
// the harness before reopen/crash/overlay assertions execute.
app.on('window-all-closed', () => {});
const answers = [];
let overlayState = { mode: 'hidden' };
const ownedOverlayHandlers = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(50); }
  throw new Error('Isolated desktop assertion timed out.');
}
const read = (win, code) => win.webContents.executeJavaScript(code);
const watchdog = setTimeout(() => { console.error('Recall desktop smoke: FAILED (deadline).'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  // Deny all remote traffic even if a renderer asset unexpectedly tries to fetch it.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const service = {
    ask: request => { activeSignal = request.signal; return new Promise(resolve => answers.push(() => resolve({ requestId: request.requestId, status: 'insufficient_evidence', text: '', sources: [], claims: [] }))); },
    close: () => {}, cancel: () => {}, getState: () => ({ historyTurns: 0, historyBytes: 0 }),
  };
  bridge = registerRecallIpc({ ipcMain, getMainWindow: () => null, getOverlayWindow: overlay.getOverlayWindow,
    getConfig: () => ({}), llmRegistry, createService: () => service,
    openRecallWindow: () => controller.open(), resizeRecallWindow: (win, width, height) => controller.resize(win, width, height),
    getShortcutState: () => 'unregistered' });
  controller = createRecallWindowController({ BrowserWindow, screen, isDev: false,
    attachWindow: win => bridge.attachRecallWindow(win), getTheme: () => 'dark' });
  let win = controller.open();
  step = 'packaged HTML/preload load';
  await until(async () => !win.webContents.isLoading() && await read(win, '!!document.querySelector("main")'));
  step = 'sandboxed capabilities';
  const capabilities = await read(win, 'Object.keys(window.meetscribeRecall).sort()');
  assert.deepEqual(capabilities, ['cancel', 'close', 'getState', 'onAnswer', 'onAudio', 'onError', 'onStage', 'onTheme', 'open', 'openSource', 'resize', 'setMuted', 'startupTheme', 'submitAudio', 'submitText'].sort());
  assert.equal(await read(win, 'typeof window.meetscribe'), 'undefined');
  assert.equal(await read(win, 'typeof require'), 'undefined');
  assert.equal(await read(win, 'document.documentElement.classList.contains("dark")'), true);
  assert.equal(controller.open(), win);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  controller.setTheme('light');
  step = 'theme propagation before React subscription';
  await until(() => read(win, 'document.documentElement.classList.contains("light")'));
  step = 'display geometry';
  controller.resize(win, 640, 800);
  const area = screen.getDisplayMatching(win.getBounds()).workArea, bounds = win.getBounds();
  console.log(JSON.stringify({ geometry: { area, bounds, contentBounds: win.getContentBounds() } }));
  assert(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
  // Actual sandboxed preload -> actual IPC -> injected non-network pending answering service.
  step = 'IPC and X cancellation';
  await read(win, 'window.meetscribeRecall.submitText({ requestId: crypto.randomUUID(), question: "Synthetic local lifecycle check" })');
  await until(() => !!activeSignal); assert.equal(activeSignal.aborted, false);
  await read(win, `document.querySelector('button[aria-label="Close Meeting Recall"]').click()`);
  await until(() => win.isDestroyed()); assert.equal(activeSignal.aborted, true);
  answers.splice(0).forEach(resolve => resolve());
  win = controller.open();
  step = 'Escape and reopen';
  await until(async () => !win.webContents.isLoading() && await read(win, '!!document.querySelector("main")'));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until(() => win.isDestroyed());
  win = controller.open();
  await until(async () => !win.webContents.isLoading() && await read(win, '!!document.querySelector("main")'));
  win.webContents.forcefullyCrashRenderer();
  step = 'crash and reopen';
  await until(() => win.isDestroyed());
  win = controller.open();
  await until(async () => !win.webContents.isLoading() && await read(win, '!!document.querySelector("main")'));
  // Exercise real overlay layout with synthetic mode state, never real recording services.
  const handle = (channel, callback) => { ipcMain.handle(channel, callback); ownedOverlayHandlers.push(channel); };
  handle('overlay:get-state', () => overlayState);
  ipcMain.on('overlay:resize', (_event, height) => overlay.resizeOverlay(height));
  ipcMain.on('overlay:move', (_event, delta) => overlay.moveOverlay(delta));
  ipcMain.on('overlay:closed', () => overlay.overlayClosed());
  for (const mode of ['prompt', 'recording', 'ended', 'processing', 'complete', 'error']) {
    step = `overlay layout: ${mode}`;
    overlayState = { mode, meeting: { title: 'Synthetic layout fixture' }, sessionId: randomUUID(), startedAt: Date.now(), percent: 50 };
    overlay.showOverlay(overlayState, { theme: 'light' });
    const bar = overlay.getOverlayWindow();
    await until(async () => !bar.webContents.isLoading() && await read(bar, '!!document.querySelector(".overlay-row")'));
    await wait(800);
    const layout = await read(bar, `(() => {
      const row = document.querySelector('.overlay-row').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label') || button.textContent.trim(), left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right }));
      return { right: row.right, left: row.left, buttons };
    })()`);
    assert.equal(layout.buttons.filter(button => button.label === 'Open Meeting Recall').length, 1);
    assert(layout.buttons.every(button => button.left >= layout.left && button.right <= layout.right + 1));
    for (let i = 1; i < layout.buttons.length; i++) assert(layout.buttons[i].left >= layout.buttons[i - 1].right);
    assert.equal(bar.isFocusable(), false);
    // Opening via the real overlay bridge must focus the same Recall instance, never toggle it.
    await read(bar, 'window.meetscribeOverlay.openRecall({ requestId: crypto.randomUUID() })');
    assert.equal(controller.getWindow(), win);
  }
  completed = true;
  console.log(JSON.stringify({ recallDesktopSmoke: 'PASS', profile: 'isolated temporary directory', providers: 'mocked; remote traffic blocked',
    checks: ['packaged-layout HTML/preload loaded', 'sandboxed named bridge', 'singleton', 'theme propagation', 'display clamp', 'X cancellation', 'Escape/reopen', 'crash/reopen', 'six real overlay mode layouts and open-only bridge'],
    pending: ['physical global-hotkey/focus behavior', 'real tray/main app integration', 'physical multi-monitor/scaling changes', 'live APIs/audio', 'installer'] }));
}).catch(() => {
  // No stacks, renderer data, questions or provider responses in the diagnostic output.
  console.error(`Recall desktop smoke: FAILED (${step}).`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(watchdog);
  controller?.dispose(); bridge?.dispose(); overlay.destroyOverlay();
  for (const channel of ownedOverlayHandlers) ipcMain.removeHandler(channel);
  app.exit(completed ? 0 : 1);
});
