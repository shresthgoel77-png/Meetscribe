const Store = require('electron-store');
const { DEFAULT_SYSTEM_PROMPT } = require('../services/prompts');
const { sttRegistry, llmRegistry, providerConfigKeys } = require('../providers');
const { migrateLegacyModels } = require('./configMigration');
const { DEFAULT_MAC_CAPTURE_STRATEGY, normalizeMacCaptureStrategy } = require('../audio/mac-capture');
const recallShortcut = require('./recall-shortcut.json');

const schema = {
  notionToken: {
    type: 'string',
    default: '',
  },
  notionApiKey: {
    type: 'string',
    default: '',
  },
  notionDatabaseId: {
    type: 'string',
    default: '',
  },
  notionPageId: {
    type: 'string',
    default: '',
  },
  // Legacy (pre-4.0) single-Gemini keys; read once by migrateLegacyModels, then removed.
  selectedModel: { type: 'string' },
  geminiModel: { type: 'string' },
  secondaryGeminiModel: { type: 'string' },
  // Active LLM provider, per-provider model choices ({providerId: modelId}) and the
  // optional cross-provider fallback ({provider, model}; empty object = disabled).
  llmProvider: { type: 'string', default: 'gemini' },
  llmModels: { type: 'object', default: {} },
  llmFallback: { type: 'object', default: {} },
  sttModels: { type: 'object', default: {} },
  // Recall preferences are independent of meeting providers/models and legacy migrations.
  // Speech is Gnani-only; these defaults merely store preferences and never start audio/API work.
  recallGnaniApiKey: { type: 'string', maxLength: 4096, default: '' },
  recallSttModel: { type: 'string', enum: ['prisma-v3.0'], default: 'prisma-v3.0' },
  recallSttLanguage: { type: 'string', enum: ['hi-IN,en-IN'], default: 'hi-IN,en-IN' },
  recallTtsModel: { type: 'string', enum: ['timbre-v3.0', 'timbre-v2.5'], default: 'timbre-v3.0' },
  recallTtsVoice: { type: 'string', minLength: 1, maxLength: 64, default: 'Shivani' },
  recallTtsLanguage: { type: 'string', enum: ['auto', 'hi-IN', 'en-IN', 'hi-en', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'pa-IN', 'bn-IN', 'gu-IN'], default: 'auto' },
  recallLlmProvider: { type: 'string', minLength: 1, maxLength: 64, default: 'groq' },
  // Recall-only candidate; account/model access is unverified. Never inherit meeting defaults.
  recallLlmModels: { type: 'object', maxProperties: 8, propertyNames: { maxLength: 64 }, additionalProperties: { type: 'string', minLength: 1, maxLength: 200 }, default: { groq: 'openai/gpt-oss-120b' } },
  recallShortcut: { type: 'string', maxLength: 80, default: 'CommandOrControl+Shift+Space' }, // '' disables it
  recallStartupMode: { type: 'string', enum: ['text', 'voice'], default: 'text' },
  recallMuted: { type: 'boolean', default: false },
  recallContextBudget: { type: 'integer', minimum: 1000, maximum: 24000, default: 24000 }, // serialized evidence UTF-8 bytes
  systemAudioDevice: {
    type: 'string',
    default: '',
  },
  micDevice: {
    type: 'string',
    default: '',
  },
  autoLaunch: {
    type: 'boolean',
    default: true,
  },
  theme: {
    type: 'string',
    default: 'light',
  },
  websocketPort: {
    type: 'number',
    default: 39842,
  },
  onboardingComplete: {
    type: 'boolean',
    default: false,
  },
  sttService: {
    type: 'string',
    default: 'google',
  },
  geminiSystemPrompt: {
    type: 'string',
    default: '',
  },
  systemPrompt: {
    type: 'string',
    default: '',
  },
  noteOutputMode: {
    type: 'string',
    default: 'json',
  },
  promptOutputMode: {
    type: 'string',
    default: 'json',
  },
  language: {
    type: 'string',
    default: 'ml-IN',
  },
  enableDiarization: {
    type: 'boolean',
    default: true,
  },
  minSpeakers: {
    type: 'number',
    default: 1,
  },
  maxSpeakers: {
    type: 'number',
    default: 6,
  },
  autoCheckUpdates: {
    type: 'boolean',
    default: true,
  },
  hideLogsInSidebar: {
    type: 'boolean',
    default: false,
  },
  pinNotesViewToggle: {
    type: 'boolean',
    default: true,
  },
  showAudioWaveform: {
    type: 'boolean',
    default: true,
  },
  meetingDetection: {
    type: 'boolean',
    default: true,
  },
  // macOS only: how system audio is captured (see electron/audio/mac-capture.js).
  macCaptureStrategy: {
    type: 'string',
    default: DEFAULT_MAC_CAPTURE_STRATEGY,
  },
  googleCalendarClientId: {
    type: 'string',
    default: '',
  },
  googleCalendarClientSecret: {
    type: 'string',
    default: '',
  },
  googleCalendarRefreshToken: {
    type: 'string',
    default: '',
  },
  googleCalendarEnabled: {
    type: 'boolean',
    default: false,
  },
  googleCalendarEmail: {
    type: 'string',
    default: '',
  },
  dashboardRecentLimit: {
    type: 'number',
    default: 5,
  },
  notionUploadTranscript: {
    type: 'boolean',
    default: true,
  },
  // PDF export: '' means the Downloads folder (resolved when exporting).
  pdfExportDir: {
    type: 'string',
    default: '',
  },
  pdfIncludeTranscript: {
    type: 'boolean',
    default: false,
  },
};

// Provider credential/option keys (API keys, project IDs, ...) come from the provider registries.
for (const field of providerConfigKeys()) {
  schema[field.configKey] = { type: 'string', default: '' };
}

const store = new Store({ schema, name: 'novameet-config' });

function applyLegacyMigration() {
  const raw = {
    selectedModel: store.get('selectedModel'),
    geminiModel: store.get('geminiModel'),
    secondaryGeminiModel: store.get('secondaryGeminiModel'),
    llmModels: store.get('llmModels'),
    llmFallback: store.get('llmFallback'),
  };
  const { set, remove } = migrateLegacyModels(raw, llmRegistry.get('gemini')._deprecatedModels);
  for (const [key, value] of Object.entries(set)) store.set(key, value);
  for (const key of remove) store.delete(key);
}

/** Saved model per provider, validated against each provider's list. */
function resolveModels(registry, saved = {}) {
  const out = {};
  for (const provider of registry.list()) {
    out[provider.id] = registry.resolveModel(provider, saved[provider.id]);
  }
  return out;
}

function getConfig() {
  applyLegacyMigration();

  const llmProvider = llmRegistry.has(store.get('llmProvider')) ? store.get('llmProvider') : llmRegistry.defaultId();
  const sttService = sttRegistry.has(store.get('sttService')) ? store.get('sttService') : sttRegistry.defaultId();
  const fallback = store.get('llmFallback') || {};
  const llmFallback = llmRegistry.has(fallback.provider)
    ? { provider: fallback.provider, model: llmRegistry.resolveModel(llmRegistry.get(fallback.provider), fallback.model) }
    : {};

  const providerFields = {};
  for (const field of providerConfigKeys()) {
    providerFields[field.configKey] = store.get(field.configKey) || '';
  }

  const notionToken = store.get('notionToken') || store.get('notionApiKey') || '';
  const notionDbId = store.get('notionDatabaseId') || store.get('notionPageId') || '';
  const sysPrompt = store.get('geminiSystemPrompt') || store.get('systemPrompt') || '';
  const outMode = store.get('noteOutputMode') || store.get('promptOutputMode') || 'json';

  return {
    ...providerFields,
    notionToken,
    notionApiKey:              notionToken,
    notionDatabaseId:          notionDbId,
    notionPageId:              notionDbId,
    llmProvider,
    llmModels:                 resolveModels(llmRegistry, store.get('llmModels')),
    llmFallback,
    sttModels:                 resolveModels(sttRegistry, store.get('sttModels')),
    recallGnaniApiKey:          store.get('recallGnaniApiKey') || '',
    recallSttModel:             store.get('recallSttModel') || 'prisma-v3.0',
    recallSttLanguage:          store.get('recallSttLanguage') || 'hi-IN,en-IN',
    recallTtsModel:             store.get('recallTtsModel') || 'timbre-v3.0',
    recallTtsVoice:             store.get('recallTtsVoice') || 'Shivani',
    recallTtsLanguage:          store.get('recallTtsLanguage') || 'auto',
    recallLlmProvider:          store.get('recallLlmProvider') || 'groq',
    recallLlmModels:            store.get('recallLlmModels') || { groq: 'openai/gpt-oss-120b' },
    recallShortcut:             store.get('recallShortcut') ?? 'CommandOrControl+Shift+Space',
    recallStartupMode:          store.get('recallStartupMode') || 'text',
    recallMuted:                store.get('recallMuted') ?? false,
    recallContextBudget:        store.get('recallContextBudget') ?? 24000,
    systemAudioDevice:         store.get('systemAudioDevice') || '',
    micDevice:                 store.get('micDevice') || '',
    autoLaunch:                store.get('autoLaunch') ?? true,
    theme:                     store.get('theme') || 'light',
    websocketPort:             store.get('websocketPort') || 39842,
    onboardingComplete:        store.get('onboardingComplete') || false,
    sttService,
    geminiSystemPrompt:        sysPrompt,
    systemPrompt:              sysPrompt,
    noteOutputMode:            outMode,
    promptOutputMode:          outMode,
    language:                  store.get('language') || 'ml-IN',
    enableDiarization:         store.get('enableDiarization') ?? true,
    minSpeakers:               store.get('minSpeakers') || 1,
    maxSpeakers:               store.get('maxSpeakers') || 6,
    autoCheckUpdates:          store.get('autoCheckUpdates') !== false,
    hideLogsInSidebar:         store.get('hideLogsInSidebar') || false,
    pinNotesViewToggle:        store.get('pinNotesViewToggle') !== false,
    showAudioWaveform:         store.get('showAudioWaveform') !== false,
    meetingDetection:          store.get('meetingDetection') !== false,
    macCaptureStrategy:        normalizeMacCaptureStrategy(store.get('macCaptureStrategy')),
    googleCalendarClientId:    store.get('googleCalendarClientId') || '',
    googleCalendarClientSecret: store.get('googleCalendarClientSecret') || '',
    googleCalendarRefreshToken: store.get('googleCalendarRefreshToken') || '',
    googleCalendarEnabled:     store.get('googleCalendarEnabled') || false,
    googleCalendarEmail:       store.get('googleCalendarEmail') || '',
    dashboardRecentLimit:      store.get('dashboardRecentLimit') || 5,
    notionUploadTranscript:    store.get('notionUploadTranscript') !== false,
    pdfExportDir:              store.get('pdfExportDir') || '',
    pdfIncludeTranscript:      store.get('pdfIncludeTranscript') === true,
  };
}

// Syntax only. Never probe/reserve an unsaved OS shortcut; registration is a later stage.
function validateRecallShortcut(value) {
  if (typeof value !== 'string' || value.length > 80 || /\s/.test(value) ||
      (value !== '' && !new RegExp(recallShortcut.pattern).test(value.toLowerCase()))) {
    throw new Error('Invalid Recall shortcut. Use modifiers joined with + and one key, or leave empty to disable.');
  }
}

function setConfig(key, value) {
  if (key === 'recallShortcut') validateRecallShortcut(value);
  store.set(key, value);
  // Keep key aliases in sync
  if (key === 'notionApiKey') store.set('notionToken', value);
  if (key === 'notionToken') store.set('notionApiKey', value);
  if (key === 'notionDatabaseId') store.set('notionPageId', value);
  if (key === 'notionPageId') store.set('notionDatabaseId', value);
  if (key === 'systemPrompt') store.set('geminiSystemPrompt', value);
  if (key === 'geminiSystemPrompt') store.set('systemPrompt', value);
  if (key === 'promptOutputMode') store.set('noteOutputMode', value);
  if (key === 'noteOutputMode') store.set('promptOutputMode', value);
}

function setMultipleConfig(updates) {
  // Reject before any unrelated setting/alias is written by a mixed Settings save.
  if (Object.hasOwn(updates, 'recallShortcut')) validateRecallShortcut(updates.recallShortcut);
  for (const [key, value] of Object.entries(updates)) {
    setConfig(key, value);
  }
}

function isFirstRun() {
  return !store.get('onboardingComplete');
}

function markOnboardingComplete() {
  store.set('onboardingComplete', true);
}

module.exports = {
  store,
  getConfig,
  setConfig,
  setMultipleConfig,
  validateRecallShortcut,
  isFirstRun,
  markOnboardingComplete,
  DEFAULT_SYSTEM_PROMPT,
};
