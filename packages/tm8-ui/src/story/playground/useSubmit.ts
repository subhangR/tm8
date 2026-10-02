import { useCallback, useEffect, useRef, useState } from 'react';

export type SubmitStatus = 'idle' | 'pending' | 'done' | 'error';

/** How long "done" shows before the surface closes itself. */
export const DONE_MS = 700;

/**
 * One in-flight action with its pending / done / error state. A rejected
 * action's message is shown as-is (actions.ts: "rejects with an Error whose
 * message is shown to the user"). `onDone` runs DONE_MS after success.
 */
export function useSubmit(onDone: () => void) {
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(
    () => () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setStatus('pending');
    setError(null);
    try {
      await work();
      if (!alive.current) return;
      setStatus('done');
      timer.current = setTimeout(() => done.current(), DONE_MS);
    } catch (e) {
      if (!alive.current) return;
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  return { status, error, run, busy: status === 'pending' || status === 'done' };
}
