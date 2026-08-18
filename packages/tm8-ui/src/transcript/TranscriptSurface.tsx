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
 * entity, so two humans injecting into one session are indistinguishable. No
 * cursor — the server reads a bounded TAIL and `older` is not a page that can
 * be walked. It is the least chat-like surface in the app, and it renders with
 * chat's geometry because that is what makes a conversation readable, not
 * because it is one.
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
import { useCallback, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { ComposerCard } from '../rich-input/ComposerCard';
import { TranscriptTurns } from './TranscriptTurns';
import { useSessionTranscript } from './useSessionTranscript';
import { transcriptUnavailableReason, type TranscriptState } from './transcript-model';
import './transcript.css';

/** Matches the Debug surface's cadence — the same file, read the same way. */
const POLL_MS = 5_000;

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
  const { state, refresh } = useSessionTranscript(seam, sessionId, {
    intervalMs: isLive ? POLL_MS : null,
  });

  return (
    <div className="tr-surface" data-testid="transcript-surface">
      <div className="tr-surface__scroll">
        <TranscriptBody state={state} onRetry={refresh} onSwitchToTerminal={onSwitchToTerminal} />
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

function TranscriptBody({
  state,
  onRetry,
  onSwitchToTerminal,
}: {
  state: TranscriptState;
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

  if (page.entries.length === 0) {
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

  // `stats.partial` is the contract's own word for "this is a tail". Passing it
  // down is what stops the first visible turn from reading as the session's
  // beginning.
  return <TranscriptTurns entries={page.entries} partial={page.stats?.partial === true} />;
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
