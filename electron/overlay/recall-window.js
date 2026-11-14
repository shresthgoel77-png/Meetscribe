// Main-only Recall window owner. Importing this module constructs nothing.
const path = require('path');
const { pathToFileURL } = require('url');

// Electron screen/window rectangles are device-independent pixels, including negative origins.
function clampRecallBounds(bounds, area) {
  const width = Math.max(1, Math.min(Math.round(bounds.width), Math.floor(area.width)));
  const height = Math.max(1, Math.min(Math.round(bounds.height), Math.floor(area.height)));
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds.y))), width, height };
}

function createRecallWindowController(deps) {
  const { BrowserWindow, screen, attachWindow, getTheme, getAnchorWindow = () => null,
    isDev = process.env.NODE_ENV === 'development' } = deps;
  let win = null, disposed = false, adjusting = false;
  let theme = getTheme() === 'dark' ? 'dark' : 'light';
  const alive = () => win && !win.isDestroyed() && !win.webContents.isDestroyed();
  const normal = target => target.isMinimized() ? target.getNormalBounds() : target.getBounds();
  const displayFor = bounds => bounds ? screen.getDisplayMatching(bounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sendTheme = () => {
    try { if (alive()) win.webContents.mainFrame.send('recall:theme', theme); } catch { /* renderer teardown */ }
  };
  function clamp(size) {
    if (!alive() || adjusting) return;
    const before = normal(win);
    const area = displayFor(before).workArea;
    adjusting = true;
    try {
      // Windows at fractional DPI can add a non-client DIP even to frameless windows.
      // Requests are CSS content sizes; containment must use the measured OUTER rectangle.
      let [contentWidth, contentHeight] = win.getContentSize();
      const extraWidth = Math.max(0, before.width - contentWidth);
      const extraHeight = Math.max(0, before.height - contentHeight);
      const availableWidth = Math.max(1, Math.floor(area.width - extraWidth));
      const availableHeight = Math.max(1, Math.floor(area.height - extraHeight));
      win.setMinimumSize(Math.min(320, availableWidth), Math.min(220, availableHeight));
      const width = Math.min(size?.width ?? contentWidth, 640, availableWidth);
      const height = Math.min(size?.height ?? contentHeight, 800, availableHeight);
      if (width !== contentWidth || height !== contentHeight) win.setContentSize(width, height);
      // Account for a native rounding step after sizing, without converting DIP to pixels.
      for (let pass = 0; pass < 3; pass++) {
        const actual = normal(win);
        if (actual.width <= area.width && actual.height <= area.height) break;
        [contentWidth, contentHeight] = win.getContentSize();
        win.setContentSize(Math.max(1, contentWidth - Math.max(0, actual.width - area.width)),
          Math.max(1, contentHeight - Math.max(0, actual.height - area.height)));
      }
      const actual = normal(win);
      const next = clampRecallBounds(actual, area);
      // Position-only changes must not feed outer dimensions back as content dimensions.
      if (next.x !== actual.x || next.y !== actual.y) win.setPosition(next.x, next.y);
    } finally { adjusting = false; }
  }
  function create() {
    const anchor = getAnchorWindow();
    const area = displayFor(anchor && !anchor.isDestroyed() ? normal(anchor) : null).workArea;
    const bounds = clampRecallBounds({ x: area.x + (area.width - 420) / 2,
      y: area.y + (area.height - 480) / 2, width: 420, height: 480 }, area);
    theme = getTheme() === 'dark' ? 'dark' : 'light';
    const target = new BrowserWindow({ ...bounds, useContentSize: true, frame: false,
      title: 'MeetScribe — Meeting Recall', backgroundColor: theme === 'dark' ? '#080C16' : '#F0F4F8',
      show: false, focusable: true, skipTaskbar: true, minimizable: false, maximizable: false,
      fullscreenable: false, resizable: true, maxWidth: 640, maxHeight: 800,
      minWidth: Math.min(320, area.width), minHeight: Math.min(220, area.height),
      webPreferences: { preload: path.join(__dirname, '..', 'recall-preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
        allowRunningInsecureContent: false, additionalArguments: [`--meetscribe-theme=${theme}`] },
    });
    win = target;
    target.setMenu(null);
    target.setAlwaysOnTop(true, 'floating');
    const file = path.join(__dirname, '../../dist/renderer/recall.html');
    const allowedUrl = isDev ? 'http://localhost:5173/recall.html' : pathToFileURL(file).href;
    const wc = target.webContents;
    const block = event => event.preventDefault();
    const detach = () => { if (win === target) attachWindow(null); };
    let ending = false;
    const gone = () => {
      if (ending) return; ending = true;
      detach();
      if (!target.isDestroyed()) target.destroy();
      if (win === target) win = null;
    };
    const finish = () => {
      detach(); if (win === target) win = null;
      wc.removeListener('will-navigate', block); wc.removeListener('will-frame-navigate', block);
      wc.removeListener('will-redirect', block); wc.removeListener('will-attach-webview', block);
      wc.removeListener('will-prevent-unload', block); wc.removeListener('render-process-gone', gone);
      wc.removeListener('destroyed', gone); wc.removeListener('did-finish-load', loaded);
      wc.removeListener('before-input-event', keyboard);
      target.removeListener('move', moved); target.removeListener('resize', moved);
      target.removeListener('close', detach); target.removeListener('unresponsive', gone);
    };
    const loaded = () => {
      // Defense in depth against an unexpected programmatic load/redirect.
      if (wc.getURL() !== allowedUrl) { gone(); return; }
      sendTheme();
    };
    const keyboard = (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); target.close(); }
    };
    const moved = () => clamp();
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview', 'will-prevent-unload']) wc.on(name, block);
    wc.on('before-input-event', keyboard); wc.on('did-finish-load', loaded);
    wc.on('render-process-gone', gone); wc.on('destroyed', gone);
    target.on('move', moved); target.on('resize', moved); target.on('close', detach);
    target.on('unresponsive', gone); target.once('closed', finish);
    attachWindow(target); // Actual capability owner is attached before the renderer can invoke.
    const loading = isDev ? target.loadURL(allowedUrl) : target.loadFile(file);
    void loading.catch(gone);
  }
  const screensChanged = () => clamp();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, screensChanged);
  return {
    open() {
      if (disposed) return null;
      if (!alive()) create();
      if (!alive()) return null;
      if (win.isMinimized()) win.restore();
      clamp(); win.show(); win.focus(); return win;
    },
    toggle() {
      if (alive() && win.isVisible() && win.isFocused() && !win.isMinimized()) win.close();
      else this.open();
    },
    resize(target, width, height) {
      if (!alive() || target !== win) return false;
      clamp({ width, height }); return true;
    },
    setTheme(value) {
      theme = value === 'dark' ? 'dark' : 'light';
      if (alive()) { win.setBackgroundColor(theme === 'dark' ? '#080C16' : '#F0F4F8'); sendTheme(); }
    },
    getWindow: () => alive() ? win : null,
    dispose() {
      if (disposed) return; disposed = true;
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, screensChanged);
      if (win) { attachWindow(null); if (!win.isDestroyed()) win.destroy(); win = null; }
    },
  };
}
module.exports = { createRecallWindowController, clampRecallBounds };
