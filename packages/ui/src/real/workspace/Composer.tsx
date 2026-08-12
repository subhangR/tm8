/**
 * The prompt composer — what you type INTO a running agent.
 *
 * WHAT IT REPLACES. `SessionsScreen.prompt()` called `window.prompt()` and said
 * so in its own comment ("a browser prompt() is a placeholder, not a design").
 * A browser prompt is single-line, loses the text the moment it fails, cannot
 * show what was already sent, and blocks the whole tab while it is open — so the
 * one durable record of what an operator asked an agent to do was the operator's
 * memory.
 *
 * ── DELIVER FIRST, THEN RECORD ───────────────────────────────────────────────
 *
 * A prompt has TWO effects and they are not the same effect:
 *   1. DELIVERY — `execution.prompt` writes the bytes into the agent's PTY.
 *      This is the one that does work. It can fail (session exited between the
 *      status poll and the keystroke, node restarted, PTY gone).
 *   2. RECORD — `messages.post` anchored to the `work_session` puts the prompt in
 *      the graph, so the thread beside the terminal is a durable transcript of
 *      what was asked. This is the one that gets read later.
 *
 * Delivery goes first because the record is ABOUT the delivery. Ordering them
 * the other way round means a recorded prompt that never reached the agent — and
 * tm8's `MessageView` has no delivered flag, so that row renders in the Thread
 * tab identically to one the agent acted on. Two readers, both looking at a true
 * database, would disagree about what the agent was told.
 *
 * That is why a FAILED DELIVERY IS NOT RECORDED — the deliberate deviation from
 * a literal reading of the lane brief, and it is the honest-degradation rule of
 * this codebase applied to writes: never persist something the UI cannot label.
 * The attempt is not lost; it is kept in the composer's own history, rendered as
 * `not delivered — the agent never received this`, with the text restored to the
 * box so the send can simply be repeated. Three outcomes, three renderings:
 *
 *   delivered            → the agent has it, the thread has it.
 *   delivered_unrecorded → the agent HAS it; the thread does not. Weaker
 *                          failure, still stated, because the terminal above is
 *                          the proof and the thread is now incomplete.
 *   undelivered          → nothing happened anywhere. Said loudly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Timestamp } from '../../collab-v2/kit';
import type { RealFacade } from '../RealFacade';
import { disabledBecause } from './Unavailable';
import './styles/composer.css';

/** How many sends stay in the visible history. Bounded so a long session cannot grow the tab. */
const HISTORY_LIMIT = 50;

export type SendOutcome = 'delivered' | 'delivered_unrecorded' | 'undelivered';

export interface SentPrompt {
  id: string;
  text: string;
  /** Wall-clock `HH:MM:SS` of the attempt. */
  /** ISO instant the attempt was made; rendered by the shared Timestamp. */
  at: string;
  outcome: SendOutcome;
  /** The failure, verbatim from the server. Never paraphrased. */
  error?: string;
}

/**
 * Idempotency key. Deliberately NOT imported from `subsystems/thread/useThread`,
 * whose `newMutationId` is the same three lines: that barrel drags the entire
 * message UI and its stylesheet into the middle pane, and the composer is on the
 * critical path of the one pane that must stay light.
 */
let seq = 0;
function cmid(): string {
  seq += 1;
  return `cmid_ws_${Date.now().toString(36)}_${seq}`;
}

const asMessage = (err: unknown): string => String((err as Error)?.message ?? err);

/**
 * One send, as a plain function over the facade.
 *
 * Extracted from the component because THIS is the part with the rule in it —
 * the ordering, and what happens to the record when the delivery fails. A test
 * that has to render a textarea to check that a failed delivery was not written
 * to the graph is a test that will be deleted the next time the markup moves.
 */
export async function deliverPrompt(
  facade: RealFacade,
  sessionId: string,
  text: string,
): Promise<{ outcome: SendOutcome; error?: string }> {
  try {
    await facade.promptSession(sessionId, text, { clientMutationId: cmid() });
  } catch (err) {
    // Nothing is recorded: see the header. The agent never saw this.
    return { outcome: 'undelivered', error: asMessage(err) };
  }

  try {
    await facade.postMessage({ anchorId: sessionId, body: text, clientMutationId: cmid() });
  } catch (err) {
    // The agent HAS the prompt. Only the durable copy is missing, so this is a
    // different sentence from a failed delivery and must not read like one.
    return { outcome: 'delivered_unrecorded', error: asMessage(err) };
  }

  return { outcome: 'delivered' };
}

export interface ComposerProps {
  facade: RealFacade;
  sessionId: string;
  /** From `useSessions.isLive` — the ONE liveness predicate. Gates input and Terminate. */
  live: boolean;
  /** The session's status, for the disabled reason. */
  status?: string;
  /** Fired after a successful terminate so the pane can re-read the session now. */
  onTerminated?: () => void;
}

export function Composer({ facade, sessionId, live, status, onTerminated }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<SentPrompt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  /** Where ArrowUp recall currently is; -1 means "in the draft, not the history". */
  const recall = useRef(-1);

  // History belongs to a SESSION, not to the pane. Carrying it across a switch
  // would show one agent's prompts under another agent's terminal.
  useEffect(() => {
    setHistory([]);
    setDraft('');
    setError(null);
    recall.current = -1;
  }, [sessionId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy || !live) return;
    setBusy(true);
    // Cleared optimistically so the box is ready for the next thought; restored
    // verbatim below if the agent never got this one.
    setDraft('');
    recall.current = -1;

    const { outcome, error: failure } = await deliverPrompt(facade, sessionId, text);

    setHistory((prev) => [
      { id: cmid(), text, at: new Date().toISOString(), outcome, error: failure },
      ...prev,
    ].slice(0, HISTORY_LIMIT));

    if (outcome === 'undelivered') {
      setDraft(text);
      setError(failure ?? 'delivery failed');
    } else {
      setError(outcome === 'delivered_unrecorded' ? (failure ?? null) : null);
    }
    setBusy(false);
    box.current?.focus();
  }, [busy, draft, facade, live, sessionId]);

  const terminate = useCallback(async () => {
    if (busy || !live) return;
    setBusy(true);
    try {
      await facade.terminateSession(sessionId, { clientMutationId: cmid() });
      setError(null);
      onTerminated?.();
    } catch (err) {
      setError(asMessage(err));
    } finally {
      setBusy(false);
    }
  }, [busy, facade, live, onTerminated, sessionId]);

  /**
   * Cmd/Ctrl+Enter SENDS; bare Enter is a NEWLINE.
   *
   * This way round on purpose: a prompt to an agent is a paragraph far more
   * often than it is a sentence, and the cost of the two mistakes is not
   * symmetric — a stray newline costs a keystroke, a stray send costs an agent
   * acting on a half-written instruction.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
      return;
    }
    /*
     * ArrowUp walks BACK through what was sent, ArrowDown forward, shell-style.
     *
     * Only from an EMPTY box, or from a draft this recall itself put there —
     * otherwise it would eat cursor movement inside a paragraph the user is
     * still writing, which is the thing that makes shell-style recall feel
     * hostile in a multi-line composer. Typing anything resets the walk
     * (`onChange`), so an edited recall is a new draft rather than a position.
     */
    if (e.key === 'ArrowUp' && history.length > 0 && (draft === '' || recall.current >= 0)) {
      e.preventDefault();
      recall.current = Math.min(recall.current + 1, history.length - 1);
      setDraft(history[recall.current]!.text);
      return;
    }
    if (e.key === 'ArrowDown' && recall.current >= 0) {
      e.preventDefault();
      recall.current -= 1;
      setDraft(recall.current < 0 ? '' : history[recall.current]!.text);
    }
  };

  const liveReason = live ? null : `session ${status || 'is not live'} — nothing is listening`;
  const sendState = disabledBecause('promptSession', liveReason ?? (draft.trim() ? null : 'nothing to send'));
  const terminateState = disabledBecause('terminateSession', liveReason);

  return (
    <div className="ws-composer" data-testid="composer">
      {error && (
        <pre className="ws-composer__error" role="alert" data-testid="composer-error">{error}</pre>
      )}

      {history.length > 0 && (
        <ol className="ws-composer__history" data-testid="composer-history" aria-label="Prompts sent">
          {history.map((h) => (
            <li key={h.id} className="ws-composer__sent" data-outcome={h.outcome}>
              <Timestamp className="ws-composer__at t-mono" at={h.at} />
              <span className="ws-composer__text">{h.text}</span>
              {h.outcome === 'undelivered' && (
                <strong className="ws-composer__failed">
                  not delivered — the agent never received this
                </strong>
              )}
              {h.outcome === 'delivered_unrecorded' && (
                <span className="ws-composer__partial">
                  delivered, but not recorded in the thread
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="pn-term-input ws-composer__inputrow">
        <span className="pn-tslash" aria-hidden="true">›</span>
        <textarea
          ref={box}
          className="ws-composer__box"
          data-testid="composer-input"
          aria-label="Message to the agent"
          placeholder={live ? 'Message the agent…  (⌘/Ctrl+Enter to send)' : 'Session ended — no input'}
          rows={2}
          value={draft}
          disabled={!live || busy}
          onChange={(e) => { setDraft(e.target.value); recall.current = -1; }}
          onKeyDown={onKeyDown}
        />

        <div className="ws-composer__actions">
          <span className="ws-composer__hint" title="Cmd/Ctrl+Enter sends; Enter inserts a newline">⌘↵</span>
          <button
            type="button"
            className="ws-composer__button"
            data-testid="composer-terminate"
            onClick={() => void terminate()}
            {...terminateState}
            disabled={terminateState.disabled || busy}
          >
            Terminate
          </button>
          <button
            type="button"
            className="ws-composer__button ws-composer__send"
            data-testid="composer-send"
            onClick={() => void send()}
            {...sendState}
            disabled={sendState.disabled || busy}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
