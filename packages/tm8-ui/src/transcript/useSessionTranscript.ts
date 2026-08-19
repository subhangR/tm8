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

/**
 * The page-back walk's own state, kept apart from the first read's.
 *
 * `stalled` is not a failure and must not be drawn as one. The read succeeded;
 * it simply could not STEP, because a single record larger than the server's
 * read budget spans the whole window and a byte cursor cannot land inside a
 * record. The walk is over at that point and saying so is the honest end —
 * retrying would ask for the same bytes forever.
 */
export interface OlderRead {
  phase: 'idle' | 'loading' | 'error' | 'stalled';
  /** Why the last walk failed or stopped. Null when idle or loading. */
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

  /*
   * TWO COUNTERS, BECAUSE A POLL AND A WALK INVALIDATE DIFFERENT THINGS.
   *
   * `generation` moves only when the ACCUMULATION itself stops being valid: a
   * new session, or a resume. Both a tail read and a walk check it, and both
   * are discarded when it moves.
   *
   * `loadSeq` orders the tail reads among THEMSELVES, so an overtaken poll
   * cannot land after a newer one.
   *
   * They were one counter, and that was a bug worth recording. `load()`
   * incremented it, a walk read it, and a 5s poll landing inside the first
   * page-back therefore discarded the fetched window AND left the walk stuck
   * in `loading` — with the button replaced by "Reading earlier turns…", the
   * sentinel disabled, `loadOlder` early-returning on the same phase, and
   * `pagedBack` still false so the resume control was not rendered either. No
   * way out but switching sessions. A poll invalidates no walk; it is a
   * different read of a different window.
   */
  const generation = useRef(0);
  const loadSeq = useRef(0);

  /**
   * The cursor a walk stalled AT, so the refusal is scoped to the bytes that
   * earned it rather than to the session.
   *
   * A stall taken on the FIRST walk happens while `older.length` is still 0,
   * so the poll is running again the moment the walk ends and can replace the
   * tail with a window starting somewhere else. That new cursor has not
   * refused anything — but a session-wide `phase: 'stalled'` would go on
   * refusing on its behalf, and the reader could not walk at all. The effect
   * below lifts the refusal as soon as the cursor it belongs to is no longer
   * the one on offer.
   */
  const stalledAt = useRef<number | null>(null);

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
    const gen = generation.current;
    const seq = ++loadSeq.current;
    const stale = () => gen !== generation.current || seq !== loadSeq.current;
    try {
      const page = await seam.transcript(sessionId, windowOpts());
      if (stale()) return;
      hasLoaded.current = true;
      setState({ phase: 'ready', page });
    } catch (err) {
      if (stale()) return;
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
    generation.current += 1;
    stalledAt.current = null;
    hasLoaded.current = false;
    setState({ phase: 'loading' });
    setOlder([]);
    setOlderRead(IDLE);
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    /*
     * Paused while paged back — see the header. The pause engages on the
     * REQUEST, not on the landed window: `older.length > 0` alone leaves the
     * FIRST walk unprotected, which is the whole window in which the reader
     * has committed to reading history and the accumulation does not exist
     * yet to prove it.
     */
    if (intervalMs === null || older.length > 0 || olderRead.phase === 'loading') return;
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, load, older.length, olderRead.phase]);

  const newest = state.phase === 'ready' ? state.page : null;
  // The oldest window held is the one whose cursor names what comes before it.
  const oldest = older[0] ?? newest;
  const hasOlder = oldest?.hasOlder === true;

  // Lift a stall the moment the cursor it was taken against is no longer the
  // one the reader would ask with — see `stalledAt`. The same giant record
  // will very likely stall the new cursor too, and that is fine: it will
  // refuse again, on its own evidence, rather than on a stale verdict.
  useEffect(() => {
    if (olderRead.phase === 'stalled' && stalledAt.current !== (oldest?.windowStart ?? null)) {
      stalledAt.current = null;
      setOlderRead(IDLE);
    }
  }, [olderRead.phase, oldest?.windowStart]);

  const loadOlder = useCallback(() => {
    const cursor = oldest?.windowStart;
    if (oldest?.hasOlder !== true || cursor === null || cursor === undefined) return;
    // 'stalled' is terminal for this cursor: the same request would return the
    // same non-advancing window, so re-asking is a loop, not a retry.
    if (olderRead.phase === 'loading' || olderRead.phase === 'stalled') return;
    const gen = generation.current;
    setOlderRead({ phase: 'loading', message: null });
    void (async () => {
      try {
        const page = await seam.transcript(sessionId, windowOpts(cursor));
        // A walk that started under a different session, or before a resume,
        // must not prepend into what is on screen now. A POLL does not
        // invalidate it — see the counters above.
        if (gen !== generation.current) return;
        /*
         * A WALK THAT DID NOT MOVE IS THE END OF THE WALK.
         *
         * The server steps to the record boundary below the cursor, and it
         * cannot step past a SINGLE record larger than its read budget — the
         * window is entirely inside one record, so there is no earlier
         * boundary to name and it returns the cursor it was given. Prepending
         * that window changes nothing, leaves `oldest.windowStart` where it
         * was, and lets the sentinel ask for the identical bytes again: an
         * unbounded loop. Stopping with a reason is the honest end.
         *
         * The refusal belongs to THIS CURSOR, not to the session — see
         * `stalledAt`.
         */
        if (page.windowStart !== null && page.windowStart >= cursor) {
          stalledAt.current = cursor;
          setOlderRead({
            phase: 'stalled',
            message:
              'a single record here is larger than the node reads in one window, so the walk cannot step past it',
          });
          return;
        }
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
        if (gen !== generation.current) return;
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
    // Bumped BEFORE the reload: a walk still in flight belongs to the
    // accumulation being dropped, and must not land into the fresh one.
    generation.current += 1;
    stalledAt.current = null;
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
