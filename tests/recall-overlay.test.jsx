/* global window */
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeetingOverlay from '../renderer/components/overlay/MeetingOverlay.jsx';

const state = vi.hoisted(() => {
  const api = Object.fromEntries(['start', 'stop', 'dismiss', 'keepRecording', 'openSession', 'resize', 'move', 'closed', 'openRecall'].map(name => [name, vi.fn(async () => ({ status: 'complete' }))]));
  globalThis.window = { meetscribeOverlay: api };
  return { api, index: 0, mode: 'recording' };
});
// Exercise the actual overlay's element tree and click/drag handlers. Animation/DOM geometry
// still need desktop verification; these hooks only place each existing mode on screen.
vi.mock('react', async importOriginal => ({ ...await importOriginal(),
  useState: initial => {
    const value = [{ mode: state.mode, sessionId: 'synthetic-session', startedAt: 1, meeting: { title: 'Synthetic fixture' } }, 'open', 0, false, ''][state.index++];
    return [value ?? (typeof initial === 'function' ? initial() : initial), vi.fn()];
  },
  useRef: initial => ({ current: initial }), useCallback: callback => callback, useEffect: () => {},
}));
function render(mode) {
  state.index = 0; state.mode = mode;
  const tree = MeetingOverlay(), nodes = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!React.isValidElement(node)) return;
    nodes.push(node); visit(node.props.children);
  };
  visit(tree);
  return { tree, nodes, button: label => nodes.find(node => node.props.label === label ||
    (node.type?.name === 'Close' && label === (node.props.label || 'Hide')) ||
    (node.type === 'button' && [node.props.children].flat().filter(child => typeof child === 'string').join('').trim() === label)) };
}
afterEach(() => vi.clearAllMocks());
describe('small Recall overlay action and preservation', () => {
  it.each(['prompt', 'recording', 'ended', 'processing', 'complete', 'error'])('adds one accessible open-only action in %s, preserving existing mode controls', async mode => {
    const s = render(mode), assistant = s.button('Open Meeting Recall');
    expect(s.nodes.filter(node => node.props.label === 'Open Meeting Recall')).toHaveLength(1);
    expect(assistant.props.title).toBe('Open Meeting Recall');
    assistant.props.onClick(); await Promise.resolve();
    expect(state.api.openRecall).toHaveBeenCalledWith({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(state.api.stop).not.toHaveBeenCalled(); expect(state.api.dismiss).not.toHaveBeenCalled();
    if (mode === 'prompt') { await s.button('Record').props.onClick(); expect(state.api.start).toHaveBeenCalledOnce(); }
    if (mode === 'recording' || mode === 'ended') { await s.button('Stop').props.onClick(); expect(state.api.stop).toHaveBeenCalledOnce(); }
    if (mode === 'ended') { s.button('Keep').props.onClick(); expect(state.api.keepRecording).toHaveBeenCalledOnce(); }
    if (mode === 'complete' || mode === 'error') { s.button('Open').props.onClick(); expect(state.api.openSession).toHaveBeenCalledWith('synthetic-session'); }
    if (mode !== 'ended') {
      s.button(mode === 'prompt' ? 'Not now' : 'Hide').props.onClick(); expect(state.api.dismiss).toHaveBeenCalledOnce();
    }
  });
  it('a button press never captures drag; background drag keeps the existing horizontal delta', () => {
    const { tree } = render('recording');
    const capture = vi.fn(), release = vi.fn();
    tree.props.onPointerDown({ target: { closest: () => true }, currentTarget: { setPointerCapture: capture } });
    expect(capture).not.toHaveBeenCalled();
    tree.props.onPointerDown({ target: { closest: () => null }, currentTarget: { setPointerCapture: capture }, pointerId: 4, screenX: 200 });
    tree.props.onPointerMove({ screenX: 215 }); expect(state.api.move).toHaveBeenCalledWith(15);
    tree.props.onPointerUp({ pointerId: 4, currentTarget: { releasePointerCapture: release } }); expect(release).toHaveBeenCalledWith(4);
  });
  it('keeps the main overlay non-focusable/showInactive and synchronizes all CSS widths', () => {
    const source = readFileSync(new URL('../electron/overlay/overlay-window.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../renderer/styles/overlay.css', import.meta.url), 'utf8');
    expect(source).toContain('focusable: false'); expect(source).toContain('win.showInactive()');
    expect(source).toContain('const WIDTH = 400;');
    expect(css.match(/width: 400px/g)).toHaveLength(3); expect(css).toContain('.overlay-row { width: 380px; }');
  });
  it('adds a distinct Recall entry/CSP without relaxing unrelated pages or exposing browser network providers', () => {
    const html = readFileSync(new URL('../renderer/recall.html', import.meta.url), 'utf8');
    expect(html).toContain("default-src 'none'"); expect(html).toContain("media-src 'self' blob:");
    expect(html).toContain("frame-src 'none'"); expect(html).toContain('window.meetscribeRecall?.startupTheme');
    expect(html).not.toContain('unsafe-eval'); expect(html).not.toContain('https:');
    expect(readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8')).toContain("recall: path.resolve(__dirname, 'renderer/recall.html')");
    expect(window.meetscribeOverlay).toBe(state.api);
  });
});
