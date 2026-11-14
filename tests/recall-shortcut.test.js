import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createRecallShortcutController } = require('../electron/services/recall-shortcut');
// Execute only the current pure config validator, never construct the profile store.
const configSource = readFileSync(new URL('../electron/utils/config.js', import.meta.url), 'utf8');
const validatorSource = configSource.slice(configSource.indexOf('function validateRecallShortcut('), configSource.indexOf('\nfunction setConfig('));
const validateShortcut = vm.runInNewContext(`${validatorSource}\nvalidateRecallShortcut`, { recallShortcut: require('../electron/utils/recall-shortcut.json') });
function setup(initial = 'Ctrl+Shift+Space') {
  const order = [], callbacks = new Map(), occupied = new Set(['Alt+F12']);
  const globalShortcut = {
    register: vi.fn((value, callback) => { order.push(`register:${value}`); if (occupied.has(value)) return false; callbacks.set(value, callback); return true; }),
    unregister: vi.fn(value => { order.push(`unregister:${value}`); callbacks.delete(value); }),
  };
  const toggle = vi.fn();
  const manager = createRecallShortcutController({ globalShortcut, validateShortcut, toggle, platform: 'win32' });
  const stored = { recallShortcut: initial, theme: 'light', llmProvider: 'gemini', sttService: 'google' };
  const persist = vi.fn(updates => { order.push('persist'); Object.assign(stored, updates); });
  manager.start(initial);
  return { manager, stored, persist, globalShortcut, callbacks, occupied, order, toggle };
}

describe('owned Recall global shortcut', () => {
  it('registers only the saved binding once; callback toggles Recall; quit unregisters only its binding', () => {
    const s = setup(); expect(s.manager.getState()).toBe('registered');
    s.manager.start('Ctrl+Other'); expect(s.globalShortcut.register).toHaveBeenCalledOnce();
    const callback = s.callbacks.get(s.stored.recallShortcut); callback(); expect(s.toggle).toHaveBeenCalledOnce();
    s.manager.dispose(); s.manager.dispose(); callback();
    expect(s.globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Ctrl+Shift+Space');
    expect(s.toggle).toHaveBeenCalledOnce(); expect(s.occupied.has('Alt+F12')).toBe(true);
    expect(s.globalShortcut.unregisterAll).toBeUndefined();
  });
  it('acquires replacement, persists it, then releases old; no unsaved probe occurs', () => {
    const s = setup(); const unsaved = { recallShortcut: 'Ctrl+Alt+K' };
    expect(s.globalShortcut.register).toHaveBeenCalledOnce();
    expect(s.manager.save(unsaved, s.persist)).toEqual({ applied: unsaved });
    expect(s.order).toEqual(['register:Ctrl+Shift+Space', 'register:Ctrl+Alt+K', 'persist', 'unregister:Ctrl+Shift+Space']);
    expect(s.stored.recallShortcut).toBe('Ctrl+Alt+K'); s.manager.dispose();
    expect(s.globalShortcut.unregister).toHaveBeenLastCalledWith('Ctrl+Alt+K');
  });
  it.each(['false', 'throw'])('conflict (%s) preserves binding/preference, saves unrelated fields, reports a safe actionable error', kind => {
    const s = setup();
    if (kind === 'throw') s.globalShortcut.register.mockImplementationOnce(() => { throw new Error('private OS details'); });
    const result = s.manager.save({ recallShortcut: 'Alt+F12', theme: 'dark', recallMuted: true }, s.persist);
    expect(result.error.code).toBe('SHORTCUT_CONFLICT');
    expect(result.error.message).toContain('Disable shortcut'); expect(result.error.message).not.toContain('private');
    expect(result.applied).toEqual({ theme: 'dark', recallMuted: true });
    expect(s.stored).toMatchObject({ recallShortcut: 'Ctrl+Shift+Space', theme: 'dark', recallMuted: true });
    expect(s.globalShortcut.unregister).not.toHaveBeenCalled(); expect(s.manager.getState()).toBe('registered');
    s.callbacks.get('Ctrl+Shift+Space')(); expect(s.toggle).toHaveBeenCalledOnce(); s.manager.dispose();
  });
  it('a failed config write releases only the provisional binding and keeps the old registration', () => {
    const s = setup(); s.persist.mockImplementationOnce(() => { throw new Error('Synthetic store failure'); });
    expect(() => s.manager.save({ recallShortcut: 'Ctrl+K' }, s.persist)).toThrow('Synthetic store failure');
    expect(s.globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Ctrl+K');
    expect(s.stored.recallShortcut).toBe('Ctrl+Shift+Space'); expect(s.callbacks.has('Ctrl+Shift+Space')).toBe(true); s.manager.dispose();
  });
  it('blank disables only Recall and supports explicit conflict recovery/re-enable', () => {
    const s = setup('Alt+F12'); expect(s.manager.getState()).toBe('conflict');
    expect(s.stored.recallShortcut).toBe('Alt+F12');
    s.manager.save({ recallShortcut: '' }, s.persist); expect(s.manager.getState()).toBe('disabled');
    expect(s.globalShortcut.unregister).not.toHaveBeenCalled();
    s.manager.save({ recallShortcut: 'Ctrl+K' }, s.persist); expect(s.manager.getState()).toBe('registered');
    s.manager.save({ recallShortcut: '' }, s.persist); expect(s.globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Ctrl+K'); s.manager.dispose();
  });
  it('invalid startup retains the saved value and reports invalid without registration; empty starts disabled', () => {
    const invalid = setup('Ctrl+Bogus'); expect(invalid.manager.getState()).toBe('invalid');
    expect(invalid.globalShortcut.register).not.toHaveBeenCalled(); expect(invalid.stored.recallShortcut).toBe('Ctrl+Bogus'); invalid.manager.dispose();
    const disabled = setup(''); expect(disabled.manager.getState()).toBe('disabled'); expect(disabled.globalShortcut.register).not.toHaveBeenCalled(); disabled.manager.dispose();
  });
  it('rejects invalid saved syntax while preserving other settings and the owned binding', () => {
    const s = setup(); const result = s.manager.save({ recallShortcut: 'Ctrl+', recallMuted: true }, s.persist);
    expect(result.error.message).toContain('Invalid Recall shortcut');
    expect(s.globalShortcut.register).toHaveBeenCalledOnce(); expect(s.stored.recallShortcut).toBe('Ctrl+Shift+Space');
    expect(s.stored.recallMuted).toBe(true); s.manager.dispose();
  });
  it('alias/case/order-only changes do not conflict with or release the app’s own binding', () => {
    const s = setup(); s.manager.save({ recallShortcut: 'shift+COMMANDORCONTROL+space' }, s.persist);
    expect(s.globalShortcut.register).toHaveBeenCalledOnce(); expect(s.globalShortcut.unregister).not.toHaveBeenCalled();
    expect(s.stored.recallShortcut).toBe('shift+COMMANDORCONTROL+space');
    s.manager.dispose(); expect(s.globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Ctrl+Shift+Space');
  });
  it('ordinary config writes preserve the provider selections and never touch global bindings', () => {
    const s = setup(); s.manager.save({ theme: 'dark' }, s.persist);
    expect(s.globalShortcut.register).toHaveBeenCalledOnce(); expect(s.globalShortcut.unregister).not.toHaveBeenCalled();
    expect(s.stored).toMatchObject({ theme: 'dark', llmProvider: 'gemini', sttService: 'google' }); s.manager.dispose();
  });
});

describe('actual main Settings save adapter and unchanged side effects', () => {
  function mainAdapter(s) {
    const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    const start = source.indexOf('function saveSettingsWithRecall('), end = source.indexOf('\nfunction registerIpcHandlers()', start);
    const context = { recallShortcuts: s.manager, recallWindowController: { setTheme: vi.fn() },
      setConfig: vi.fn((key, value) => { s.stored[key] = value; }),
      setMultipleConfig: vi.fn(values => { Object.assign(s.stored, values); }),
      applyAutoLaunch: vi.fn(), applyMeetingDetection: vi.fn(), setOverlayTheme: vi.fn(),
      installDisplayMediaHandler: vi.fn(), resolveEffectiveTheme: value => value === 'system' ? 'dark' : value };
    const save = vm.runInNewContext(`${source.slice(start, end)}\nsaveSettingsWithRecall`, context);
    return { save, context };
  }
  it('on conflict applies all unrelated writes and their side effects before returning the error', () => {
    const s = setup(), { save, context } = mainAdapter(s);
    expect(() => save({ recallShortcut: 'Alt+F12', autoLaunch: false, meetingDetection: false, theme: 'system', macCaptureStrategy: 'auto' })).toThrow('SHORTCUT_CONFLICT');
    expect(s.stored).toMatchObject({ recallShortcut: 'Ctrl+Shift+Space', autoLaunch: false, meetingDetection: false, theme: 'system' });
    expect(context.applyAutoLaunch).toHaveBeenCalledWith(false); expect(context.applyMeetingDetection).toHaveBeenCalledWith(false);
    expect(context.setOverlayTheme).toHaveBeenCalledWith('dark'); expect(context.recallWindowController.setTheme).toHaveBeenCalledWith('dark');
    expect(context.installDisplayMediaHandler).toHaveBeenCalledOnce(); s.manager.dispose();
  });
  it('persists shortcut last; a rejected unrelated field cannot leave the provisional shortcut saved', () => {
    const s = setup(), { save, context } = mainAdapter(s);
    context.setMultipleConfig.mockImplementationOnce(() => { throw new Error('Synthetic schema rejection'); });
    expect(() => save({ recallShortcut: 'Ctrl+K', recallMuted: 'invalid' })).toThrow('Synthetic schema rejection');
    expect(context.setConfig).not.toHaveBeenCalled(); expect(s.stored.recallShortcut).toBe('Ctrl+Shift+Space');
    expect(s.globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Ctrl+K'); s.manager.dispose();
  });
  it('keeps single-key and multi-key config routes, and leaves unrelated writes untouched', () => {
    const s = setup(), { save, context } = mainAdapter(s);
    expect(save({ theme: 'light' }, true)).toBe(true);
    expect(context.setConfig).toHaveBeenCalledWith('theme', 'light');
    expect(save({ llmProvider: 'claude', meetingDetection: true })).toBe(true);
    expect(context.setMultipleConfig).toHaveBeenLastCalledWith({ llmProvider: 'claude', meetingDetection: true });
    expect(context.applyMeetingDetection).toHaveBeenCalledWith(true); s.manager.dispose();
  });
});
