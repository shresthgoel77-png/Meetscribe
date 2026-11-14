// Explicit acceptance only. Saved DB/config are read as bytes; never initialized or written.
if (!process.argv.includes('--live') || !process.argv.includes('--isolated') || !process.env.RECALL_SMOKE_DIR || !process.env.RECALL_LIVE_QUESTIONS) process.exit(2);
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const { createRecallWindowController } = require('../electron/overlay/recall-window');
const { registerRecallIpc } = require('../electron/services/recall-ipc');
const { createRecallService } = require('../electron/services/recall');
const { llmRegistry } = require('../electron/providers');
const profile = path.resolve(process.env.RECALL_SMOKE_DIR);
assert(profile.toLowerCase().startsWith((path.resolve(os.tmpdir()) + path.sep).toLowerCase()) && /^meetscribe-recall-smoke-[a-z0-9-]+$/i.test(path.basename(profile)));
assert(!fs.existsSync(profile)); fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'recall-smoke-owned.txt'), 'MeetScribe Recall isolated smoke');
app.setPath('userData', profile); app.setPath('sessionData', profile);
const questions = JSON.parse(process.env.RECALL_LIVE_QUESTIONS); delete process.env.RECALL_LIVE_QUESTIONS;
let controller, bridge, win, result, passed = true, sourceOpens = 0, requestId, step = 'setup', trace = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = code => win.webContents.executeJavaScript(code, true);
async function until(fn, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(50); } throw new Error('DEADLINE'); }
const timer = setTimeout(() => { console.log(JSON.stringify({ liveText: 'FAIL', stage: 'deadline' })); app.exit(1); }, 480000);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const base = path.join(app.getPath('appData'), 'NovaMeet');
  const cfgPath = path.join(base, 'novameet-config.json'), dbPath = path.join(base, 'novameet.db');
  const cfgBytes = fs.readFileSync(cfgPath), dbBytes = fs.readFileSync(dbPath);
  const cfg = JSON.parse(cfgBytes);
  const SQL = await require('sql.js')(); const sql = new SQL.Database(dbBytes);
  const table = sql.exec('SELECT * FROM sessions ORDER BY started_at DESC')[0];
  const rows = table.values.map(values => Object.fromEntries(table.columns.map((key, i) => [key, values[i]])));
  let selectedRows = rows;
  const db = { listSessions: () => structuredClone(selectedRows), getSession: id => structuredClone(selectedRows.find(row => row.id === id) || null) };
  const provider = llmRegistry.get(cfg.recallLlmProvider), original = provider.generate;
  provider.generate = async (args, deps) => {
    const payload = JSON.parse(args.userPrompt), stage = payload.verificationMode === 'claims' ? 'claim_verification' : payload.draft ? 'verification' : payload.evidence ? 'generation' : 'expansion';
    const start = Date.now();
    try {
      const raw = await original(args, deps); let value; try { value = JSON.parse(raw); } catch { /* sanitized below */ }
      let validationCode;
      if (stage === 'generation' && Array.isArray(value?.claims) && value.claims.some(c => c && Object.hasOwn(c, 'unitIds'))) validationCode = 'UNIT_REFERENCES';
      trace.push({ stage, ms: Date.now() - start, code: value ? 'JSON' : 'MALFORMED_JSON',
        validationCode,
        passages: payload.evidence?.length, retrieved: payload.evidence ? new Set(payload.evidence.map(e => e.sessionId)).size : undefined,
        claims: Array.isArray(value?.claims) ? value.claims.length : undefined, draftStatus: ['answered', 'insufficient_evidence'].includes(value?.status) ? value.status : undefined,
        coverage: ['sufficient', 'partial', 'insufficient'].includes(value?.coverage) ? value.coverage : undefined,
        allVerified: stage === 'verification' ? Object.values(value || {}).every(v => v === true) : undefined,
        verification: stage === 'verification' && value ? Object.fromEntries(['supported', 'conflictsHandled', 'languageMatched', 'coverageHonest'].map(k => [k, value[k] === true])) : undefined,
        claimLengths: value?.claims?.map(c => typeof c.text === 'string' ? c.text.length : -1),
        claimChecks: stage === 'claim_verification' && Array.isArray(value?.claims) ? value.claims.map(c => ({ index: Number.isInteger(c?.index) ? c.index : -1, supported: c?.supported === true, conflictsHandled: c?.conflictsHandled === true,
          languageMatched: c?.languageMatched === true, coverageHonest: c?.coverageHonest === true, reason: ['SUPPORTED', 'UNSUPPORTED_ASSERTION', 'METRIC_CONFLATION', 'CONDITION_OMITTED', 'IDENTITY_MISMATCH', 'COVERAGE_OVERREACH', 'LANGUAGE_MISMATCH', 'CONFLICT_OMITTED', 'IRRELEVANT'].includes(c?.reason) ? c.reason : 'INVALID_CODE' })) : undefined,
        exactQuotes: value?.claims?.every(c => c.citations?.every(cite => payload.evidence?.some(e => e.evidenceId === cite.evidenceId && e.text.includes(cite.quote)))),
        claimDiagnostics: stage === 'generation' ? value?.claims?.map((claim, index) => ({ index,
          keysValid: Object.keys(claim).sort().join(',') === 'citations,evidenceIds,text',
          textCharacters: claim.text?.length, textWords: typeof claim.text === 'string' ? claim.text.trim().split(/\s+/).length : 0,
          embeddedEvidenceId: /E[0-9a-f]{24}/.test(claim.text), references: claim.evidenceIds?.length,
          distinctReferences: Array.isArray(claim.evidenceIds) ? new Set(claim.evidenceIds).size : 0,
          citationCount: claim.citations?.length,
          unitReferences: claim.unitIds?.length, knownUnits: claim.unitIds?.every(id => payload.evidence?.some(e => e.unitId === id)),
          knownReferences: Array.isArray(claim.evidenceIds) && claim.evidenceIds.every(id => payload.evidence?.some(e => e.evidenceId === id)),
          quotes: claim.citations?.map(c => { const text = payload.evidence?.find(e => e.evidenceId === c.evidenceId)?.text;
            return { characters: c.quote?.length, exact: typeof text === 'string' && typeof c.quote === 'string' && text.includes(c.quote),
              whitespaceOnly: typeof text === 'string' && typeof c.quote === 'string' && text.replace(/\s+/g, ' ').includes(c.quote.replace(/\s+/g, ' ')) }; }),
        })) : undefined });
      return raw;
    } catch (error) { trace.push({ stage, ms: Date.now() - start, code: error.status === 429 ? 'RATE_LIMITED' : error.status === 400 ? 'PROVIDER_FORMAT' : 'TRANSPORT', httpStatus: error.status }); throw error; }
  };
  bridge = registerRecallIpc({ ipcMain, getMainWindow: () => null, getConfig: () => ({ ...cfg, recallStartupMode: 'text' }), llmRegistry,
    serviceDeps: { db, onDiagnostic: event => trace.push(event) },
    createService: deps => { const service = createRecallService(deps), ask = service.ask;
      service.ask = async request => { requestId = request.requestId; result = await ask(request); return result; }; return service; },
    openRecallWindow: () => controller.open(), resizeRecallWindow: (target, width, height) => controller.resize(target, width, height),
    openSource: evidence => { assert(db.getSession(evidence.sessionId)); sourceOpens++; return true; } });
  controller = createRecallWindowController({ BrowserWindow, screen, isDev: false, attachWindow: target => bridge.attachRecallWindow(target), getTheme: () => 'light' });
  for (let i = 0; i < questions.length; i++) {
    const item = questions[i]; step = `case-${i + 1}`; trace = []; result = null;
    selectedRows = item.meeting === undefined ? rows : rows.filter(r => r.status === 'complete').slice(item.meeting, item.meeting + 1);
    win = controller.open();
    await until(() => !win.webContents.isLoading() && read('document.querySelector("textarea") === document.activeElement'));
    await win.webContents.insertText(item.question);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(() => !!result);
    await until(() => read('!!document.querySelector(".recall-answer,.recall-error")'));
    const rendered = await read('({sources:document.querySelectorAll(".recall-source-chip").length,answer:!!document.querySelector(".recall-answer-text"),error:!!document.querySelector(".recall-error")})');
    const before = sourceOpens;
    for (let source = 0; source < rendered.sources; source++) {
      await until(() => read(`!document.querySelectorAll('.recall-source-chip')[${source}].disabled`));
      await read(`document.querySelectorAll('.recall-source-chip')[${source}].click()`); await until(() => sourceOpens > before + source);
    }
    console.log(JSON.stringify({ requestId, case: i + 1, liveText: result.status === 'answered' ? 'ANSWERED' : 'PENDING', status: result.status,
      code: result.error?.code, reason: result.coverage?.reason, meetings: result.coverage?.meetings, claims: result.claims.length, withheldClaims: result.coverage?.withheldClaims,
      missingDetails: result.uncertainty?.includes('missing_details'), gapFieldsMentioned: {
        owner: /owner|assigned|speaker|kaun/i.test(result.text), deadline: /deadline|due|timing/i.test(result.text), budget: /budget/i.test(result.text),
      }, rendered, sourceOpeningIntent: sourceOpens > before, trace }));
    if (result.status !== 'answered') passed = false;
    win.close(); await until(() => win.isDestroyed());
    if (i < questions.length - 1) await wait(Math.max(1500, Math.min(60000, Number(process.env.RECALL_LIVE_INTERVAL_MS) || 1500)));
  }
  assert(fs.readFileSync(cfgPath).equals(cfgBytes), 'CONFIG_CHANGED');
  assert(fs.readFileSync(dbPath).equals(dbBytes), 'DB_CHANGED'); sql.close();
  console.log(JSON.stringify({ liveText: passed ? 'PASS' : 'PENDING', freshWindows: questions.length, savedBytesUnchanged: true,
    sourceViewer: 'revalidated navigation intent only; full product viewer not exercised' }));
}).catch(error => { passed = false; console.log(JSON.stringify({ liveText: 'FAIL', stage: step, code: error.code || error.name })); })
  .finally(() => { clearTimeout(timer); bridge?.dispose(); controller?.dispose(); app.exit(passed ? 0 : 1); });
