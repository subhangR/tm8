/** Browser persistence for event cursors. Payloads never contain event data. */

export interface CursorCache {
  read(nodeBootId: string, spaceId: string): number | null;
  schedule(nodeBootId: string, spaceId: string, cursor: number): void;
  flush(): void;
  dispose(): void;
}

interface CursorEntry {
  cursor: number;
  savedAt: number;
}

interface CursorPayload {
  entries: Record<string, CursorEntry>;
}

interface CursorCacheOptions {
  storage?: Storage | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  debounceMs?: number;
  maxEntries?: number;
}

const PREFIX = 'tm8.event-cursors.v1';

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function entryKey(nodeBootId: string, spaceId: string): string {
  return `${nodeBootId}\u0000${spaceId}`;
}

/**
 * Cursors are scoped by node/viewer at the storage-key level and by node boot
 * plus space inside the payload. A database/process epoch change can therefore
 * never reuse a future cursor and skip a new sequence.
 */
export function createCursorCache(scope: string, options: CursorCacheOptions = {}): CursorCache {
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const debounceMs = options.debounceMs ?? 1_000;
  const maxEntries = options.maxEntries ?? 64;
  const key = `${PREFIX}.${scope.replace(/[^\w.-]+/g, '_')}`;

  let entries: Record<string, CursorEntry> = {};
  let timer: unknown = null;
  let dirty = false;

  try {
    const raw = storage?.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as CursorPayload;
      if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) {
        entries = parsed.entries;
      }
    }
  } catch {
    entries = {};
  }

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!dirty || !storage) return;
    dirty = false;
      const bounded = Object.entries(entries)
      .filter(([, value]) => Number.isSafeInteger(value?.cursor) && value.cursor >= 0)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, maxEntries);
    entries = Object.fromEntries(bounded);
    try {
      storage.setItem(key, JSON.stringify({ entries } satisfies CursorPayload));
    } catch {
      // Storage is an accelerator. Quota/private-mode failures cannot block
      // connection or hydration.
    }
  };

  const onPageHide = () => flush();
  try {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
  } catch {
    /* non-browser or a restricted host */
  }

  return {
    read(nodeBootId, spaceId) {
      const value = entries[entryKey(nodeBootId, spaceId)];
      return value && Number.isSafeInteger(value.cursor) && value.cursor >= 0
        ? value.cursor
        : null;
    },
    schedule(nodeBootId, spaceId, cursor) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) return;
      const id = entryKey(nodeBootId, spaceId);
      const prior = entries[id];
      if (prior && cursor <= prior.cursor) return;
      entries[id] = { cursor, savedAt: now() };
      dirty = true;
      if (timer === null) timer = setTimer(flush, debounceMs);
    },
    flush,
    dispose() {
      try {
        if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      } catch {
        /* non-browser or a restricted host */
      }
      flush();
    },
  };
}
