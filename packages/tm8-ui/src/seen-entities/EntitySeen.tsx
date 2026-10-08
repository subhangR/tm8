import { createContext, useCallback, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';

const SeenContext = createContext<(id: string) => void>(() => undefined);

/** Reset personal caches per member/space without remounting the lists. */
export function EntitySeenProvider({ commands, refreshCounts, scopeKey, children }: {
  commands: Seam['commands'];
  refreshCounts: () => void;
  scopeKey?: string;
  children: ReactNode;
}) {
  const cache = useMemo(() => ({
    pending: new Set<string>(),
    seen: new Set<string>(),
    live: false,
  }), [commands, scopeKey]);
  // Retire the old scope and activate the new one during commit, before a
  // post-commit activation can queue a seen write against an inactive cache.
  useLayoutEffect(() => {
    cache.live = true;
    return () => { cache.live = false; };
  }, [cache]);
  const mark = useCallback((id: string) => {
    if (!commands.markSeen || cache.pending.has(id) || cache.seen.has(id)) return;
    cache.pending.add(id);
    void Promise.resolve().then(() => cache.live ? commands.markSeen!(id as EntityId) : undefined).then(() => {
      if (!cache.live) return;
      cache.seen.add(id);
      refreshCounts();
    }).catch(() => {
      // Navigation still succeeds. Leave the count unchanged and allow the
      // next activation to retry; never claim a failed write was persisted.
    }).finally(() => cache.pending.delete(id));
  }, [commands, cache, refreshCounts]);
  return <SeenContext.Provider value={mark}>{children}</SeenContext.Provider>;
}

export const useMarkEntitySeen = () => useContext(SeenContext);

/** Only list selection uses this wrapper; generic entity navigation does not. */
export function useEntityListSelection(select: ((id: string) => void) | undefined) {
  const mark = useMarkEntitySeen();
  const activate = useCallback((id: string) => {
    select?.(id);
    mark(id);
  }, [select, mark]);
  return select ? activate : undefined;
}
