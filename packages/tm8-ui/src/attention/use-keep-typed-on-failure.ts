/**
 * Keep what the person TYPED when the command it rode on fails.
 *
 * The module's `resolve` and `reply` never throw: a failure puts the rows back
 * and sets `api.error` (attention-commands.ts). A surface that cleared its note
 * on submit would therefore lose the note on exactly the path where it has to
 * be typed again. So: stash on submit, clear optimistically, and restore the
 * stash if one of the command's own failure messages appears shortly after.
 */
import { useEffect, useRef } from 'react';
import type { AttentionApi } from './index';

const FAILURE = /^(Couldn't resolve|Resolved only part|Couldn't send the reply)/;
const WINDOW_MS = 15_000;

export function useKeepTypedOnFailure(api: AttentionApi | null, restore: (text: string) => void) {
  const stash = useRef<{ text: string; at: number } | null>(null);
  const error = api?.error ?? null;
  useEffect(() => {
    const held = stash.current;
    if (!held || !error || !FAILURE.test(error)) return;
    stash.current = null;
    if (Date.now() - held.at <= WINDOW_MS) restore(held.text);
    // `restore` is a state setter wrapper; the error transition is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  return (text: string) => {
    stash.current = text ? { text, at: Date.now() } : null;
  };
}
