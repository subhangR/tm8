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
 * Both extend to the page-back walk rather than being weakened by it: a failed
 * `loadOlder` reports itself in `older` and leaves every rendered turn where it
 * was, and a page-back in flight is its own state and never a first load.
 *
 * POLLING IS THE CALLER'S CHOICE, not this hook's default. The transcript grows
 * while an agent works and is frozen forever once it exits, so a poll on a dead
 * session is pure waste — `intervalMs: null` turns it off, and every caller is
 * expected to pass the session's own liveness rather than polling blindly.
 *
 * ── WHAT ACCUMULATION MEANS HERE ────────────────────────────────────────────
 *
 * `state.page` is always the NEWEST window and every claim it makes about
 * itself — its stats, its `stuck` verdict, its `lastActivityAt`. `entries` is
 * everything the reader has walked back to, newest window last. Keeping the two
 * apart is what stops a page-back from silently restating a tail's token counts
 * over a wider set of turns than they were measured on.
 *
 * Older windows PREPEND with no dedupe, and that is safe rather than lucky: the
 * server's cursor lands on a record boundary, so consecutive windows abut. If
 * you change the boundary logic, this is the guarantee you broke.
 *
 * ── WHY THE POLL PAUSES WHILE PAGED BACK ────────────────────────────────────
 *
 * The newest window is a TAIL, so as the file grows its start SLIDES FORWARD.
 * Older windows were fetched against where it used to start, so a poll that
 * replaced the newest window under an accumulation would open a hole in the
 * middle of the reader's history — turns that exist, are not shown, and have no
 * cursor pointing at them. There is no "after" cursor to close it with (`before`
 * is the only one), so the honest move is to stop the poll while any older
 * window is held and say so. `resumeLive()` drops the walk and re-reads the
 * tail, which is the one operation that cannot leave a gap. A session that is
 * not live never polls at all, and that is the session a reader usually walks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, SessionTranscriptEntry, SessionTranscriptPage } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { TranscriptState } from './transcript-model';

export interface UseSessionTranscriptOptions {
  /** How often to re-read. `null` means read once and stop — use it for any
   *  session that is not live, whose transcript can no longer change. */
  intervalMs?: number | null;
  /** How many trailing entries to ask for per window. Also how far a page-back
   *  walks before it answers. */
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

/** The page-back walk's own state, kept apart from the first read's. */
export interface OlderRead {
  phase: 'idle' | 'loading' | 'error';
  /** Why the last walk failed. Null in every other phase. */
  message: string | null;
}

export interface SessionTranscriptRead {
  /** The NEWEST window, and every claim it makes about itself. */
  state: TranscriptState;
  /** Every turn walked back to, oldest-first. Empty until the first read lands. */
  entries: SessionTranscriptEntry[];
  /** Whether a window exists before the oldest one held. */
  hasOlder: boolean;
  /**
   * How many older windows are held. A COUNT rather than a flag because the
   * surface needs to know that a prepend just happened in order to hold the
   * reader's scroll position across it — "there are older windows" cannot
   * distinguish the second walk from the first.
   */
  olderCount: number;
  /** Whether any older window is held — the poll is paused while it is. */
  pagedBack: boolean;
  older: OlderRead;
  /** Walk one window further back. No-op while one is in flight, or at the start. */
  loadOlder: () => void;
  /** Drop the walk and re-read the tail. This is what resumes the poll. */
  resumeLive: () => void;
  /** Re-read the newest window now. Exposed so a surface can offer a real Retry
   *  rather than telling the reader to switch tabs and come back. */
  refresh: () => void;
}

const IDLE: OlderRead = { phase: 'idle', message: null };

export function useSessionTranscript(
  seam: Pick<Seam, 'transcript'>,
  sessionId: EntityId,
  { intervalMs = null, last, files }: UseSessionTranscriptOptions = {},
): SessionTranscriptRead {
  const [state, setState] = useState<TranscriptState>({ phase: 'loading' });
  /** Windows walked back to, OLDEST FIRST. Never includes the newest window. */
  const [older, setOlder] = useState<SessionTranscriptPage[]>([]);
  const [olderRead, setOlderRead] = useState<OlderRead>(IDLE);

  // Whether anything has ever landed. Governs rule 1 above, and is a ref rather
  // than state because it must not itself cause a render.
  const hasLoaded = useRef(false);

  // A read in flight when the session id changes must not land into the new
  // session's state — the reader would see another session's turns. The page-back
  // walk shares the counter, so a walk started under session A is discarded
  // just as firmly as a poll was.
  const requestSeq = useRef(0);

  /* Built rather than always-passed so a caller that asks for neither sends no
     opts at all — the shape the seam has served since before either option
     existed, and the one every fixture arm is written against. */
  const windowOpts = useCallback(
    (before?: number) => {
      const opts = {
        ...(last === undefined ? {} : { last }),
        ...(before === undefined ? {} : { before }),
        ...(files ? { files } : {}),
      };
      return Object.keys(opts).length === 0 ? undefined : opts;
    },
    [last, files],
  );

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const page = await seam.transcript(sessionId, windowOpts());
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
  }, [seam, sessionId, windowOpts]);

  // A new session is a new read from scratch — otherwise the previous session's
  // turns stay on screen under the new session's header, and its walked-back
  // history would stay under them.
  useEffect(() => {
    hasLoaded.current = false;
    setState({ phase: 'loading' });
    setOlder([]);
    setOlderRead(IDLE);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Paused while paged back — see the header. `older.length` rather than a
    // flag so the pause cannot drift out of step with what is on screen.
    if (intervalMs === null || older.length > 0) return;
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, load, older.length]);

  const newest = state.phase === 'ready' ? state.page : null;
  // The oldest window held is the one whose cursor names what comes before it.
  const oldest = older[0] ?? newest;
  const hasOlder = oldest?.hasOlder === true;

  const loadOlder = useCallback(() => {
    const cursor = oldest?.windowStart;
    if (oldest?.hasOlder !== true || cursor === null || cursor === undefined) return;
    if (olderRead.phase === 'loading') return;
    const seq = requestSeq.current;
    setOlderRead({ phase: 'loading', message: null });
    void (async () => {
      try {
        const page = await seam.transcript(sessionId, windowOpts(cursor));
        // A walk that started under a different session, or that raced a
        // refresh, must not prepend into what is on screen now.
        if (seq !== requestSeq.current) return;
        setOlder((prev) => {
          // The cursor moved under us (a resume, or a second walk that landed
          // first): dropping this window is right, because prepending it would
          // put it somewhere it does not belong.
          const currentOldest = prev[0] ?? newest;
          if (currentOldest?.windowStart !== cursor) return prev;
          return [page, ...prev];
        });
        setOlderRead(IDLE);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        // Reported, never blanking: the turns already on screen are still
        // exactly as true as they were before this read was attempted.
        setOlderRead({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Earlier turns could not be read',
        });
      }
    })();
  }, [newest, oldest, olderRead.phase, seam, sessionId, windowOpts]);

  const resumeLive = useCallback(() => {
    setOlder([]);
    setOlderRead(IDLE);
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const entries = useMemo(
    () => [...older.flatMap((p) => p.entries), ...(newest?.entries ?? [])],
    [older, newest],
  );

  return {
    state,
    entries,
    hasOlder,
    olderCount: older.length,
    pagedBack: older.length > 0,
    older: olderRead,
    loadOlder,
    resumeLive,
    refresh,
  };
}
