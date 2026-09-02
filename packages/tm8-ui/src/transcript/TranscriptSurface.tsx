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
import type React from 'react';
import type { ReactNode, RefObject } from 'react';
import type { EntityId, SessionTranscriptEntry } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
/* THE DEEP PATH ABOVE DOES NOT BRING THIS SHEET, and every refusal on this
   surface is drawn with it — the unavailable transcript, the failed read, and
   the composer with no PTY. `panels/index.ts` is what normally imports it, and
   a host that reached this surface without touching that module got the
   markup without its vocabulary; on the phone that also costs the entire
   tap-to-disclose reason. Same fix `ChatHomeScreen` and `ChannelScreen` both
   carry, for the same reason. */
import '../panels/honesty/honesty.css';
import { ChooseFilesControl } from '../files/ChooseFilesControl';
import { uploadClipboardFile } from '../terminal/clipboardUpload';
/* THE INDEX, NOT THE DEEP PATH, AND THAT IS A BUG FIX RATHER THAN A TIDY.
   `rich-input/index.ts` is the only importer of `rich-input.css`, so reaching
   `ComposerCard` at `../rich-input/ComposerCard` brought the component WITHOUT
   its stylesheet: `.ri-card` had no border, no background and no field
   treatment, and the composer rendered as a naked textarea on any route where
   neither Chat Home nor a channel screen — both lazy — had already mounted and
   pulled the sheet in for it. It looked correct in the product only because a
   reader usually arrives via chat. Same class of trap as reaching
   `panels/honesty/` by deep path. Seen in `transcript-dev.html`, which mounts
   this surface and nothing else. */
import {
  ComposerCard,
  dataTransferHasFiles,
  extractReadableFiles,
  spliceInto,
} from '../rich-input';
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
      {/* THE CARD IS THE FRAME. This region owns PLACEMENT and SPACING and
          nothing else — no border, no second background. `ComposerCard`
          renders `.ri-card`, whose entire job is to be the bordered card, and
          a bordered foot around a bordered card is two frames for one control.
          (User report 2026-08-20, with the box circled: "there is one extra
          box outside the composer not needed". Same ruling as the artifact
          panel's "the panel is the frame".) */}
      <div className="tr-surface__foot">
        <TranscriptComposer seam={seam} sessionId={sessionId} liveness={liveness} />
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
  /* React 19 widened `useRef<T>(null)` to `RefObject<T | null>`; a prop typed
     `RefObject<T>` can no longer receive one. The null is real — the ref is
     null before mount — so the type is corrected to admit it rather than
     cast at the call sites, which would move a real case into a blind spot. */
  sentinelRef: RefObject<HTMLDivElement | null>;
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
      {/* ⚠ THE BOUNDARY'S CONTENT IS ONE `<span>`, and it has to be.
          `.tr-turns__boundary` is a flex row whose `::before`/`::after` draw
          the two hair rules, and a flex container makes EVERY child a flex
          item — bare text nodes included, each in its own anonymous box. Left
          loose, the sentence and its button would be separate, unwrappable
          items strung across the row. The wrapper is what keeps them one
          paragraph between two rules. */}
      {hasOlder ? (
        <p className="tr-turns__boundary" data-testid="transcript-tail-boundary">
          <span className="tr-turns__boundary-text">
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
          </span>
        </p>
      ) : (
        <p className="tr-turns__boundary" data-testid="transcript-start-boundary">
          <span className="tr-turns__boundary-text">This is the beginning of the session.</span>
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
 * WHERE THE DISCLOSURE WENT, and why it is not gone.
 *
 * A 10px grey paragraph used to hang under the card saying this input is typed
 * into the terminal rather than posted as a message. The user asked for it to
 * go ("also the bottom text not needed") and they are right about the pixels:
 * it was the first thing the eye landed on in a region whose job is to be one
 * composer. THE FACT IS STILL TRUE AND STILL LOAD-BEARING — this is the one
 * composer in the app that does not post a message, and a reader who assumes
 * otherwise is wrong about where their words went.
 *
 * So it moved rather than being dropped, exactly as the terminal drawer's
 * collapsed summary moved onto its toggle when that 28px bar was removed: onto
 * the accessible name, the `title` and the placeholder. It is one hover and one
 * screen-reader stop away instead of one glance, which is the right price for a
 * fact a reader needs ONCE and this surface was charging on every render.
 */
const PTY_DISCLOSURE =
  'Typed into the session’s terminal, not posted as a message — it appears above only if the agent writes it to its transcript.';

/**
 * THE COMPOSER — a terminal keyboard wearing a chat box.
 *
 * THE SAME BOX AS CHAT, AND NOT ONE CONTROL MORE. It adopts Chat Home's card
 * (`ComposerCard`), its foot geometry, its attach control
 * (`ChooseFilesControl`) and the promoted Send treatment. It does NOT adopt the
 * mode / teammate / model `ComposerSelect` picks: those configure a chat
 * THREAD, a PTY has no equivalent, and a control that cannot perform is a lie
 * in pixels. "The same box" is the same shell and the same control vocabulary,
 * never fabricated capabilities.
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
  const area = useRef<HTMLTextAreaElement>(null);

  const canSend = liveness === 'live';
  const attach = useTerminalAttachments({ sessionId, area, text, setText });

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

  /* SEND IS HELD WHILE A FILE IS STILL ON ITS WAY UP, the same gate chat's
     `attachments.blocked` applies. Sending now would deliver the sentence
     WITHOUT the path it is about, and the path would then land in an empty
     draft the agent never sees. */
  const uploading = attach.busy.length > 0;
  const sendReason = uploading
    ? 'waiting for the attachment to finish uploading'
    : PTY_DISCLOSURE;

  return (
    <ComposerCard
      testId="transcript-composer"
      above={
        <>
          {/* The shared chip vocabulary (`.ri-attachments`), used directly
              rather than through `AttachmentChips`: that view takes a
              `RichInputAttachments`, whose `retry`/`remove`/`uploadedIds` this
              transport cannot honour, and handing it a stub with three dead
              methods is precisely the fabricated interface this task forbids.
              The CLASSES are the shared ones, so it looks and measures — phone
              rules included — like every other composer's chips. */}
          {attach.refusal === null && attach.error === null && !uploading ? null : (
            <div className="ri-attachments" data-testid="transcript-attachments">
              {attach.refusal === null ? null : (
                <p className="ri-attachments__refusal" role="alert">
                  <span>{attach.refusal}</span>
                  <button type="button" onClick={attach.clearRefusal} aria-label="Dismiss">
                    ✕
                  </button>
                </p>
              )}
              {attach.error === null ? null : (
                <p className="ri-attachments__refusal" role="alert">{attach.error}</p>
              )}
              {uploading ? (
                <ul className="ri-attachments__list" aria-label="Attachments" aria-live="polite">
                  {attach.busy.map((name) => (
                    <li key={name} className="ri-attachment" data-phase="uploading">
                      <span className="ri-attachment__name">{name}</span>
                      {/* NO CANCEL, AND THAT IS THE HONEST OMISSION.
                          `uploadClipboardFile` is a bare `fetch` with no abort
                          signal, so a Cancel here could stop the INSERT but not
                          the upload — and a cancel that cannot cancel is worse
                          than no cancel. */}
                      <span role="status">uploading…</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {failure === null ? null : (
            <p
              className="ri-attachments__refusal tr-composer__error"
              role="alert"
              data-testid="transcript-composer-error"
            >
              {failure}
            </p>
          )}
        </>
      }
      field={
        // No class: `.ri-card textarea` (rich-input.css:33) is what styles the
        // field, so the card's own treatment applies by being inside it.
        <textarea
          ref={area}
          value={text}
          rows={2}
          placeholder="Type to the session’s terminal…"
          /* THE THREE CHEAP HOMES for the disclosure the paragraph used to
             carry. The accessible name is what a screen reader announces on
             focus; `title` is what a hover answers; the placeholder is what an
             empty box says on sight. */
          title={PTY_DISCLOSURE}
          aria-label={`Send input to this session’s terminal. ${PTY_DISCLOSURE}`}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onPaste={attach.onPaste}
          onDragOver={attach.onDragOver}
          onDrop={attach.onDrop}
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
        <>
          <ChooseFilesControl
            label="Attach a file"
            title="attach a file — or drop or paste one into the message. It uploads to the session’s node and its PATH is written into your draft, because agents read files by path."
            className="ri-attach"
            inputClassName="ri-attach__input"
            onChoose={attach.addFiles}
          />
          {/* The give in the row, and what pushes Send to the right edge. No
              copy: the foot carries controls, per the 2026-08-18 ruling that
              took the keyboard tip out of the chat composer's foot. */}
          <span className="ri-foot-gap" aria-hidden />
          <button
            type="button"
            className="ri-send"
            title={sendReason}
            disabled={sending || uploading || text.trim() === ''}
            onClick={() => void send()}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </>
      }
    />
  );
}

/**
 * FILES INTO A PTY — upload, then splice the NODE PATH into the draft.
 *
 * THE DESTINATION DECIDES THE TRANSPORT, and this surface's Send is
 * `execution.prompt`, which injects into the session's PTY. So it is the
 * TERMINAL destination and takes the terminal's transport: the bytes go to the
 * node that owns the PTY (`uploadClipboardFile`, which reads the endpoint from
 * `ptyTransport` rather than assuming the current origin) and come back as an
 * absolute path on that node. A `tm8://file/<id>` reference typed into an
 * agent's stdin resolves to NOTHING; every agent CLI we support reads files by
 * path, which is exactly what makes this mechanism agent-agnostic.
 *
 * WHY NOT `useRichInput`'s ATTACHMENTS SPEC, which would have brought paste,
 * drop, refusal reporting and the caret bookkeeping for free. Its `start` must
 * return a `FileUploadTask`, whose `UploadedFile` requires a `fileEntityId`, a
 * `maxSizeBytes` and a `CommandResult`. A node-local clipboard upload creates
 * NO graph entity, is granted no ceiling and runs no command — three of those
 * six fields could only be invented, and `cancel()` would be a fourth (a bare
 * `fetch`, no abort signal). The task shape cannot be satisfied honestly here,
 * so route (b): the same three primitives, composed directly. What that costs
 * is the ~40 lines below; what it buys is that nothing in this file claims a
 * capability it does not have. The hook's other half — the trigger popover —
 * is not wanted anyway: a `/` typed at a PTY belongs to whatever program is
 * reading it, which is the same ruling `clipboardPaste.ts` already carries.
 *
 * NEVER A CARRIAGE RETURN WITH THE PATH. `spliceInto`'s `'inline'` separator
 * pads with a SPACE, so the path arrives as one more word in a sentence the
 * human is still writing. A newline here would submit a bare path as the whole
 * message — written down because it has been got wrong before.
 */
function useTerminalAttachments({
  sessionId,
  area,
  text,
  setText,
}: {
  sessionId: EntityId;
  area: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (next: string) => void;
}) {
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);

  /* The draft is read at RESOLUTION, not at click time: an upload takes
     seconds and the writer keeps typing through them, so splicing into a
     click-time snapshot would silently discard every one of those keystrokes.
     A live ref is how `useRichInput` solves the same problem. */
  const live = useRef(text);
  live.current = text;

  /* The textarea still holds the PREVIOUS value when the setter runs, so the
     caret can only be applied after React has re-rendered. */
  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    area.current?.setSelectionRange(at, at);
  }, [text, area]);

  const addFiles = useCallback((files: FileList | readonly File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
    /* The caret is read ONCE, before the first upload starts, and each landed
       file advances it. Re-reading the live selection per completion would
       scatter N paths wherever the cursor happened to be N seconds later, in
       whatever order the network answered. */
    const el = area.current;
    let caret = el ? el.selectionStart : live.current.length;
    let end = el ? el.selectionEnd : caret;

    for (const file of list) {
      setBusy((current) => [...current, file.name]);
      void uploadClipboardFile(file, sessionId).then(
        (uploaded) => {
          const next = spliceInto(live.current, caret, end, uploaded.path, 'inline');
          caret = next.caret;
          end = next.caret;
          pendingCaret.current = next.caret;
          live.current = next.body;
          setText(next.body);
          setBusy((now) => now.filter((name) => name !== file.name));
        },
        (cause: unknown) => {
          setBusy((now) => now.filter((name) => name !== file.name));
          /* THE SAME FAILURE DIALECT THE TERMINAL ALREADY SPEAKS — a file that
             silently fails to arrive looks to the viewer exactly like an agent
             ignoring them (`LiveTerminal`'s `injectFiles`). Said HERE rather
             than through `notifyUser` because, unlike an xterm event handler,
             this one has a card to say it in, beside the text that asked. */
          setError(
            `${file.name} could not be attached — ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        },
      );
    }
  }, [area, sessionId, setText]);

  const takeFiles = useCallback((data: DataTransfer | null): boolean => {
    const { accepted, refused } = extractReadableFiles(data, { renameAll: true });
    if (refused.length > 0) {
      setRefusal(
        `${refused.map((file) => file.name || 'unnamed file').join(', ')} — not attached; agents cannot read ${
          refused.length === 1 ? 'this file type' : 'these file types'
        }.`,
      );
    }
    if (accepted.length > 0) addFiles(accepted);
    /* A REFUSAL COUNTS AS HANDLED, as it does on the terminal: the files were
       taken out of the event and said no to out loud, and must not then fall
       through to pasting whatever name the file manager left in `text/plain`. */
    return accepted.length > 0 || refused.length > 0;
  }, [addFiles]);

  return {
    busy,
    error,
    refusal,
    clearRefusal: useCallback(() => setRefusal(null), []),
    addFiles,
    onPaste: useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Files win over text, as every paste surface here has it. A text-only
      // paste falls through untouched.
      if (takeFiles(event.clipboardData)) event.preventDefault();
    }, [takeFiles]),
    /* Cancelled for FILES whether or not the upload can proceed: per the
       drag-and-drop spec a `drop` is not dispatched at all unless the preceding
       `dragover` was cancelled, and an uncancelled file drop navigates the
       browser away from the app, taking the draft with it. Narrowed to `Files`
       so dragging selected text inside the textarea still works. */
    onDragOver: useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
      if (dataTransferHasFiles(event.dataTransfer)) event.preventDefault();
    }, []),
    onDrop: useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
      if (event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      takeFiles(event.dataTransfer);
    }, [takeFiles]),
  };
}
