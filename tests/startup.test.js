import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

describe('single-instance startup', () => {
  it('returns before loading profile services or scheduling initialization when the lock is denied', () => {
    const app = {
      getPath: vi.fn(() => 'profile-root'),
      setPath: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn(),
    };
    const loaded = [];
    const entry = vm.runInNewContext(
      `(function(require, process) { ${readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')}\n})`,
    );
    entry((id) => {
      if (id === 'electron') return { app };
      if (['path', 'fs', 'stream'].includes(id)) return require(id);
      loaded.push(id);
      throw new Error(`Secondary instance loaded ${id}`);
    }, { argv: [] });
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(loaded).toEqual([]);
  });
});
