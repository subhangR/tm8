import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';

const SeenContext = createContext<(id: string) => void>(() => undefined);

/** Mounted once per signed-in member/space, above desktop and mobile lists. */
export function EntitySeenProvider({ commands, refreshCounts, children }: {
  commands: Seam['commands'];
  refreshCounts: () => void;
  children: ReactNode;
}) {
  const pending = useMemo(() => new Set<string>(), [commands]);
  const seen = useMemo(() => new Set<string>(), [commands]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const mark = useCallback((id: string) => {
    if (!commands.markSeen || pending.has(id) || seen.has(id)) return;
    pending.add(id);
    void Promise.resolve().then(() => commands.markSeen!(id as EntityId)).then(() => {
      seen.add(id);
      if (live.current) refreshCounts();
    }).catch(() => {
      // Navigation still succeeds. Leave the count unchanged and allow the
      // next activation to retry; never claim a failed write was persisted.
    }).finally(() => pending.delete(id));
  }, [commands, pending, seen, refreshCounts]);
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
