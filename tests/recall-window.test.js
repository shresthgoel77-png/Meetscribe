import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecallLifecycle } from '../renderer/lib/recallLifecycle.js';

const require = createRequire(import.meta.url);
const { createRecallWindowController, clampRecallBounds } = require('../electron/overlay/recall-window');
const { registerRecallIpc } = require('../electron/services/recall-ipc');
const { llmRegistry } = require('../electron/providers');
const owners = [];
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.bounds = { x: 0, y: 0, width: 420, height: 480, ...options };
    this.dead = false; this.visible = false; this.focused = false; this.minimized = false;
    const wc = new EventEmitter(); this.webContents = wc;
    wc.dead = false; wc.isDestroyed = () => wc.dead;
    wc.mainFrame = { parent: null, detached: false, send: vi.fn() };
    wc.setWindowOpenHandler = vi.fn(); wc.getURL = () => this.url;
    this.setBounds = vi.fn(bounds => { this.bounds = { ...this.bounds, ...bounds }; this.emit('resize'); });
    this.getContentSize = () => [this.bounds.width, this.bounds.height];
    this.setContentSize = vi.fn((width, height) => this.setBounds({ width, height }));
    this.setPosition = vi.fn((x, y) => { this.bounds = { ...this.bounds, x, y }; this.emit('move'); });
    this.setMinimumSize = vi.fn(); this.setMenu = vi.fn(); this.setAlwaysOnTop = vi.fn(); this.setBackgroundColor = vi.fn();
    this.show = vi.fn(() => { this.visible = true; }); this.focus = vi.fn(() => { this.focused = true; });
    this.restore = vi.fn(() => { this.minimized = false; });
    this.loadURL = vi.fn(async url => { this.url = url; });
    this.loadFile = vi.fn(async file => { this.url = require('node:url').pathToFileURL(file).href; });
  }
  isDestroyed() { return this.dead; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  getBounds() { return this.minimized ? { x: -32000, y: -32000, width: 420, height: 480 } : this.getNormalBounds(); }
  getNormalBounds() { return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, this.bounds[key]])); }
  close() { this.emit('close'); this.destroy(); }
  destroy() { if (this.dead) return; this.dead = true; this.webContents.dead = true; this.webContents.emit('destroyed'); this.emit('closed'); }
}
function setup(options = {}) {
  let displays = [{ id: 1, scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 1280, height: 720 } },
    { id: 2, scaleFactor: 2, workArea: { x: -1920, y: -200, width: 1920, height: 1080 } }];
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: -1000, y: 0 });
  screen.getDisplayNearestPoint = point => displays.find(d => point.x >= d.workArea.x && point.x < d.workArea.x + d.workArea.width) || displays[0];
  screen.getDisplayMatching = bounds => screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  const windows = [];
  class BrowserWindow extends FakeWindow { constructor(opts) { super(opts); windows.push(this); } }
  const attachWindow = vi.fn();
  const controller = createRecallWindowController({ BrowserWindow, screen, getTheme: () => 'dark', attachWindow, ...options });
  owners.push(controller);
  return { controller, screen, windows, attachWindow, replaceDisplays: next => { displays = next; } };
}
afterEach(() => { owners.splice(0).reverse().forEach(owner => owner.dispose()); vi.restoreAllMocks(); });

describe('separate Recall window ownership, paths and geometry', () => {
  it.each([true, false])('is lazy, securely configured and uses the correct dev=%s HTML/preload path', async isDev => {
    const s = setup({ isDev }); expect(s.windows).toEqual([]);
    const win = s.controller.open(); await flush();
    expect(win.options).toMatchObject({ width: 420, height: 480, focusable: true, frame: false, useContentSize: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false, webSecurity: true,
        additionalArguments: ['--meetscribe-theme=dark'] } });
    expect(win.options.webPreferences.preload).toBe(path.resolve('electron/recall-preload.js'));
    if (isDev) expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173/recall.html');
    else expect(win.loadFile).toHaveBeenCalledWith(path.resolve('dist/renderer/recall.html'));
    expect(s.attachWindow).toHaveBeenCalledWith(win);
    win.webContents.emit('did-finish-load');
    expect(win.webContents.mainFrame.send).toHaveBeenCalledWith('recall:theme', 'dark');
    expect(s.controller.open()).toBe(win); expect(s.windows).toHaveLength(1);
  });
  it('button-style open always focuses the same live window; shortcut toggles focus/close', () => {
    const s = setup(); let win = s.controller.open();
    expect(s.controller.open()).toBe(win); expect(win.dead).toBe(false);
    win.focused = false; s.controller.toggle(); expect(win.focused).toBe(true); expect(s.windows).toHaveLength(1);
    win.visible = false; s.controller.toggle(); expect(win.visible).toBe(true); expect(win.dead).toBe(false);
    s.controller.toggle(); expect(win.dead).toBe(true); expect(s.controller.getWindow()).toBeNull();
    win = s.controller.open(); expect(s.windows).toHaveLength(2); expect(win.dead).toBe(false);
    expect(s.windows.filter(w => !w.dead)).toHaveLength(1);
  });
  it('restores only Recall, preserving a hidden/minimized main window and tray behavior', () => {
    const main = new FakeWindow(); main.minimized = true;
    const s = setup({ getAnchorWindow: () => main }); const win = s.controller.open();
    win.minimized = true; win.visible = false; s.controller.open();
    expect(win.restore).toHaveBeenCalledOnce(); expect(main.restore).not.toHaveBeenCalled();
    expect(main.show).not.toHaveBeenCalled(); expect(main.focus).not.toHaveBeenCalled();
    expect(win.getBounds().x).toBeGreaterThan(-2000);
  });
  it('clamps compact/expanded bounds at negative origins in DIP without multiplying display scale', () => {
    const s = setup(); const win = s.controller.open();
    expect(win.getBounds()).toEqual({ x: -1170, y: 100, width: 420, height: 480 });
    s.controller.resize(win, 640, 800);
    expect(win.getBounds()).toEqual({ x: -1170, y: 80, width: 640, height: 800 });
    expect(s.controller.resize(new FakeWindow(), 640, 800)).toBe(false);
    expect(clampRecallBounds({ x: -5000, y: -5000, width: 640, height: 800 }, { x: -500, y: -100, width: 360, height: 300 }))
      .toEqual({ x: -500, y: -100, width: 360, height: 300 });
  });
  it('recovers from monitor removal and work-area/scaling changes, preserving other screen listeners', () => {
    const s = setup(); const outside = vi.fn(); s.screen.on('display-removed', outside);
    const win = s.controller.open(); s.controller.resize(win, 640, 800);
    s.replaceDisplays([{ id: 1, scaleFactor: 2, workArea: { x: 0, y: 30, width: 360, height: 300 } }]);
    s.screen.emit('display-removed');
    expect(win.getBounds()).toEqual({ x: 0, y: 30, width: 360, height: 300 });
    s.screen.emit('display-metrics-changed', {}, {}, ['scaleFactor']);
    expect(win.getBounds()).toEqual({ x: 0, y: 30, width: 360, height: 300 });
    s.controller.dispose(); expect(s.screen.listeners('display-removed')).toEqual([outside]);
    expect(outside).toHaveBeenCalledOnce(); expect(s.controller.open()).toBeNull();
  });
  it('keeps the measured outer window inside the work area when fractional Windows DPI adds one DIP', () => {
    const s = setup(); const win = s.controller.open();
    const original = win.getBounds.bind(win);
    win.getBounds = () => { const bounds = original(); return { ...bounds, width: bounds.width + 1, height: bounds.height + 1 }; };
    s.replaceDisplays([{ id: 1, scaleFactor: 1.25, workArea: { x: 0, y: 0, width: 1536, height: 816 } }]);
    s.controller.resize(win, 640, 800);
    expect(win.getContentSize()).toEqual([640, 800]);
    expect(win.getBounds().y + win.getBounds().height).toBeLessThanOrEqual(816);
    s.replaceDisplays([{ id: 1, scaleFactor: 1.25, workArea: { x: 0, y: 0, width: 320, height: 220 } }]);
    s.screen.emit('display-metrics-changed');
    expect(win.getContentSize()).toEqual([319, 219]);
    expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 320, height: 220 });
  });
  it('blocks navigation/new windows/webviews and cannot be held open by beforeunload', () => {
    const s = setup(); const win = s.controller.open();
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.org' })).toEqual({ action: 'deny' });
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview', 'will-prevent-unload']) {
      const event = { preventDefault: vi.fn() }; win.webContents.emit(name, event, { url: 'https://example.org' });
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    win.url = 'https://example.org'; win.webContents.emit('did-finish-load');
    expect(win.dead).toBe(true);
  });
  it.each(['close', 'render-process-gone', 'destroyed', 'unresponsive', 'escape'])('%s detaches/cancels the owner; reopen has no duplicate listeners', event => {
    const s = setup(); const win = s.controller.open();
    if (event === 'close') win.close();
    else if (event === 'destroyed') win.destroy();
    else if (event === 'escape') {
      const keyboard = { preventDefault: vi.fn() }; win.webContents.emit('before-input-event', keyboard, { type: 'keyDown', key: 'Escape' });
      expect(keyboard.preventDefault).toHaveBeenCalledOnce();
    } else if (event === 'unresponsive') win.emit(event);
    else win.webContents.emit(event, {}, { reason: 'crashed' });
    expect(s.attachWindow).toHaveBeenCalledWith(null); expect(s.controller.getWindow()).toBeNull();
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
    const next = s.controller.open(); expect(next).not.toBe(win);
    expect(next.webContents.listenerCount('did-finish-load')).toBe(1);
    expect(s.screen.listenerCount('display-metrics-changed')).toBe(1);
  });
  it('propagates only the effective theme through the current main frame', () => {
    const s = setup(); const win = s.controller.open();
    s.controller.setTheme('light');
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#F0F4F8');
    expect(win.webContents.mainFrame.send).toHaveBeenLastCalledWith('recall:theme', 'light');
    s.controller.setTheme('unknown'); expect(win.webContents.mainFrame.send).toHaveBeenLastCalledWith('recall:theme', 'light');
  });
});

describe('window controller integrated with the actual restricted IPC', () => {
  it.each(['close', 'crash', 'destroy'])('aborts main work on %s, suppresses late results and admits a fresh reopened document', async reason => {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) };
    const main = new FakeWindow(), overlay = new FakeWindow(), pending = deferred();
    const service = { ask: vi.fn(request => pending.promise.then(() => ({ requestId: request.requestId, status: 'insufficient_evidence', text: '', sources: [], claims: [] }))),
      close: vi.fn(), cancel: vi.fn(), getState: () => ({ historyTurns: 0, historyBytes: 0 }) };
    let controller;
    const ipc = registerRecallIpc({ ipcMain, getMainWindow: () => main, getOverlayWindow: () => overlay,
      getConfig: () => ({}), llmRegistry, createService: () => service,
      openRecallWindow: () => controller.open(), resizeRecallWindow: (win, width, height) => controller.resize(win, width, height),
      getShortcutState: () => 'conflict' });
    owners.push(ipc);
    const s = setup({ attachWindow: win => ipc.attachRecallWindow(win) }); controller = s.controller;
    const call = (channel, win, payload = {}) => handlers.get(channel)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { requestId: randomUUID(), ...payload });
    // Reject a foreign frame before creating a window.
    expect((await call('recall:open', new FakeWindow())).error.code).toBe('INVALID_REQUEST');
    expect(s.windows).toHaveLength(0);
    expect((await call('recall:open', overlay)).opened).toBe(true);
    const win = controller.getWindow();
    expect((await call('recall:get-state', main)).readiness.shortcut).toBe('conflict');
    const ack = await call('recall:submit-text', win, { question: 'synthetic test' });
    await flush(); const signal = service.ask.mock.calls[0][0].signal; expect(signal.aborted).toBe(false);
    if (reason === 'close') await call('recall:close', win);
    else if (reason === 'crash') win.webContents.emit('render-process-gone'); else win.destroy();
    expect(signal.aborted).toBe(true); expect(service.close).toHaveBeenCalled();
    pending.resolve(); await flush();
    expect(win.webContents.mainFrame.send.mock.calls.some(([channel]) => channel === 'recall:answer')).toBe(false);
    expect((await call('recall:submit-text', win, { question: 'stale document' })).error.code).toBe('INVALID_REQUEST');
    await call('recall:open', overlay); const reopened = controller.getWindow();
    expect((await call('recall:submit-text', reopened, { question: 'fresh document', requestId: ack.requestId })).status).toBe('running');
    await flush();
    expect(reopened.webContents.mainFrame.send.mock.calls.some(([channel]) => channel === 'recall:answer')).toBe(true);
  });
});

describe('sandboxed Recall preload and renderer teardown', () => {
  function preload(file) {
    let bridge;
    const ipcRenderer = new EventEmitter(); ipcRenderer.invoke = vi.fn(async () => ({ status: 'complete' })); ipcRenderer.send = vi.fn();
    vm.runInNewContext(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      require: name => { if (name !== 'electron') throw new Error('Unexpected preload import'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }; },
      process: { argv: ['--meetscribe-theme=dark'] },
    });
    return { bridge, ipcRenderer };
  }
  it('exposes exactly named Recall methods/listeners with secret-free startup theme, never event objects', async () => {
    const { bridge, ipcRenderer } = preload('../electron/recall-preload.js');
    expect(Object.keys(bridge).sort()).toEqual(['startupTheme', 'open', 'close', 'getState', 'submitText', 'submitAudio', 'cancel', 'setMuted', 'openSource', 'resize', 'onStage', 'onAnswer', 'onAudio', 'onError', 'onTheme'].sort());
    expect(bridge.startupTheme).toBe('dark');
    for (const [method, channel] of Object.entries({ open: 'open', close: 'close', getState: 'get-state', submitText: 'submit-text', submitAudio: 'submit-audio', cancel: 'cancel', setMuted: 'set-muted', openSource: 'open-source', resize: 'resize' })) {
      const payload = { requestId: randomUUID() }; await bridge[method](payload, 'ignored');
      expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(`recall:${channel}`, payload);
    }
    for (const [method, event] of Object.entries({ onStage: 'stage', onAnswer: 'answer', onAudio: 'audio', onError: 'error', onTheme: 'theme' })) {
      const callback = vi.fn(), off = bridge[method](callback), payload = event === 'theme' ? 'light' : { requestId: randomUUID() };
      ipcRenderer.emit(`recall:${event}`, { sender: 'must-not-cross-bridge' }, payload);
      expect(callback).toHaveBeenCalledWith(payload); off(); off(); expect(ipcRenderer.listenerCount(`recall:${event}`)).toBe(event === 'theme' ? 1 : 0);
    }
    expect(() => bridge.onTheme('not a function')).toThrow(); expect(ipcRenderer.send).not.toHaveBeenCalled();
  });
  it('retains a valid theme sent before React subscribes; later subscriptions do not duplicate IPC listeners', () => {
    const { bridge, ipcRenderer } = preload('../electron/recall-preload.js');
    ipcRenderer.emit('recall:theme', {}, 'light'); ipcRenderer.emit('recall:theme', {}, 'untrusted');
    const callback = vi.fn(), off = bridge.onTheme(callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith('light');
    expect(ipcRenderer.listenerCount('recall:theme')).toBe(1); off();
    ipcRenderer.emit('recall:theme', {}, 'dark'); expect(callback).toHaveBeenCalledOnce();
    const next = vi.fn(); bridge.onTheme(next)(); expect(next).toHaveBeenCalledExactlyOnceWith('dark');
    expect(ipcRenderer.listenerCount('recall:theme')).toBe(1);
  });
  it('overlay adds only an open capability, preserving old wrappers', async () => {
    const { bridge, ipcRenderer } = preload('../electron/overlay-preload.js');
    const payload = { requestId: randomUUID() }; await bridge.openRecall(payload);
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('recall:open', payload);
    expect(bridge.submitText).toBeUndefined(); expect(bridge.closeRecall).toBeUndefined();
    for (const method of ['start', 'stop', 'dismiss', 'keepRecording', 'openSession', 'move', 'closed', 'resize', 'onState', 'onTheme']) expect(bridge[method]).toBeTypeOf('function');
  });
  it.each(['escape', 'beforeunload', 'pagehide', 'close', 'dispose'])('%s releases only registered Recall resources and removes listeners once', async reason => {
    const target = new EventEmitter(); target.addEventListener = target.on.bind(target); target.removeEventListener = target.removeListener.bind(target);
    let theme;
    const off = vi.fn(), api = { onTheme: callback => { theme = callback; return off; }, close: vi.fn(async () => ({ status: 'complete' })) };
    const applyTheme = vi.fn(), micStop = vi.fn(), playerStop = vi.fn(), meetingStop = vi.fn();
    const owner = createRecallLifecycle({ api, target, onTheme: applyTheme });
    owner.addCleanup(micStop); owner.addCleanup(playerStop);
    theme('dark'); theme('arbitrary'); expect(applyTheme).toHaveBeenCalledExactlyOnceWith('dark');
    if (reason === 'escape') target.emit('keydown', { key: 'Escape', preventDefault: vi.fn() });
    else if (reason === 'close') await owner.close();
    else if (reason === 'dispose') owner.dispose(); else target.emit(reason);
    owner.dispose(); theme('light');
    expect(micStop).toHaveBeenCalledOnce(); expect(playerStop).toHaveBeenCalledOnce(); expect(meetingStop).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledOnce(); expect(target.eventNames()).toEqual([]);
    expect(api.close).toHaveBeenCalledTimes(['escape', 'close'].includes(reason) ? 1 : 0);
    const late = vi.fn(); owner.addCleanup(late); expect(late).toHaveBeenCalledOnce();
  });
});
