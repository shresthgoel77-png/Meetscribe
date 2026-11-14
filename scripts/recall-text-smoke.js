// Offline native acceptance: fresh temporary profile + synthetic SQLite records + mocked LLM.
// Never import the main App/config or use the saved user profile, real accounts or audio.
if (!process.argv.includes('--isolated') || !process.env.RECALL_SMOKE_DIR) {
  console.log('Recall Text smoke: NOT_RUN (requires --isolated and a fresh TEMP profile).'); process.exit(2);
}
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert/strict');
const { app, BrowserWindow, screen, session, ipcMain } = require('electron');
if (!app) { console.error('Recall Text smoke: NOT_RUN (requires Electron GUI mode).'); process.exit(2); }
const profile = path.resolve(process.env.RECALL_SMOKE_DIR);
assert(profile.toLowerCase().startsWith((path.resolve(os.tmpdir()) + path.sep).toLowerCase()) && /^meetscribe-recall-smoke-[a-z0-9-]+$/i.test(path.basename(profile)));
assert(!fs.existsSync(profile), 'Refusing an existing profile.');
fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'recall-smoke-owned.txt'), 'MeetScribe Recall isolated smoke');
app.setPath('userData', profile); app.setPath('sessionData', profile);
const db = require('../electron/db/sessions');
const { createRecallWindowController } = require('../electron/overlay/recall-window');
const { registerRecallIpc } = require('../electron/services/recall-ipc');
const { createRecallService } = require('../electron/services/recall');
const { llmRegistry } = require('../electron/providers');
const cfg = { recallLlmProvider: 'groq', recallLlmModels: { groq: 'offline-test-model' }, groqApiKey: 'offline-fixture-only',
  recallContextBudget: 24000, recallStartupMode: 'text', recallMuted: false, recallShortcut: '' };
let win, controller, bridge, completed = false, step = 'startup', delayedSignal;
const asks = [], intents = [];
let scans = 0;
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await wait(40); } throw new Error('Assertion timeout'); }
const read = code => {
  let timer;
  return Promise.race([win.webContents.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer read timed out')), 2000); })])
    .finally(() => clearTimeout(timer));
};
async function type(text) { await read('document.querySelector("textarea").focus(); document.querySelector("textarea").select()'); await win.webContents.insertText(text); }
const enter = modifiers => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: modifiers || [] });
  if (modifiers?.includes('shift')) win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: modifiers || [] });
};
async function ask(text) { await type(text); enter(); await until(() => read('!!document.querySelector(".recall-answer") && document.querySelector("button[type=submit]").disabled === true && ![...document.querySelectorAll("button")].some(b => b.textContent === "Cancel" && !b.disabled)')); }
function save(id, summary, title) {
  db.createSession({ id, title, status: 'complete', started_at: '2026-11-09T03:00:00Z' });
  db.updateSession(id, { notes: JSON.stringify({ summary }) });
}
const watchdog = setTimeout(() => { console.error(`Recall Text smoke: FAILED (${step}, deadline).`); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  global.fetch = () => { throw new Error('Live network forbidden in isolated smoke'); };
  await db.initialize();
  llmRegistry.get('groq').generate = async ({ userPrompt, signal }) => {
    const payload = JSON.parse(userPrompt);
    if (!payload.evidence) return JSON.stringify({ terms: [] });
    if (payload.verificationMode === 'claims') return JSON.stringify({ claims: payload.draft.claims.map((_claim, index) => ({ index, supported: true, conflictsHandled: true, languageMatched: true, coverageHonest: true, reason: 'SUPPORTED' })) });
    if (payload.draft) return JSON.stringify({ supported: true, conflictsHandled: true, languageMatched: true, coverageHonest: true });
    if (payload.question.includes('delay')) {
      delayedSignal = signal;
      return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('Cancelled fixture')), { once: true }); });
    }
    const chosen = payload.evidence.filter(item => /Atlas launch is (?:not )?approved\./.test(item.text)).slice(0, 2);
    return JSON.stringify({ status: chosen.length ? 'answered' : 'insufficient_evidence', coverage: chosen.length ? 'partial' : 'insufficient',
      claims: chosen.map(item => ({ text: item.text.match(/Atlas launch is (?:not )?approved\./)[0], unitIds: [item.unitId] })),
      uncertainty: chosen.length > 1 ? ['conflicting_evidence'] : [] });
  };
  bridge = registerRecallIpc({ ipcMain, getMainWindow: () => null, getConfig: () => cfg, llmRegistry,
    serviceDeps: { db: { listSessions: () => { scans++; return db.listSessions(); }, getSession: db.getSession } },
    createService: deps => { const service = createRecallService(deps), ask = service.ask; service.ask = request => { asks.push(request.requestId); return ask(request); }; return service; },
    openRecallWindow: () => controller.open(), resizeRecallWindow: (target, width, height) => controller.resize(target, width, height),
    openSource: evidence => { assert(db.getSession(evidence.sessionId)); intents.push(evidence.sessionId); return true; } });
  controller = createRecallWindowController({ BrowserWindow, screen, isDev: false, attachWindow: target => bridge.attachRecallWindow(target), getTheme: () => 'dark' });
  win = controller.open();
  step = 'real Text composer and empty SQLite library';
  await until(() => !win.webContents.isLoading() && read('!!document.querySelector("textarea") && document.querySelector("textarea") === document.activeElement'));
  await ask('Atlas launch?');
  assert(await read('document.querySelector(".recall-answer").textContent.includes("No eligible saved content")'));
  save('fixture-approved', 'Atlas launch is approved. ' + 'Saved contextual detail. '.repeat(60), 'Approved fixture ' + 'long title '.repeat(16));
  save('fixture-rejected', 'Atlas launch is not approved.', 'Conflicting fixture');
  db.createSession({ id: 'unfinished', title: 'Ineligible fixture', status: 'generating' });
  step = 'Shift+Enter, real typing and conflicting cited retrieval';
  await type('Atlas'); const before = asks.length; enter(['shift']); await wait(100);
  assert.equal(asks.length, before); assert((await read('document.querySelector("textarea").value')).includes('\n'));
  await win.webContents.insertText('launch?'); enter();
  await until(() => read('document.querySelectorAll(".recall-source-chip").length === 2'));
  assert(await read('document.querySelector(".recall-answer").textContent.includes("Saved sources disagree")'));
  assert(await read('document.querySelector(".recall-answer-text").textContent.includes("not approved")'));
  step = 'keyboard evidence expansion';
  await read('document.querySelector(".recall-source summary").focus()');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await until(() => read('document.querySelector(".recall-source details").open'));
  assert(await read('document.querySelector("blockquote").textContent.includes("Atlas launch")'));
  step = 'correct source intent';
  const chipTitle = await read('document.querySelector(".recall-source-chip > span").textContent');
  await read('document.querySelector(".recall-source-chip").click()'); await until(() => intents.length === 1);
  assert(['fixture-approved', 'fixture-rejected'].includes(intents[0]));
  assert.equal(db.getSession(intents[0]).title.trim(), chipTitle);
  await until(() => read('!document.querySelector(".recall-source-chip").disabled'));
  step = 'source deletion';
  db.deleteSession(intents[0]); await read('document.querySelector(".recall-source-chip").click()');
  await until(() => read('document.querySelector(".recall-answer").textContent.includes("sources need fresh retrieval")'));
  assert.equal(await read('document.querySelectorAll(".recall-source-chip").length'), 0);
  assert(await read('!!document.querySelector(".recall-answer-text").textContent'));
  step = 'no matching evidence';
  await ask('Zephyr catering arrangements?');
  assert(await read('document.querySelector(".recall-answer").textContent.includes("No matching saved passages")'));
  step = 'cancellation and rapid submissions';
  await type('Atlas launch delay?'); enter(); await until(() => !!delayedSignal);
  await read('[...document.querySelectorAll("button")].find(b => b.textContent === "Cancel").click()');
  await until(() => delayedSignal.aborted);
  assert.equal(delayedSignal.aborted, true); assert.equal(await read('document.querySelector("textarea").value'), 'Atlas launch delay?');
  await type('Atlas launch?'); const count = asks.length; enter();
  await read('document.querySelector("button[type=submit]").click()'); await until(() => asks.length === count + 1);
  await until(() => read('!!document.querySelector(".recall-answer")'));
  assert.equal(asks.length, count + 1); assert.equal(new Set(asks).size, asks.length); assert(scans >= 5);
  step = 'idle Voice, mute and both theme layouts';
  await read('[...document.querySelectorAll("button")].find(b => b.textContent === "Voice").click()');
  await until(() => read('!!document.querySelector(".recall-voice-controls")'));
  assert(await read('document.querySelector(".recall-voice-controls").textContent.includes("idle until you press Start")'));
  await read(`document.querySelector('button[aria-label="Mute Recall speech"]').click()`);
  assert(await read(`!!document.querySelector('button[aria-label="Unmute Recall speech"]')`));
  await read('[...document.querySelectorAll("button")].find(b => b.textContent === "Text").click()');
  await read(`document.querySelector('button[aria-label="Expand Recall window"]').click()`);
  await until(() => read(`!!document.querySelector('button[aria-label="Compact Recall window"]')`));
  await read(`document.querySelector('button[aria-label="Compact Recall window"]').click()`);
  await until(() => read(`!!document.querySelector('button[aria-label="Expand Recall window"]')`));
  for (const theme of ['light', 'dark']) {
    controller.setTheme(theme); await until(() => read(`document.documentElement.classList.contains('${theme}')`));
    for (const size of [[420, 480], [640, 800], [320, 220]]) {
      controller.resize(win, ...size); await wait(80);
      assert(await read('document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth + 1'));
      assert(await read('getComputedStyle(document.querySelector(".recall-answer-text")).webkitLineClamp === "none"'));
    }
  }
  step = 'destroy/reopen clears display and follow-up RAM';
  const previous = win; previous.close(); await until(() => previous.isDestroyed()); win = controller.open();
  await until(() => !win.webContents.isLoading() && read('!!document.querySelector("textarea")'));
  assert.equal(await read('document.querySelector("textarea").value'), '');
  assert.equal(await read('document.querySelectorAll(".recall-answer,.recall-history").length'), 0);
  const reopened = await read('window.meetscribeRecall.getState({ requestId: crypto.randomUUID() })');
  assert.equal(reopened.historyTurns, 0);
  completed = true;
  console.log(JSON.stringify({ recallTextSmoke: 'PASS', database: 'real SQLite, synthetic TEMP-only records', llm: 'mocked generation/audit; remote traffic blocked',
    checks: ['real typed keyboard questions', 'empty/no-match', 'fresh retrieval/conflicting cited answers', 'evidence expansion', 'validated record navigation intent', 'source deletion', 'Cancel/retained input', 'rapid duplicate suppression', 'idle Voice/mute', 'both themes/three sizes', 'close/reopen clears RAM'],
    pending: ['real saved profile/meeting viewer navigation dialog', 'live LLM quality/access', 'audio and installer'] }));
}).catch(async () => {
  console.error(`Recall Text smoke: FAILED (${step}).`);
  console.log(JSON.stringify({ windowCreated: !!win, destroyed: win?.isDestroyed(), asks: asks.length, intents: intents.length }));
  if (win && !win.isDestroyed()) {
    try { console.log(JSON.stringify({ diagnostics: await read(`({ error: document.querySelector('.recall-error')?.textContent || '', sources: document.querySelectorAll('.recall-source-chip').length, answers: document.querySelectorAll('.recall-answer').length, hasLineBreak: document.querySelector('textarea')?.value.includes('\\n') || false })`), asks: asks.length })); } catch { /* teardown */ }
  }
}).finally(() => {
  clearTimeout(watchdog); controller?.dispose(); bridge?.dispose(); app.exit(completed ? 0 : 1);
});
