// Renderer-owned resources register their own disposers here in later UI stages. Never stop
// meeting resources or depend on a remote cancellation reply to release local audio.
export function createRecallLifecycle({ api, target = window, onTheme, onCloseError = () => {} }) {
  let disposed = false;
  const cleanups = new Set();
  const addCleanup = cleanup => {
    if (disposed) cleanup(); else cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
  };
  const dispose = () => {
    if (disposed) return; disposed = true;
    for (const cleanup of cleanups) { try { cleanup(); } catch { /* keep releasing other owned resources */ } }
    cleanups.clear();
  };
  const close = async () => {
    dispose();
    try {
      const reply = await api.close({ requestId: crypto.randomUUID() });
      if (reply?.status !== 'complete') onCloseError();
    } catch { onCloseError(); }
  };
  const key = event => { if (event.key === 'Escape' && !event.repeat) { event.preventDefault(); void close(); } };
  target.addEventListener('keydown', key);
  target.addEventListener('beforeunload', dispose); target.addEventListener('pagehide', dispose);
  addCleanup(() => {
    target.removeEventListener('keydown', key);
    target.removeEventListener('beforeunload', dispose); target.removeEventListener('pagehide', dispose);
  });
  addCleanup(api.onTheme(theme => { if (!disposed && ['light', 'dark'].includes(theme)) onTheme(theme); }));
  return { dispose, close, addCleanup };
}
