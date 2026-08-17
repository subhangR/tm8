// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCursorCache } from './cursor-cache.js';

describe('cursor cache', () => {
  let storage: Storage;
  beforeEach(() => {
    const values = new Map<string, string>();
    storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
      clear: () => values.clear(),
      key: (index) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    };
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('is monotonic, debounced, and scoped by boot epoch plus space', () => {
    const writes = vi.spyOn(storage, 'setItem');
    const cache = createCursorCache('node:viewer', { debounceMs: 1_000, storage });
    cache.schedule('boot-a', 'space-a', 10);
    cache.schedule('boot-a', 'space-a', 8);
    cache.schedule('boot-a', 'space-a', 12);
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(cache.read('boot-a', 'space-a')).toBe(12);
    expect(cache.read('boot-b', 'space-a')).toBeNull();
    expect(cache.read('boot-a', 'space-b')).toBeNull();
    cache.dispose();
  });

  it('flushes a pending cursor on pagehide', () => {
    const cache = createCursorCache('node:viewer', { storage });
    cache.schedule('boot-a', 'space-a', 42);
    window.dispatchEvent(new Event('pagehide'));
    const reloaded = createCursorCache('node:viewer', { storage });
    expect(reloaded.read('boot-a', 'space-a')).toBe(42);
    cache.dispose();
    reloaded.dispose();
  });

  it('rejects fractional and unsafe cursors from writes or corrupt storage', () => {
    storage.setItem('tm8.event-cursors.v1.node_viewer', JSON.stringify({
      entries: {
        'boot-a\u0000space-a': { cursor: 1.5, savedAt: Date.now() },
      },
    }));
    const cache = createCursorCache('node:viewer', { storage });
    expect(cache.read('boot-a', 'space-a')).toBeNull();
    cache.schedule('boot-a', 'space-a', Number.MAX_SAFE_INTEGER + 1);
    expect(cache.read('boot-a', 'space-a')).toBeNull();
    cache.dispose();
  });
});
