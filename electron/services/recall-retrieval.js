// Local, read-only Recall retrieval. Deliberately independent of renderer ESM search/config/LLMs.
const { createHash } = require('node:crypto');

const LIMITS = Object.freeze({ question: 1000, questionBytes: 4000, expansions: 6, expansion: 128,
  queryTerms: 128, passage: 1600, overlap: 400, evidence: 12, defaultPassages: 8, contextBytes: 24000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORDS = /[\p{L}\p{M}\p{N}]+(?:[.,]\p{N}+)*(?:['’]\p{L}+)?/gu;
const STOP = new Set(('a an the and or of for to in on at by with from is are was were be been ' +
  'what when where who whom which why how did do does we our i me my you your it its this that ' +
  'about please tell show find meeting meetings said say discuss discussed').split(' '));
const FORMS = { decision: 'decid', decisions: 'decid', decide: 'decid', decided: 'decid', deciding: 'decid',
  approve: 'approv', approved: 'approv', approval: 'approv', approvals: 'approv' };
const text = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n') :
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const label = (value, cap) => text(value).slice(0, cap).replace(/[\uD800-\uDBFF]$/, '');
const substantive = value => /[\p{L}\p{N}]/u.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

class RecallRetrievalError extends Error {
  constructor(code) {
    super({ INVALID_REQUEST: 'Invalid Recall retrieval request.', SOURCE_CHANGED: 'Meeting evidence changed or is no longer available.',
      UNAVAILABLE: 'Saved meetings could not be read.' }[code]);
    this.name = 'RecallRetrievalError';
    this.code = code;
  }
}
const fail = code => { throw new RecallRetrievalError(code); };
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const jsonBytes = value => {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { fail('INVALID_REQUEST'); }
};
function parse(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
function snapshot(row) {
  if (!row || typeof row.id !== 'string' || !row.id.length || row.id.length > 128) return null;
  try {
    const notes = parse(row.notes, null);
    const transcript = parse(row.transcript, []);
    // Snapshot even injected stores that return mutable references. Persisted values are JSON data.
    return JSON.parse(JSON.stringify({ sessionId: row.id, title: row.title ?? null, startedAt: row.started_at ?? null,
      notes: notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : null,
      transcript: Array.isArray(transcript) ? transcript : [] }));
  } catch { return null; }
}

function token(word) {
  let w = word.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  // Group separators are removed only when unambiguous; no numeric prefix/fuzzy matching.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(w) || /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/.test(w)) w = w.replace(/,/g, '');
  if (/^\d+(\.\d+)?$/.test(w)) return w.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  if (Object.hasOwn(FORMS, w)) return FORMS[w];
  if (!/^[a-z]{4,}$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  const stripped = w.replace(/(?:ing|ed)$/, '');
  if (stripped.length >= 3 && stripped !== w) {
    w = stripped.replace(/([b-df-hj-np-rt-vx])\1$/, '$1');
  } else w = w.replace(/s$/, '').replace(/e$/, '');
  return w;
}
function tokens(value) {
  return [...text(value).matchAll(WORDS)].filter(m => !STOP.has(m[0].toLowerCase())).map(m => token(m[0]));
}
function queryOf(question, expansion) {
  const trimmed = typeof question === 'string' ? question.trim() : '';
  if (!trimmed || trimmed.length > LIMITS.question ||
      Buffer.byteLength(trimmed, 'utf8') > LIMITS.questionBytes || !Array.isArray(expansion) ||
      expansion.length > LIMITS.expansions || expansion.some(s => typeof s !== 'string' || s.length > LIMITS.expansion)) fail('INVALID_REQUEST');
  const original = new Set(tokens(trimmed));
  const weights = new Map([...original].map(t => [t, 1]));
  for (const s of expansion) for (const t of tokens(s)) if (!weights.has(t)) weights.set(t, 0.35);
  if (weights.size > LIMITS.queryTerms) fail('INVALID_REQUEST');
  return { original, weights, numbers: new Set([...original].filter(t => /^\d/.test(t))) };
}
function exclusions({ activeRecordingId = null, processingSessionIds = [] }) {
  if (activeRecordingId !== null && (typeof activeRecordingId !== 'string' || activeRecordingId.length > 128)) fail('INVALID_REQUEST');
  if (!(Array.isArray(processingSessionIds) || processingSessionIds instanceof Set) ||
      [...processingSessionIds].some(id => typeof id !== 'string' || id.length > 128)) fail('INVALID_REQUEST');
  return new Set([...processingSessionIds, ...(activeRecordingId ? [activeRecordingId] : [])]);
}

// Structured objects use explicit projections, never Object.values()/arbitrary note traversal.
function listText(value, depth = 0) {
  const scalar = text(value);
  if (scalar || depth >= 3 || !value || typeof value !== 'object') return scalar;
  if (Array.isArray(value)) return value.map(v => listText(v, depth + 1)).filter(Boolean).join('; ');
  return ['text', 'description', 'content', 'summary', 'decision', 'question', 'option', 'name', 'owner', 'due',
    'reason', 'rationale', 'context', 'conditions', 'details', 'status', 'pros', 'cons'].map(key => {
    const s = listText(value[key], depth + 1);
    return s ? `${key}: ${s}` : '';
  }).filter(Boolean).join('; ');
}
function project(value, kind) {
  if (typeof value === 'string' || typeof value === 'number') return text(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const fields = {
    action: [['Task', value.task || value.text || value.description], ['Owner', value.owner], ['Due', value.due], ['Priority', value.priority]],
    participant: [['Name', value.name], ['Label', value.label], ['Role', value.role], ['Identity confidence', value.identity_confidence]],
    section: [['Heading', value.heading], ['Content', value.content], ['Summary', value.summary !== value.content ? value.summary : ''],
      ['Options discussed', value.options_discussed], ['Decision', value.decision], ['Open questions', value.open_questions]],
    record: [['Decision', value.decision || value.text || value.content || value.summary], ['Task', value.task],
      ['Question', value.question], ['Owner', value.owner], ['Due', value.due], ['Reason', value.reason],
      ['Rationale', value.rationale], ['Context', value.context], ['Conditions', value.conditions], ['Details', value.details], ['Status', value.status]],
  }[kind];
  return fields.map(([key, v]) => { const s = listText(v); return s.trim() ? `${key}: ${s}` : ''; }).filter(Boolean).join('\n');
}

// Exact contiguous slices, not display snippets: pack whole sentences/paragraphs when possible.
// A long sentence uses word-boundary windows with 400-character overlap. Never strip negation.
function ranges(source, cap = LIMITS.passage) {
  const out = [];
  let from = 0;
  while (from < source.length) {
    let to = Math.min(source.length, from + cap);
    if (to < source.length) {
      const window = source.slice(from, to);
      const boundaries = [...window.matchAll(/(?:[.!?।][ \t]+|\n+)/g)];
      const last = boundaries.filter(m => m.index + m[0].length >= cap / 2).at(-1);
      if (last) to = from + last.index + last[0].length;
      else {
        const space = window.lastIndexOf(' ');
        if (space > 0) to = from + space + 1;
      }
      if (/[\uD800-\uDBFF]/.test(source[to - 1])) to--;
    }
    if (to <= from) break;
    out.push([from, to]);
    if (to === source.length) break;
    const minimum = Math.max(from + 1, to - Math.min(LIMITS.overlap, Math.floor(cap / 3)));
    const ends = [...source.slice(from, to).matchAll(/(?:[.!?।][ \t]+|\n+)/g)].map(m => from + m.index + m[0].length);
    if (ends.includes(to)) {
      // Do not repeat a sentence fragment with its leading negation cut off. Overlap whole
      // sentences, or start at the next sentence when no complete overlap fits.
      from = ends.find(end => end >= minimum && end < to) || ends.filter(end => end > from && end < to).at(-1) || to;
    } else {
      // An individual sentence longer than the cap needs overlapping word-boundary windows.
      const boundary = source.indexOf(' ', minimum);
      from = boundary >= minimum && boundary < to ? boundary + 1 : to;
    }
  }
  return out;
}
function seconds(segment, names) {
  const values = names.filter(k => segment[k] !== undefined && segment[k] !== null).map(k => segment[k]);
  // Conflicting aliases, strings and unknown units are ambiguous. Do not invent a conversion.
  if (!values.length || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0) ||
      values.some(v => v !== values[0])) return null;
  return values[0];
}
function timing(segment, pasted) {
  if (pasted) return { startSeconds: null, endSeconds: null };
  const start = seconds(segment, ['startTime', 'start_time', 'offset_seconds', 'start_time_seconds']);
  const end = seconds(segment, ['endTime', 'end_time', 'end_time_seconds']);
  // Only a valid interval is citable. Offsets lacking an end are not synthesized into durations.
  return start !== null && end !== null && end > start ? { startSeconds: start, endSeconds: end } : { startSeconds: null, endSeconds: null };
}

function passages(s, includeTranscriptContext = false) {
  const out = [];
  const seen = new Set();
  let contentHash;
  try { contentHash = `sha256:${hash(s)}`; } catch { return out; }
  const date = typeof s.startedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(s.startedAt) && Number.isFinite(Date.parse(s.startedAt))
    ? new Date(s.startedAt).toISOString() : null;
  function add(source, section, locator, weight, atomic = false) {
    source = text(source);
    if (!substantive(source) || (atomic && source.length > LIMITS.passage)) return;
    for (const [from, to] of ranges(source)) {
      const slice = source.slice(from, to);
      if (!substantive(slice)) continue;
      const duplicate = `${section}\n${slice.replace(/\s+/g, ' ').trim()}`;
      if (seen.has(duplicate)) continue;
      seen.add(duplicate);
      const target = { ...locator, from: (locator.from || 0) + from, to: (locator.from || 0) + to };
      const evidence = { evidenceId: `E${hash({ sessionId: s.sessionId, contentHash, locator: target }).slice(0, 24)}`,
        sessionId: s.sessionId, title: label(s.title, 240) || 'Untitled Meeting', startedAt: date,
        section: label(section, 120), text: slice, locator: target, contentHash };
      out.push({ evidence, weight });
    }
  }
  const notes = s.notes || {};
  function action(item, path) {
    const whole = project(item, 'action');
    const locator = { kind: 'notes', path, projection: 'action' };
    if (whole.length <= LIMITS.passage || !item || typeof item !== 'object') {
      add(whole, 'Action item', locator, 1.8);
      return;
    }
    // A long task still carries its owner/due on every slice. The locator records the actual
    // task slice used by this deterministic projection; no source string is rewritten in storage.
    const task = text(item.task || item.text || item.description);
    const context = project({ owner: item.owner, due: item.due, priority: item.priority }, 'action');
    const cap = LIMITS.passage - 'Task: '.length - (context ? context.length + 1 : 0);
    if (cap < 128) return; // pathological metadata cannot fit together with useful task context
    for (const [from, to] of ranges(task, cap)) {
      add(`Task: ${task.slice(from, to)}${context ? `\n${context}` : ''}`, 'Action item',
        { ...locator, taskRange: { from, to } }, 1.8, true);
    }
  }
  if (text(notes.summary).trim()) add(notes.summary, 'Summary', { kind: 'notes', path: ['summary'] }, 1.5);
  for (const key of ['sections', 'topics', 'key_points']) {
    if (!Array.isArray(notes[key])) continue;
    notes[key].forEach((sec, i) => {
      if (sec && typeof sec === 'object' && ![sec.content, sec.summary, sec.decision, sec.options_discussed, sec.open_questions].some(v => substantive(listText(v)))) return;
      add(project(sec, 'section'), text(sec?.heading) || 'Notes', { kind: 'notes', path: [key, i], projection: 'section' }, 1.4);
    });
  }
  if (Array.isArray(notes.action_items)) notes.action_items.forEach((item, i) => {
    if (item && Array.isArray(item.tasks)) {
      item.tasks.forEach((task, j) => action({ ...item, task }, ['action_items', i, 'tasks', j]));
    } else action(item, ['action_items', i]);
  });
  for (const [key, section, weight] of [['decisions', 'Decision', 2], ['questions_unresolved', 'Open question', 1.4],
    ['open_questions', 'Open question', 1.4], ['notable_mentions', 'Mention', 0.8], ['participants', 'Participant', 0.8], ['attendees', 'Participant', 0.8]]) {
    const value = notes[key];
    const kind = ['participants', 'attendees'].includes(key) ? 'participant' : 'record';
    if (Array.isArray(value)) value.forEach((v, i) => add(project(v, kind), section, { kind: 'notes', path: [key, i], projection: kind }, weight, kind === 'participant'));
    else if (value) add(project(value, kind), section, { kind: 'notes', path: [key], projection: kind }, weight, kind === 'participant');
  }
  const md = text(notes._rawMarkdown);
  const headings = [...md.matchAll(/^#{1,6}[ \t]+([^\n]+).*$/gm)];
  if (md.trim()) {
    const blocks = [{ from: 0, heading: 'Notes' }, ...headings.map(m => ({ from: m.index, heading: m[1] }))];
    blocks.forEach((block, i) => {
      const end = blocks[i + 1]?.from ?? md.length;
      const body = md.slice(block.from, end);
      // A bare heading/table rule is not substantive meeting evidence.
      const lines = body.split('\n');
      const rule = /^[\s|:-]+$/;
      const content = lines.filter((line, j) => !/^#{1,6}\s/.test(line) && !rule.test(line) &&
        !(line.includes('|') && rule.test(lines[j + 1] || ''))).join('\n');
      if (!substantive(content)) return;
      add(body, block.heading, { kind: 'markdown', from: block.from }, 1.3);
    });
  }
  s.transcript.forEach((seg, i) => {
    if (!seg || typeof seg !== 'object') return;
    add(seg.text, text(seg.speaker) ? `Transcript · ${text(seg.speaker)}` : 'Transcript',
      { kind: 'transcript', segmentIndex: i, ...timing(seg, notes._sttService === 'none') }, 1);
    if (includeTranscriptContext) {
      // A scoped action query needs adjacent assignment/condition sentences together.
      // Keep whole segments and speaker labels, with deterministic, revalidatable boundaries.
      let body = '', end = i;
      for (let j = i; j < Math.min(i + 4, s.transcript.length); j++) {
        const item = s.transcript[j];
        if (!item || !substantive(text(item.text))) break;
        const line = `${text(item.speaker) ? `${text(item.speaker)}: ` : ''}${text(item.text)}`;
        if ((body + '\n' + line).length > LIMITS.passage) break;
        body += `${body ? '\n' : ''}${line}`; end = j;
      }
      if (end > i) add(body, 'Transcript context', { kind: 'transcript', segmentIndex: i, segmentEnd: end,
        ...timing({ startTime: timing(seg, notes._sttService === 'none').startSeconds,
          endTime: timing(s.transcript[end], notes._sttService === 'none').endSeconds }, notes._sttService === 'none') }, 1.1, true);
    }
  });
  return out;
}

function rank(candidates, q) {
  const df = new Map();
  for (const c of candidates) {
    c.terms = new Map();
    for (const t of tokens(c.evidence.text)) c.terms.set(t, (c.terms.get(t) || 0) + 1);
    c.length = [...c.terms.values()].reduce((a, b) => a + b, 0);
    c.meta = new Set(tokens(`${c.evidence.title} ${c.evidence.section}`));
    for (const t of new Set([...c.terms.keys(), ...c.meta])) df.set(t, (df.get(t) || 0) + 1);
  }
  const avg = candidates.reduce((n, c) => n + c.length, 0) / (candidates.length || 1);
  for (const c of candidates) {
    c.score = 0;
    // Original amounts are exact anchors; expansion terms cannot substitute a different amount.
    if (q.numbers.size && ![...q.numbers].some(t => c.terms.has(t))) continue;
    let matched = 0;
    for (const [t, weight] of q.weights) {
      const tf = c.terms.get(t) || 0;
      const frequency = df.get(t) || 0;
      const idf = Math.log(1 + (candidates.length - frequency + 0.5) / (frequency + 0.5));
      if (tf) {
        c.score += weight * idf * tf * 2.2 / (tf + 1.2 * (0.5 + 0.5 * c.length / (avg || 1)));
        if (q.original.has(t)) matched++;
      }
      if (c.meta.has(t)) c.score += weight * 0.25 * idf;
    }
    c.score *= c.weight * (1 + 0.4 * matched / (q.original.size || 1));
  }
  const best = candidates.reduce((best, c) => Math.max(best, c.score), 0);
  return candidates.filter(c => c.score > 0 && c.score >= best * 0.15).sort((a, b) => b.score - a.score ||
    compare(a.evidence.startedAt || '', b.evidence.startedAt || '') || compare(a.evidence.evidenceId, b.evidence.evidenceId));
}
function similarity(a, b) {
  let overlap = 0;
  for (const t of a.terms.keys()) if (b.terms.has(t)) overlap++;
  return overlap / (a.terms.size + b.terms.size - overlap || 1);
}
function select(candidates, budget, maxPassages, requiredSessions = [], facets = []) {
  const chosen = [];
  // For scoped comparisons, reserve actual requested fields, round-robin across meetings.
  // This keeps action/owner/due projections and budget conditions ahead of title-only matches.
  for (const facet of facets) for (const id of requiredSessions) {
    if (chosen.some(c => c.evidence.sessionId === id && facet(c.evidence))) continue;
    const i = candidates.findIndex(c => c.evidence.sessionId === id && facet(c.evidence) &&
      jsonBytes([...chosen.map(p => p.evidence), c.evidence]) <= budget);
    if (i >= 0 && chosen.length < maxPassages) chosen.push(candidates.splice(i, 1)[0]);
  }
  // Reserve one matching passage per selected meeting before filling remaining slots.
  for (const id of requiredSessions) {
    const i = candidates.findIndex(c => c.evidence.sessionId === id &&
      jsonBytes([...chosen.map(p => p.evidence), c.evidence]) <= budget);
    if (i >= 0 && chosen.length < maxPassages) chosen.push(candidates.splice(i, 1)[0]);
  }
  while (candidates.length && chosen.length < maxPassages) {
    let bestIndex = -1;
    let bestScore = -1;
    candidates.forEach((c, i) => {
      if (jsonBytes([...chosen.map(p => p.evidence), c.evidence]) > budget) return;
      const sameSession = chosen.filter(p => p.evidence.sessionId === c.evidence.sessionId);
      const repeats = sameSession.filter(p => p.evidence.section === c.evidence.section).length;
      const redundancy = Math.max(0, ...sameSession.map(p => similarity(c, p)));
      const score = c.score / (1 + sameSession.length + repeats * 0.5 + redundancy);
      if (score > bestScore) { bestIndex = i; bestScore = score; }
    });
    if (bestIndex < 0) break;
    chosen.push(candidates.splice(bestIndex, 1)[0]);
  }
  return chosen.map(c => c.evidence);
}
function storeOf(deps) {
  const db = deps.db || require('../db/sessions'); // existing initialized DB, never initialize/write
  if (typeof db.listSessions !== 'function' || typeof db.getSession !== 'function') fail('UNAVAILABLE');
  return db;
}
function read(db, method, ...args) {
  try { return db[method](...args); } catch { fail('UNAVAILABLE'); }
}
function validRequestId(requestId) { if (typeof requestId !== 'string' || !UUID.test(requestId)) fail('INVALID_REQUEST'); }

/** All current rows, no recent limit; result contains evidence only, never generated answers. */
function retrieveEvidence({ requestId, question, expansion = [], activeRecordingId = null, processingSessionIds = [],
  recallContextBudget = LIMITS.contextBytes, maxPassages = LIMITS.defaultPassages, includeAvailability = false, latestMeetings = null } = {}, deps = {}) {
  validRequestId(requestId);
  const q = queryOf(question, expansion);
  const excluded = exclusions({ activeRecordingId, processingSessionIds });
  if (!Number.isInteger(recallContextBudget) || recallContextBudget < 2 || recallContextBudget > LIMITS.contextBytes ||
      !Number.isInteger(maxPassages) || maxPassages < 1 || maxPassages > 10 || typeof includeAvailability !== 'boolean' ||
      (latestMeetings !== null && (!Number.isInteger(latestMeetings) || latestMeetings < 1 || latestMeetings > 5))) fail('INVALID_REQUEST');
  const db = storeOf(deps);
  const rows = read(db, 'listSessions');
  if (!Array.isArray(rows)) fail('UNAVAILABLE');
  let sessions = [];
  for (const row of rows) {
    if (row?.status !== 'complete' || excluded.has(row.id)) continue;
    const s = snapshot(row);
    if (!s) continue;
    const extracted = passages(s, latestMeetings !== null);
    if (extracted.length) sessions.push({ s, extracted });
  }
  if (latestMeetings !== null) sessions = sessions.filter(({ s }) => typeof s.startedAt === 'string' && Number.isFinite(Date.parse(s.startedAt)))
    .sort((a, b) => Date.parse(b.s.startedAt) - Date.parse(a.s.startedAt) || compare(a.s.sessionId, b.s.sessionId)).slice(0, latestMeetings);
  const candidates = sessions.flatMap(s => s.extracted);
  try { deps.onDiagnostic?.({ stage: 'extraction', code: 'PASSAGES_EXTRACTED', selected: sessions.length, passages: candidates.length }); } catch { /* observer */ }
  const agenda = latestMeetings !== null && /\b(agenda|summary|overview|topics)\b/i.test(question);
  const actions = latestMeetings !== null && /\b(action|actions|owner|deadline|task|tasks)\b/i.test(question);
  const budget = latestMeetings !== null && /\b(budget|approved|approval)\b/i.test(question);
  const overview = e => e.locator.kind === 'notes' && ['summary', 'sections', 'topics', 'key_points'].includes(e.locator.path?.[0]);
  const action = e => e.section === 'Action item';
  const financial = e => /\b(budget|fund\w*|cost\w*|spend\w*|price|money|rupees?|dollars?)\b|₹|\$|बजट/iu.test(e.text);
  // A global cutoff can discard a weaker meeting's relevant fields. Rank each selected
  // meeting independently; ordinary library retrieval keeps its existing scoring/cutoff.
  const ranked = latestMeetings === null ? rank(candidates, q) : sessions.flatMap(({ extracted }) => {
    const matches = rank(extracted, q);
    if (!q.numbers.size) for (const c of extracted) {
      if (!matches.includes(c) && ((agenda && overview(c.evidence)) || (actions && action(c.evidence)) || (budget && financial(c.evidence)))) {
        c.score = 0.1; matches.push(c);
      }
    }
    return matches;
  }).sort((a, b) => b.score - a.score || compare(a.evidence.evidenceId, b.evidence.evidenceId));
  const hadMatches = ranked.length > 0;
  try { deps.onDiagnostic?.({ stage: 'ranking', code: 'PASSAGES_RANKED', passages: ranked.length }); } catch { /* observer */ }
  const facets = [...(agenda ? [overview] : []), ...(actions ? [action] : []), ...(budget ? [financial] : [])];
  const evidence = select(ranked, recallContextBudget, maxPassages, latestMeetings === null ? [] : sessions.map(s => s.s.sessionId), facets);
  const checked = revalidateEvidence({ requestId, evidence, activeRecordingId, processingSessionIds }, { db });
  return { ...checked,
    ...(includeAvailability ? { availability: candidates.length ? 'searchable' : 'empty', budgetLimited: hadMatches && !evidence.length } : {}),
    ...(latestMeetings === null ? {} : { meetings: { requested: latestMeetings, available: sessions.length,
      retrieved: new Set(evidence.map(e => e.sessionId)).size } }) };
}

/** Reconstruct known locators from fresh records, rather than resolving arbitrary renderer paths. */
function revalidateEvidence({ requestId, evidence, activeRecordingId = null, processingSessionIds = [] } = {}, deps = {}) {
  validRequestId(requestId);
  const excluded = exclusions({ activeRecordingId, processingSessionIds });
  if (!Array.isArray(evidence) || evidence.length > LIMITS.evidence || jsonBytes(evidence) > LIMITS.contextBytes) fail('INVALID_REQUEST');
  const db = storeOf(deps);
  const current = new Map();
  const ids = new Set();
  for (const item of evidence) {
    if (!item || typeof item.sessionId !== 'string' || item.sessionId.length > 128 || typeof item.evidenceId !== 'string' ||
        !/^E[0-9a-f]{24}$/.test(item.evidenceId) || ids.has(item.evidenceId)) fail('INVALID_REQUEST');
    ids.add(item.evidenceId);
    if (!current.has(item.sessionId)) {
      const row = read(db, 'getSession', item.sessionId);
      if (!row || row.status !== 'complete' || excluded.has(row.id)) fail('SOURCE_CHANGED');
      const s = snapshot(row);
      current.set(item.sessionId, s ? passages(s, true).map(c => c.evidence) : []);
    }
    const match = current.get(item.sessionId).find(p => p.evidenceId === item.evidenceId);
    if (!match || canonical(match) !== canonical(item)) fail('SOURCE_CHANGED');
  }
  // Return reconstructed values, not caller-owned evidence objects.
  const checked = evidence.map(item => current.get(item.sessionId).find(p => p.evidenceId === item.evidenceId));
  return { requestId, evidence: checked, contextBytes: jsonBytes(checked) };
}

module.exports = { retrieveEvidence, revalidateEvidence, RecallRetrievalError, LIMITS };
