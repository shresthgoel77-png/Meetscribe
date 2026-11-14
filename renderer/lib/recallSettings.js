import shortcut from '../../electron/utils/recall-shortcut.json';

// Mirrors the existing Recall config defaults, independent of meeting provider defaults.
export const RECALL_DEFAULTS = {
  recallGnaniApiKey: '', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN',
  recallTtsModel: 'timbre-v3.0', recallTtsVoice: 'Shivani', recallTtsLanguage: 'auto',
  recallLlmProvider: 'groq', recallLlmModels: { groq: 'openai/gpt-oss-120b' },
  recallShortcut: 'CommandOrControl+Shift+Space', recallStartupMode: 'text', recallMuted: false,
  recallContextBudget: 24000,
};
// Supported transport choices from gnani.js; no meeting registry or provider defaults change.
export const RECALL_VOICES = {
  'timbre-v3.0': 'Shivani Lakshmi Kalpana Chetana Vasudha Riyaa Tarika Avinash Shubham Prakash Devansh Yashraj Harshad'.split(' '),
  'timbre-v2.5': 'Ambuja Asmita Bhavna Brinda Chitra Deepak Devika Dhruva Falak Girish Hemraj Ishaan Jalaj Jwala Kaveri Kavin Kirra Lavanya Lehara Mehuli Nalini Noopur Omkar Poorvi Pranav Reshma Riyaan Roopesh Saanvi Shlok Suhana Trisha Trupti Urmila Varuni Vedika Veera Vikrant Yashvi Yukti Zahira Zayan'.split(' '),
};
export const RECALL_TTS_LANGUAGES = ['auto', 'hi-IN', 'en-IN', 'hi-en', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'pa-IN', 'bn-IN', 'gu-IN'];

export function recallFormFromConfig(cfg) {
  return Object.fromEntries(Object.entries(RECALL_DEFAULTS).map(([key, fallback]) =>
    [key, structuredClone(cfg[key] ?? fallback)]));
}

export function validRecallShortcut(value) {
  return typeof value === 'string' && value.length <= 80 && !/\s/.test(value) &&
    (value === '' || new RegExp(shortcut.pattern).test(value.toLowerCase()));
}

export function recallSettingsError(form, llmProviders) {
  if (!validRecallShortcut(form.recallShortcut)) return 'Use an Electron shortcut such as CommandOrControl+Shift+Space, or leave it empty to disable.';
  if (form.recallSttModel !== 'prisma-v3.0' || form.recallSttLanguage !== 'hi-IN,en-IN') return 'Choose the supported Prisma model and STT language hints.';
  if (!RECALL_VOICES[form.recallTtsModel]?.includes(form.recallTtsVoice)) return 'Choose a compatible voice for the selected Timbre model.';
  if (!RECALL_TTS_LANGUAGES.includes(form.recallTtsLanguage)) return 'Choose a supported Timbre language.';
  if (!Number.isInteger(form.recallContextBudget) || form.recallContextBudget < 1000 || form.recallContextBudget > 24000) return 'Evidence context must be 1000–24000 bytes.';
  const provider = llmProviders?.find(item => item.id === form.recallLlmProvider);
  const model = form.recallLlmModels?.[form.recallLlmProvider];
  if (llmProviders && (!provider || typeof model !== 'string' || !model.trim() || model.length > 200 ||
      (!provider.allowCustomModel && !provider.models.some(item => item.id === model)))) return 'Choose a supported Recall provider and a non-empty model ID (up to 200 characters).';
  return null;
}

export function recallTestValues(kind, form, provider) {
  const keys = kind === 'stt' ? ['recallGnaniApiKey', 'recallSttModel', 'recallSttLanguage'] :
    kind === 'tts' ? ['recallGnaniApiKey', 'recallTtsModel', 'recallTtsVoice', 'recallTtsLanguage'] : null;
  if (keys) return Object.fromEntries(keys.map(key => [key, form[key]]));
  if (!provider) throw new Error('Choose a Recall answer provider.');
  return { recallLlmProvider: provider.id, recallLlmModels: { [provider.id]: form.recallLlmModels?.[provider.id] || '' },
    ...Object.fromEntries(provider.credentials.map(field => [field.configKey, form[field.configKey] || ''])) };
}
