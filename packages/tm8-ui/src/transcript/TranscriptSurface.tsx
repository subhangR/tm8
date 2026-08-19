/**
 * THE TRANSCRIPT SURFACE — the session panel's conversation view.
 *
 * The session panel used to offer a "Chat" surface here, which read the graph's
 * message feed. That feed is not what the agent said; it is what was said to
 * and about the session in tm8. The agent's own words live in the transcript it
 * writes for itself, and this surface reads THAT — so the panel finally shows
 * the conversation a reader came looking for.
 *
 * WHY THIS IS NOT A CHAT SURFACE, stated once so the name is never reclaimed:
 * a `SessionTranscriptEntry` is `{at, source, text, truncated}`. No message id,
 * so nothing here can be replied to, quoted, reacted to or linked. No author
 * entity, so two humans injecting into one session are indistinguishable. It is
 * the least chat-like surface in the app, and it renders with chat's geometry
 * because that is what makes a conversation readable, not because it is one.
 * The transcript is READ, and reading it now reaches the whole session — but
 * the turns are still a file the agent wrote, which nothing here can change.
 *
 * SCROLLING IS THE FEATURE, not chrome around it. Two rules, both in
 * `useTranscriptScroll` below:
 *   - a prepend must not move the reader. Older turns arrive ABOVE what is on
 *     screen, so the distance from the bottom is held across them; without that
 *     every page-back yanks the reader upward and walking back is unusable.
 *   - a reader at the bottom is FOLLOWING and gets pinned to the newest turn;
 *     a reader who has scrolled up is READING and is never moved.
 *
 * READ-ONLY CONTENT, LIVE INPUT. The turns cannot be edited, deleted or
 * retracted — they are a file the agent wrote. The composer is not a
 * contradiction of that: it does not append here at all. It calls
 * `execution.prompt`, which INJECTS INTO THE SESSION'S PTY, exactly as if the
 * text had been typed into the terminal. The turn appears in this list later,
 * if and when the agent writes it — which is why the composer clears on send
 * rather than drawing an optimistic bubble it has no id for.
 *
 * NOT GATED BY `chatEnabled`. The old surface hid behind the interaction
 * profile's immutable chat pin, which is the wrong gate for reading a file off
 * disk: whether an agent keeps a transcript is a fact about the agent tool, not
 * a fact about the session's chat template. So the surface is always offered
 * and `execution.transcript`'s own `available:false`-with-reason draws the
 * empty state — which names the actual cause instead of hiding the tab.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { EntityId, SessionTranscriptEntry } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { ComposerCard } from '../rich-input/ComposerCard';
import { TranscriptTurns } from './TranscriptTurns';
import { useSessionTranscript, type OlderRead } from './useSessionTranscript';
import { transcriptUnavailableReason, type TranscriptState } from './transcript-model';
import './transcript.css';

/** Matches the Debug surface's cadence — the same file, read the same way. */
const POLL_MS = 5_000;

/**
 * How close to the bottom still counts as FOLLOWING.
 *
 * Not zero: sub-pixel layout, a fractional device pixel ratio and a scrollbar's
 * own rounding all leave a live container a pixel or two short of its own
 * `scrollHeight`, and a zero tolerance reads that as "the reader scrolled up"
 * and stops following on a surface nobody touched.
 */
const FOLLOW_SLACK_PX = 24;

/** How far above the first turn the sentinel starts asking for the next window,
 *  so the turns are usually there by the time the reader arrives at them. */
const PREFETCH_MARGIN = '240px';

/**
 * EXACTLY WHAT THIS SURFACE NEEDS FROM THE SEAM, and nothing more — the same
 * narrowing `SessionChatSeam` does next door. Two operations: read the file,
 * and type into the PTY. Naming them is what keeps a test double small and
 * what stops this surface from quietly growing a dependency on the rest of the
 * seam later.
 */
export interface TranscriptSeam {
  transcript: Seam['transcript'];
  commands: Pick<Seam['commands'], 'prompt'>;
}

export interface TranscriptSurfaceProps {
  seam: TranscriptSeam;
  sessionId: EntityId;
  /** The session's liveness verdict, from the ONE authority
   *  (`seam.liveness.statusOf`). It decides two things: whether to poll a file
   *  that can still grow, and whether the composer has a PTY to write into. */
  liveness: SessionLiveness;
  /** The panel's way back to the terminal, supplied by the host. */
  onSwitchToTerminal?: () => void;
}

export function TranscriptSurface({
  seam,
  sessionId,
  liveness,
  onSwitchToTerminal,
}: TranscriptSurfaceProps) {
  // A transcript only grows while something is running. Polling an exited
  // session re-reads an immutable file forever, so liveness — not a mount —
  // decides the interval.
  const isLive = liveness === 'live';
  const {
    state, entries, hasOlder, olderCount, pagedBack, older, loadOlder, resumeLive, refresh,
  } = useSessionTranscript(seam, sessionId, { intervalMs: isLive ? POLL_MS : null });

  const { scrollRef, sentinelRef, follow } = useTranscriptScroll({
    entries, olderCount, hasOlder, loadOlder,
    // A stalled walk disables the sentinel for the same reason it disables the
    // button: asking again asks for identical bytes.
    busy: older.phase === 'loading' || older.phase === 'stalled',
  });

  const backToNewest = useCallback(() => {
    follow();
    resumeLive();
  }, [follow, resumeLive]);

  return (
    <div className="tr-surface" data-testid="transcript-surface">
      <div className="tr-surface__scroll" ref={scrollRef}>
        <TranscriptBody
          state={state}
          entries={entries}
          onRetry={refresh}
          onSwitchToTerminal={onSwitchToTerminal}
          head={
            <TranscriptTop
              sentinelRef={sentinelRef}
              hasOlder={hasOlder}
              older={older}
              onLoadOlder={loadOlder}
              paused={pagedBack && isLive}
              onResume={backToNewest}
            />
          }
        />
      </div>
      <div className="tr-surface__foot">
        <TranscriptComposer seam={seam} sessionId={sessionId} liveness={liveness} />
        {/* THE STANDING DISCLOSURE. Every other composer in this app posts a
            message to the graph; this one types into a terminal. The two are
            indistinguishable by shape, so the difference is stated rather than
            left to be discovered. */}
        <p className="tr-surface__foot-note">
          Input is typed into the session’s terminal, not posted as a message. It appears above only
          if the agent writes it to its transcript.
        </p>
      </div>
    </div>
  );
}

/**
 * THE SCROLL RULES, in one place because they share a container and would
 * otherwise fight each other.
 *
 * `prevHeight`/`prevTop` are read from the PREVIOUS commit — this effect writes
 * them at the end of every render, so on the render that prepended a window
 * they still describe the list as it was before those turns existed. That is
 * what makes `scrollHeight - scrollTop` restorable at all; there is no
 * pre-commit hook in a function component to capture it any later.
 *
 * `useLayoutEffect`, not `useEffect`: the correction has to land in the same
 * frame as the nodes it corrects for, or the reader sees the list jump and then
 * jump back.
 *
 * NOTHING HERE IS PROVABLE IN VITEST. jsdom has no layout — every element
 * reports `scrollHeight: 0` — so these rules are verified in a real browser and
 * the unit tests below only pin the behaviour that survives without layout:
 * which reads are made, and what the boundary says.
 */
function useTranscriptScroll({
  entries,
  olderCount,
  hasOlder,
  loadOlder,
  busy,
}: {
  entries: readonly SessionTranscriptEntry[];
  olderCount: number;
  hasOlder: boolean;
  loadOlder: () => void;
  busy: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // A reader who has not scrolled yet is at the newest turn, which is where a
  // transcript should open — so following is the starting posture, not a state
  // that has to be earned by a scroll event.
  const following = useRef(true);
  const prevOlder = useRef(olderCount);
  const prevHeight = useRef(0);
  const prevTop = useRef(0);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    prevTop.current = el.scrollTop;
    prevHeight.current = el.scrollHeight;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, [onScroll]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (olderCount > prevOlder.current) {
      // A PREPEND. Hold the distance from the bottom: everything that was on
      // screen stays exactly where the reader left it, and the new turns fill
      // the space above.
      el.scrollTop = prevTop.current + (el.scrollHeight - prevHeight.current);
    } else if (following.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevOlder.current = olderCount;
    prevHeight.current = el.scrollHeight;
    prevTop.current = el.scrollTop;
    // RE-DERIVE `following` FROM THE ELEMENT, not only from scroll events.
    // The flag is a cache of a geometric fact, and a cache that only a scroll
    // event can invalidate goes stale the moment the position moves without
    // one — including the moves this effect just made. Reading it back here
    // costs nothing and keeps the next render's decision honest.
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  }, [entries, olderCount]);

  /*
   * THE SENTINEL. It asks for the next window as the reader approaches the top,
   * which is what makes this read as one continuous conversation rather than a
   * series of button presses.
   *
   * It is an ADDITION to the control in the boundary, never a replacement. An
   * observer that never fires — no layout, a zero-height root, a browser that
   * does not have one — would otherwise leave the reader with no way to ask at
   * all, and the failure would be silent.
   */
  const asks = useRef(loadOlder);
  useEffect(() => {
    asks.current = loadOlder;
  }, [loadOlder]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasOlder || busy) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) asks.current();
      },
      { root, rootMargin: `${PREFETCH_MARGIN} 0px 0px 0px` },
    );
    io.observe(target);
    return () => {
      io.disconnect();
    };
  }, [hasOlder, busy]);

  /** Go back to following the newest turn — what a reader means by "live". */
  const follow = useCallback(() => {
    following.current = true;
  }, []);

  return { scrollRef, sentinelRef, follow };
}

/**
 * THE TOP OF THE LIST, which is the only place this surface can say anything
 * true about what it has NOT read.
 *
 * The old copy here said earlier turns "cannot be paged back to". That was true
 * and is now false, and the replacement keeps the same discipline: every state
 * names what is actually the case. `hasOlder: false` is an EARNED claim — the
 * server reached the first byte of the file — so it is the one state allowed to
 * say the session began here.
 */
function TranscriptTop({
  sentinelRef,
  hasOlder,
  older,
  onLoadOlder,
  paused,
  onResume,
}: {
  sentinelRef: RefObject<HTMLDivElement>;
  hasOlder: boolean;
  older: OlderRead;
  onLoadOlder: () => void;
  paused: boolean;
  onResume: () => void;
}) {
  return (
    <div className="tr-turns__top">
      <div ref={sentinelRef} className="tr-turns__sentinel" aria-hidden="true" />
      {paused ? (
        <p className="tr-turns__paused" data-testid="transcript-poll-paused">
          New turns are not being loaded while you read earlier ones.{' '}
          <button type="button" className="tr-linkbtn" onClick={onResume}>
            Back to the newest turns
          </button>
        </p>
      ) : null}
      {hasOlder ? (
        <p className="tr-turns__boundary" data-testid="transcript-tail-boundary">
          {older.phase === 'loading' ? (
            <span role="status">Reading earlier turns…</span>
          ) : older.phase === 'stalled' ? (
            /* THE WALK IS OVER AND THE TRANSCRIPT IS NOT. Neither an error nor
               a beginning — both would be lies. There IS more above and this
               reader cannot reach it, so it says exactly that, and offers no
               retry, because a retry asks for the same bytes forever. */
            <span data-testid="transcript-stalled">
              Earlier turns exist above this line, but they cannot be reached:{' '}
              {older.message ?? 'the walk could not step past this point'}.
            </span>
          ) : (
            <>
              Earlier turns exist above this line.{' '}
              <button
                type="button"
                className="tr-linkbtn"
                onClick={onLoadOlder}
                data-testid="transcript-load-older"
              >
                {older.phase === 'error' ? 'Try earlier turns again' : 'Load earlier turns'}
              </button>
            </>
          )}
          {older.phase === 'error' && older.message !== null ? (
            <span className="tr-turns__boundary-error" role="alert">
              {' '}
              {older.message}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="tr-turns__boundary" data-testid="transcript-start-boundary">
          This is the beginning of the session.
        </p>
      )}
    </div>
  );
}

function TranscriptBody({
  state,
  entries,
  head,
  onRetry,
  onSwitchToTerminal,
}: {
  state: TranscriptState;
  entries: readonly SessionTranscriptEntry[];
  head: ReactNode;
  onRetry: () => void;
  onSwitchToTerminal?: () => void;
}) {
  if (state.phase === 'loading') {
    return (
      <p className="tr-surface__state" role="status">
        Reading the agent transcript…
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="tr-surface__state" data-testid="transcript-error">
        <DisabledAction
          label="Agent transcript"
          reason={{ cause: 'The transcript could not be read', remedy: state.message }}
        >
          Transcript unavailable
        </DisabledAction>
        {/* A real retry, because the read is idempotent and the failure is
            usually transient — telling a reader to switch tabs and come back
            would be the same call with extra steps. */}
        <p>
          <button type="button" className="tr-linkbtn" onClick={onRetry}>
            Try reading it again
          </button>
        </p>
      </div>
    );
  }

  const { page } = state;

  // The node's own reason, never a bare emptiness. Whether an agent writes a
  // transcript at all is a property of the agent tool, so this is frequently
  // the permanent and correct answer rather than a transient miss.
  if (!page.available) {
    return (
      <div className="tr-surface__state" data-testid="transcript-empty">
        <DisabledAction label="Agent transcript" reason={transcriptUnavailableReason(page)}>
          No transcript for this session
        </DisabledAction>
        {onSwitchToTerminal ? (
          <p>
            The agent’s live output is in{' '}
            <button type="button" className="tr-linkbtn" onClick={onSwitchToTerminal}>
              Terminal
            </button>
            .
          </p>
        ) : null}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="tr-surface__state" data-testid="transcript-no-turns">
        <p>The transcript exists but carries no prose turns yet — the agent has only run tools.</p>
        {onSwitchToTerminal ? (
          <p>
            Tool activity is visible in{' '}
            <button type="button" className="tr-linkbtn" onClick={onSwitchToTerminal}>
              Terminal
            </button>
            .
          </p>
        ) : null}
      </div>
    );
  }

  // The turns are the ACCUMULATION, not this page's — a reader who has walked
  // back is holding several windows and they read as one conversation. The
  // boundary that says what is above them is the head.
  return <TranscriptTurns entries={entries} head={head} />;
}

/**
 * THE COMPOSER — a terminal keyboard wearing a chat box.
 *
 * Every other composer in this app posts a message to the graph. This one does
 * not, and the disclosure under it says so plainly, because the two are
 * indistinguishable by shape and a reader who assumes "message" here would be
 * wrong in a way that matters: PTY text reaches the agent's stdin directly.
 *
 * IT REFUSES WITH A REASON RATHER THAN DISAPPEARING. A session with no live PTY
 * has nowhere to put the bytes. Hiding the box would leave a reader wondering
 * whether this surface ever accepted input; a disabled control naming the cause
 * answers the question it raises.
 */
function TranscriptComposer({
  seam,
  sessionId,
  liveness,
}: {
  seam: TranscriptSeam;
  sessionId: EntityId;
  liveness: SessionLiveness;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const canSend = liveness === 'live';

  const send = useCallback(async () => {
    const message = text.trim();
    if (!message || sending || !canSend) return;
    setSending(true);
    setFailure(null);
    try {
      await seam.commands.prompt(sessionId, { message });
      // Cleared, not echoed. There is no id to echo WITH — the turn appears
      // when the agent writes it to the transcript, and inventing a bubble here
      // would be a claim about a file this surface has not read yet.
      setText('');
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The session did not accept the input');
    } finally {
      setSending(false);
    }
  }, [canSend, seam, sending, sessionId, text]);

  if (!canSend) {
    return (
      <div data-testid="transcript-composer-unavailable">
        <DisabledAction
          label="Prompt session"
          reason={{
            cause: 'This session has no live terminal to type into',
            remedy:
              liveness === 'not-running'
                ? 'the session is not running — resume it to send input'
                : 'tm8 cannot currently see a live PTY for this session',
          }}
        >
          Input unavailable
        </DisabledAction>
      </div>
    );
  }

  return (
    <ComposerCard
      testId="transcript-composer"
      above={
        failure === null ? null : (
          <p className="tr-surface__foot-note" role="alert" data-testid="transcript-composer-error">
            {failure}
          </p>
        )
      }
      field={
        // No class: `.ri-card textarea` (rich-input.css:33) is what styles the
        // field, so the card's own treatment applies by being inside it.
        <textarea
          value={text}
          rows={2}
          placeholder="Type to the session…"
          aria-label="Send input to this session’s terminal"
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the grammar every
            // other composer here already uses.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
      }
      foot={
        <button
          type="button"
          className="tr-send"
          disabled={sending || text.trim() === ''}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      }
    />
  );
}
