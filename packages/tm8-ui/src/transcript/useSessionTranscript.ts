/**
 * THE ONE TRANSCRIPT READ, lifted out of `SessionDebugBody` when the Transcript
 * surface became its second consumer.
 *
 * Two behaviours here are load-bearing and were both learned the hard way in
 * the Debug surface; they move across intact rather than being re-derived:
 *
 *  1. A FAILED POLL NEVER BLANKS A RENDERED TRANSCRIPT. Once a page has landed,
 *     a later read that throws is swallowed — the reader keeps the turns they
 *     were reading. An error is only surfaced when there is nothing to show, so
 *     a flaky node cannot repeatedly throw the surface back to an error card.
 *  2. A REFRESH IS NOT A SPINNER. `phase:'loading'` is the FIRST read only;
 *     subsequent polls resolve straight into `ready`.
 *
 * POLLING IS THE CALLER'S CHOICE, not this hook's default. The transcript grows
 * while an agent works and is frozen forever once it exits, so a poll on a dead
 * session is pure waste — `intervalMs: null` turns it off, and every caller is
 * expected to pass the session's own liveness rather than polling blindly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { TranscriptState } from './transcript-model';

export interface UseSessionTranscriptOptions {
  /** How often to re-read. `null` means read once and stop — use it for any
   *  session that is not live, whose transcript can no longer change. */
  intervalMs?: number | null;
  /** How many trailing entries to ask for. The server reads a TAIL and there is
   *  no cursor, so a larger number widens the window; it does not page back. */
  last?: number;
  /**
   * Also attach `fileChanges` — the Edit/Write calls this session's agent made,
   * parsed from the WHOLE transcript rather than the tail.
   *
   * OFF BY DEFAULT because of that word: it is a full-file scan, where the rest
   * of this read is a bounded tail. A polling caller must not ask for it; a
   * one-shot read of a session that has already ended can afford it exactly
   * once, and that is the only caller who does.
   */
  files?: boolean;
}

export interface SessionTranscriptRead {
  state: TranscriptState;
  /** Re-read now. Exposed so a surface can offer a real Retry rather than
   *  telling the reader to switch tabs and come back. */
  refresh: () => void;
}

export function useSessionTranscript(
  seam: Pick<Seam, 'transcript'>,
  sessionId: EntityId,
  { intervalMs = null, last, files }: UseSessionTranscriptOptions = {},
): SessionTranscriptRead {
  const [state, setState] = useState<TranscriptState>({ phase: 'loading' });
  // Whether anything has ever landed. Governs rule 1 above, and is a ref rather
  // than state because it must not itself cause a render.
  const hasLoaded = useRef(false);

  // A read in flight when the session id changes must not land into the new
  // session's state — the reader would see another session's turns.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      /* Built rather than always-passed so a caller that asks for neither sends
         no opts at all — the shape the seam has served since before either
         option existed, and the one every fixture arm is written against. */
      const opts = {
        ...(last === undefined ? {} : { last }),
        ...(files ? { files } : {}),
      };
      const page = await seam.transcript(
        sessionId,
        Object.keys(opts).length === 0 ? undefined : opts,
      );
      if (seq !== requestSeq.current) return;
      hasLoaded.current = true;
      setState({ phase: 'ready', page });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      // Only surface an error if we have nothing to show; a transient poll
      // failure must not blank an already-rendered transcript.
      if (!hasLoaded.current) {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Transcript read failed',
        });
      }
    }
  }, [seam, sessionId, last, files]);

  // A new session is a new read from scratch — otherwise the previous session's
  // turns stay on screen under the new session's header.
  useEffect(() => {
    hasLoaded.current = false;
    setState({ phase: 'loading' });
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { state, refresh };
}
