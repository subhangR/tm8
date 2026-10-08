import { useEffect, useMemo, useRef } from 'react';

/** Cancels a visit on an identity change, while surviving React's development effect replay. */
export function useGameIdentitySignal(server: object, spaceId: string, memberId: string | null, accountId: string | null): AbortSignal {
  const controller = useMemo(() => new AbortController(), [server, spaceId, memberId, accountId]);
  const current = useRef(controller);
  const mounted = useRef(false);
  current.current = controller;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current || current.current !== controller) controller.abort();
      });
    };
  }, [controller]);
  return controller.signal;
}
