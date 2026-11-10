import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const requireFromConfig = createRequire(new URL('../electron/utils/config.js', import.meta.url));
// Already installed via the existing config/tooling dependencies; no package installation.
const Ajv = require('ajv');
const source = readFileSync(new URL('../electron/utils/config.js', import.meta.url), 'utf8');
const defaults = {
  recallGnaniApiKey: '',
  recallSttModel: 'prisma-v3.0',
  recallSttLanguage: 'hi-IN,en-IN',
  recallTtsModel: 'timbre-v3.0',
  recallTtsVoice: 'Shivani',
  recallTtsLanguage: 'auto',
  recallLlmProvider: 'groq',
  recallLlmModels: { groq: 'openai/gpt-oss-120b' },
  recallShortcut: 'CommandOrControl+Shift+Space',
  recallStartupMode: 'text',
  recallMuted: false,
  recallContextBudget: 24000,
};
const recallKeys = Object.keys(defaults);
const withoutRecall = obj => Object.fromEntries(Object.entries(obj).filter(([key]) => !key.startsWith('recall')));

function loadConfig(seed = {}) {
  // Run the actual CommonJS module with an injected, schema-validating in-memory store.
  // The real electron-store constructor is NEVER imported or invoked; no user profile is opened.
  const allowed = new Set(['../services/prompts', '../providers', './configMigration', '../audio/mac-capture']);
  let schema;
  let data;
  let name;
  const writes = [];
  class MemoryStore {
    constructor(options) {
      schema = options.schema;
      name = options.name;
      this.validate = new Ajv({ useDefaults: true, strict: false }).compile({ type: 'object', properties: schema });
      data = structuredClone(seed);
      if (!this.validate(data)) throw new Error('Invalid fixture');
    }
    get(key) { return structuredClone(data[key]); }
    set(key, value) {
      const next = { ...data, [key]: structuredClone(value) };
      if (!this.validate(next)) throw new Error('Schema validation failed');
      data = next;
      writes.push({ key, value: structuredClone(value) });
    }
    delete(key) { delete data[key]; writes.push({ key, deleted: true }); }
  }
  const injectedRequire = (id) => {
    if (id === 'electron-store') return MemoryStore;
    if (!allowed.has(id)) throw new Error(`Unexpected config dependency: ${id}`);
    return requireFromConfig(id);
  };
  const module = { exports: {} };
  const fetch = vi.fn(() => { throw new Error('Config must not call the network'); });
  const run = vm.runInNewContext(`(function(require, module) { ${source}\n})`, { fetch });
  run(injectedRequire, module);
  return { config: module.exports, schema, name, writes, fetch, snapshot: () => structuredClone(data) };
}

describe('Recall config defaults and readback', () => {
  it('includes every Recall schema field explicitly in getConfig, with independent passive defaults', () => {
    const { config, schema, name, writes, fetch } = loadConfig();
    const cfg = config.getConfig();
    expect(name).toBe('novameet-config');
    expect(Object.keys(schema).filter(k => k.startsWith('recall')).sort()).toEqual([...recallKeys].sort());
    expect(Object.keys(cfg).filter(k => k.startsWith('recall')).sort()).toEqual([...recallKeys].sort());
    for (const key of recallKeys) {
      expect(schema[key].default).toEqual(defaults[key]);
      expect(cfg[key]).toEqual(defaults[key]);
    }
    expect(cfg).toMatchObject({ sttService: 'google', llmProvider: 'gemini', llmFallback: {}, language: 'ml-IN' });
    expect(cfg.llmModels.groq).not.toBe(cfg.recallLlmModels.groq);
    expect(writes).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('round-trips all Recall fields, including disabled shortcut and explicit false', () => {
    const { config, writes, fetch } = loadConfig();
    config.setMultipleConfig({
      recallGnaniApiKey: 'test-gnani-only', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN',
      recallTtsModel: 'timbre-v2.5', recallTtsVoice: 'Nalini', recallTtsLanguage: 'hi-IN',
      recallLlmProvider: 'claude', recallLlmModels: { groq: 'custom-recall-groq', claude: 'custom-recall-claude' },
      recallShortcut: '', recallStartupMode: 'voice', recallMuted: true, recallContextBudget: 8000,
    });
    const cfg = config.getConfig();
    expect(cfg).toMatchObject({
      recallGnaniApiKey: 'test-gnani-only', recallSttModel: 'prisma-v3.0', recallSttLanguage: 'hi-IN,en-IN',
      recallTtsModel: 'timbre-v2.5', recallTtsVoice: 'Nalini', recallTtsLanguage: 'hi-IN',
      recallLlmProvider: 'claude', recallLlmModels: { groq: 'custom-recall-groq', claude: 'custom-recall-claude' },
      recallShortcut: '', recallStartupMode: 'voice', recallMuted: true, recallContextBudget: 8000,
    });
    config.setConfig('recallMuted', false);
    expect(config.getConfig().recallMuted).toBe(false);
    expect(writes.every(w => w.key.startsWith('recall'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves every existing stored and returned config value during Recall saves', () => {
    const fixture = {
      sttService: 'groq', sttModels: { groq: 'whisper-large-v3' }, language: 'ml-IN',
      llmProvider: 'gemini', llmModels: { gemini: 'meeting-gemini', groq: 'meeting-groq', claude: 'meeting-claude' },
      llmFallback: { provider: 'claude', model: 'meeting-fallback' },
      groqApiKey: 'existing-groq-key', geminiApiKey: 'existing-gemini-key', claudeApiKey: 'existing-claude-key',
      notionToken: 'existing-notion-token', notionApiKey: 'existing-notion-token',
      notionDatabaseId: 'existing-parent', notionPageId: 'existing-parent',
      systemPrompt: 'existing-prompt', geminiSystemPrompt: 'existing-prompt',
      noteOutputMode: 'markdown', promptOutputMode: 'markdown', micDevice: 'existing-mic',
      systemAudioDevice: 'existing-loopback', websocketPort: 39843, googleCalendarRefreshToken: 'existing-calendar',
      onboardingComplete: true, autoLaunch: false, theme: 'dark', pdfExportDir: 'existing-export-dir',
    };
    const { config, writes, snapshot } = loadConfig(fixture);
    const storedBefore = withoutRecall(snapshot());
    const returnedBefore = withoutRecall(config.getConfig());
    expect(writes).toEqual([]);
    config.setMultipleConfig({ recallLlmProvider: 'groq', recallLlmModels: { groq: 'recall-custom' },
      recallGnaniApiKey: 'recall-only-key', recallTtsLanguage: 'en-IN', recallStartupMode: 'voice' });
    expect(withoutRecall(snapshot())).toEqual(storedBefore);
    expect(withoutRecall(config.getConfig())).toEqual(returnedBefore);
    expect(writes.every(w => w.key.startsWith('recall'))).toBe(true);
    expect(config.getConfig().groqApiKey).toBe(fixture.groqApiKey);
  });

  it('keeps existing legacy-model migration semantics separate from Recall models', () => {
    const { config, snapshot, writes } = loadConfig({
      selectedModel: 'gemini-3.5-flash', secondaryGeminiModel: 'gemini-3.7-flash',
      recallLlmModels: { groq: 'recall-custom', gemini: 'gemini-3.5-flash' },
    });
    const cfg = config.getConfig();
    expect(cfg.llmModels.gemini).toBe('gemini-3.8-flash');
    expect(cfg.llmFallback).toEqual({ provider: 'gemini', model: 'gemini-3.7-flash' });
    expect(cfg.recallLlmModels).toEqual({ groq: 'recall-custom', gemini: 'gemini-3.5-flash' });
    expect(snapshot()).not.toHaveProperty('selectedModel');
    expect(writes.some(w => w.key.startsWith('recall'))).toBe(false);
  });

  it('does not add Gnani or Recall credentials to the meeting registries', () => {
    const { sttRegistry, llmRegistry, providerConfigKeys } = requireFromConfig('../providers');
    expect(sttRegistry.has('gnani')).toBe(false);
    expect(llmRegistry.has('gnani')).toBe(false);
    expect(providerConfigKeys().some(f => f.configKey.startsWith('recall'))).toBe(false);
  });

  it('keeps per-store Recall model maps and meeting model maps independent', () => {
    const first = loadConfig();
    const second = loadConfig();
    first.config.setConfig('recallLlmModels', { groq: 'first-only' });
    expect(first.config.getConfig().recallLlmModels.groq).toBe('first-only');
    expect(second.config.getConfig().recallLlmModels).toEqual(defaults.recallLlmModels);
    first.config.setConfig('llmModels', { groq: 'meeting-only' });
    expect(first.config.getConfig().recallLlmModels.groq).toBe('first-only');
  });

  it('retains every Recall value when the existing settings form saves meeting preferences', () => {
    const { config } = loadConfig({ ...defaults, recallGnaniApiKey: 'test-recall-key', recallShortcut: '', recallMuted: true });
    const recallBefore = Object.fromEntries(recallKeys.map(key => [key, config.getConfig()[key]]));
    config.setMultipleConfig({ sttService: 'groq', sttModels: { groq: 'whisper-large-v3' },
      llmProvider: 'claude', llmModels: { claude: 'meeting-custom' }, llmFallback: {},
      groqApiKey: 'test-existing-key', systemPrompt: 'updated-prompt', noteOutputMode: 'markdown', theme: 'dark' });
    for (const key of recallKeys) expect(config.getConfig()[key]).toEqual(recallBefore[key]);
  });

  it.each([
    ['recallStartupMode', 'listening'], ['recallMuted', 'false'],
    ['recallSttModel', 'meeting-stt'], ['recallSttLanguage', 'auto'],
    ['recallTtsModel', 'unknown'], ['recallTtsLanguage', 'xx-XX'],
    ['recallTtsVoice', ''], ['recallShortcut', 'x'.repeat(81)],
    ['recallLlmProvider', ''], ['recallLlmModels', { groq: 123 }],
    ['recallLlmModels', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`provider${i}`, 'model']))],
    ['recallContextBudget', 0], ['recallContextBudget', 24001], ['recallContextBudget', 1000.5],
    ['recallGnaniApiKey', 'x'.repeat(4097)],
  ])('rejects invalid %s values without changing config', (key, value) => {
    const { config, snapshot } = loadConfig();
    const before = snapshot();
    expect(() => config.setConfig(key, value)).toThrow('Schema validation failed');
    expect(snapshot()).toEqual(before);
  });
});
