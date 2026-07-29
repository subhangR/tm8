import { useState } from 'react';
import type { EntityId, MessageView } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { DisabledAction, DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import type { ChannelPostInput } from './feed-model';

/**
 * THE T10 COMPOSER — §7's four send layers, as controls.
 *
 * The oracle's own footer states this component's contract in copy: "Enter
 * sends · Shift+Enter newline" and "draft keyed member+session · survives
 * switches & reconnects". A build that wires only the button has DRAWN a
 * promise it does not keep, so the keyboard path is tested beside the click.
 *
 * THE ONE THING THIS COMPONENT WILL NOT DO: pretend. Every refusal below names
 * which fact is missing, because the three ways Send can be unavailable are
 * three different situations for the person typing —
 *
 *   · no dispatcher wired   → the build cannot send (our gap, not theirs);
 *   · offline               → the network cannot carry it, and there is no
 *                             contracted offline queue, so a cheerful "queued"
 *                             would be a fabricated promise (S11);
 *   · session exited        → Send WORKS and stores; nothing is delivered and
 *                             nothing wakes (S21). This one is a warning, NOT
 *                             a disable — refusing here would destroy a
 *                             legitimate, permitted write.
 *
 * Draft state is deliberately local and deliberately sticky: a cancelled reply
 * keeps the text (the oracle says so in a tooltip), and a REJECTED send keeps
 * it too — when the mutation failed, the draft is the only copy that exists
 * anywhere (S17).
 */

export interface ComposerProps {
  anchorId: EntityId;
  anchorNoun: string;
  /** Absent ⇒ Send is disabled-with-reason, never enabled-inert. */
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  /** T4 honesty. `offline`/`polling` withdraw Send; nothing is queued. */
  connection?: ConnectionState;
  /** S21 — store-only composing. A warning, never a disable. */
  sessionExited?: boolean;
  replyTo: MessageView | null;
  onCancelReply: () => void;
}

/** Attachments have no executor anywhere behind the seam. Stated, not hidden. */
const NO_UPLOAD_SEAM = {
  cause: 'Attachments aren’t available in this build',
  remedy: 'the facade seam exposes no upload command — the control is here because the feature is real, not because it works yet',
};

export function Composer({
  anchorId,
  anchorNoun,
  onPost,
  connection,
  sessionExited = false,
  replyTo,
  onCancelReply,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnected = connection?.phase === 'offline' || connection?.phase === 'polling';

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy || !onPost || disconnected) return;
    setBusy(true);
    setError(null);
    try {
      await onPost({ anchorIds: [anchorId], body, parentMessageId: replyTo?.id ?? null });
      // Cleared ONLY on success. The reply target clears with it: the next
      // message is a new thought unless the user says otherwise.
      setText('');
      onCancelReply();
    } catch (e) {
      /*
       * The refusal is held HERE, beside the text that failed (T5-5's
       * anti-toast law: a refusal never leaves the surface that asked). And
       * the draft survives — S17's "Draft and attachments kept" is not a
       * courtesy, it is the only remaining copy of an unstored message.
       */
      setError(e instanceof Error ? e.message : 'The message was not stored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chs-composer">
      {sessionExited ? (
        <p className="chs-composer__warn" data-testid="chs-exited">
          Session exited — Send stores the message; nothing is delivered, nothing wakes.
        </p>
      ) : null}

      {error ? (
        <p className="chs-composer__error" role="alert">
          {error}
        </p>
      ) : null}

      {replyTo ? (
        <div className="chs-replying" data-testid="chs-replying">
          <span className="chs-replying__label">
            {`REPLYING TO ${replyTo.state.author?.displayName ?? replyTo.createdBy?.displayName ?? 'message'}`}
          </span>
          <span className="chs-replying__excerpt">{replyTo.content.body}</span>
          <button
            type="button"
            className="chs-iconbtn"
            aria-label="Cancel reply"
            title="cancel reply — draft text is kept"
            onClick={onCancelReply}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      ) : null}

      <div className="chs-composer__row">
        <DisabledIconControl label="Attach a file" glyph="＋" reason={NO_UPLOAD_SEAM} />
        <textarea
          className="chs-composer__input"
          aria-label={`Message ${anchorNoun}`}
          placeholder={`Message ${anchorNoun}…`}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Shift+Enter is the newline and must fall through to the textarea
            // untouched; anything else here would swallow a keystroke the
            // footer copy promises works.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <SendControl
          disconnected={disconnected}
          wired={Boolean(onPost)}
          busy={busy}
          empty={text.trim().length === 0}
          onClick={() => void submit()}
        />
      </div>

      <p className="chs-composer__hint">
        <span>Enter sends · Shift+Enter newline</span>
      </p>
    </div>
  );
}

function SendControl({
  disconnected,
  wired,
  busy,
  empty,
  onClick,
}: {
  disconnected: boolean;
  wired: boolean;
  busy: boolean;
  empty: boolean;
  onClick: () => void;
}) {
  if (!wired) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'Sending isn’t connected in this surface yet',
            remedy: 'the composer is real; its dispatcher is not wired at this mount point',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  if (disconnected) {
    return (
      <span data-testid="chs-send-reason">
        <DisabledAction
          label="Send"
          reason={{
            cause: 'You’re offline — nothing is reaching the node',
            remedy: 'there is no offline queue, so your draft is kept here and sends when the connection returns',
          }}
        >
          Send
        </DisabledAction>
      </span>
    );
  }
  return (
    <button type="button" className="chs-composer__send" disabled={busy || empty} onClick={onClick}>
      {busy ? '…' : 'Send'}
    </button>
  );
}
