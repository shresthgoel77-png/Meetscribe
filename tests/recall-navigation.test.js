import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Run the current owning callbacks, without mounting App or its meeting capture listeners.
const source = readFileSync(new URL('../renderer/app.jsx', import.meta.url), 'utf8');
const callbacks = source.slice(source.indexOf('  const openSession = useCallback('), source.indexOf('  // "Open notes" on the desktop meeting overlay.'));
describe('existing source navigation retains the real App unsaved-change guard', () => {
  it.each([false, true])('same-view unsaved guard allows navigation=%s', async allowed => {
    const session = { id: 'synthetic-selected-record', title: 'Fixture' };
    const ctx = { useCallback: fn => fn, viewRef: { current: 'session' }, navGuardRef: { current: vi.fn(async () => allowed) },
      requestNavigate: vi.fn(async () => true), setSessionOrigin: vi.fn(), setSelectedSession: vi.fn(),
      window: { meetscribe: { sessions: { get: vi.fn(async () => session) } } } };
    const open = vm.runInNewContext(`(function(){ ${callbacks}; return openSessionById; })()`, ctx);
    await open(session.id); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(ctx.window.meetscribe.sessions.get).toHaveBeenCalledWith(session.id);
    expect(ctx.navGuardRef.current).toHaveBeenCalledOnce(); expect(ctx.setSelectedSession).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(ctx.setSelectedSession).toHaveBeenCalledWith(session);
  });
  it('another-view navigation rejection keeps the current record unchanged', async () => {
    const ctx = { useCallback: fn => fn, viewRef: { current: 'settings' }, navGuardRef: { current: null },
      requestNavigate: vi.fn(async () => false), setSessionOrigin: vi.fn(), setSelectedSession: vi.fn(),
      window: { meetscribe: { sessions: { get: async () => ({ id: 'fixture' }) } } } };
    const open = vm.runInNewContext(`(function(){ ${callbacks}; return openSessionById; })()`, ctx);
    await open('fixture'); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(ctx.requestNavigate).toHaveBeenCalledWith('session'); expect(ctx.setSelectedSession).not.toHaveBeenCalled();
  });
});
