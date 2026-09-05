/**
 * The corner density for the shared credential model.
 *
 * WHY THIS EXISTS. Home used to carry sign-ins at TWO densities stacked in the
 * page flow: the full `CredentialsProviderBlock` card grid and, directly
 * beneath it under a second heading, the compact `ProviderRail` chip strip.
 * Both drew the same six providers from the same port and stated the same four
 * verdicts. Measured on the shipped screen, the pair occupied >=425 CSS px
 * before the conversation began — on a page whose entire subject IS the
 * conversation.
 *
 * WHY IT IS WORDS AND NOT ICONS. The obvious fix — shrink the marks and put
 * them in a corner — was tried three times and failed three times. It is what
 * `ProviderRail` already shipped (a 38px tile whose answer is a 9px glyph in a
 * 14px badge: the box is four times the size of the information). A 14px-mark
 * variant measured 123x24 and was illegible. A third variant with strengthened
 * 15-19px state silhouettes was still slow to parse, because identifying SIX
 * vendor marks is study, not a glance. So the closed control states its answer
 * in a SENTENCE. Words are legible at 32px tall; six logos are not.
 *
 * WHAT IT SAYS, in priority order (`summaryOf`): an exception first when there
 * is one, a count when there is not, and "status unread" when the node could
 * not answer. A refusal must never launder into "0 of 6 connected" — that is a
 * confident negative invented from an unanswered question.
 *
 * WHAT A CLICK DOES: it REVEALS. `ProviderRail`'s chips called `startLogin`
 * directly, so clicking a provider committed you to a terminal instead of
 * showing you anything. Here the first click only opens the panel; login
 * begins from an explicit Connect/Reconnect inside it.
 *
 * This directory owns no provider-specific presentation facts and no second
 * credential vocabulary: marks come from `provider-presentation`, states from
 * `verdictOf`, and the opened panel is `CredentialsProviderBlock` itself.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CredentialsStatusView } from '@tm8/contract';
import { CredentialsProviderBlock } from '../settings-credentials/CredentialsProviderBlock';
import {
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
} from '../settings-credentials/port';
import './credentials-corner.css';

export interface CredentialsCornerProps {
  port: CredentialsPort;
  /** Same-origin route prefix for the node that owns a login terminal. */
  serverBaseUrl?: string;
}

/** What the closed control is telling you, which also picks its tone. */
export type CornerTone = 'quiet' | 'attention' | 'unread';

export interface CornerSummary {
  tone: CornerTone;
  text: string;
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/**
 * Exception first, count second, refusal never dressed as a count.
 *
 * Exported for its own test: this is the one piece of judgement in the module,
 * and asserting it through a rendered popover would test the popover instead.
 */
export function summaryOf(
  status: CredentialsStatusView | null,
  loadError: string | null,
): CornerSummary {
  if (loadError) return { tone: 'unread', text: 'Agent sign-ins — status unread' };
  if (!status) return { tone: 'quiet', text: 'Agent sign-ins — reading…' };

  const verdicts = status.providers.map((entry) =>
    verdictOf(entry, status.gitCredentialStore),
  );
  const count = (kind: ConnectionVerdict) => verdicts.filter((v) => v === kind).length;

  const unavailable = count('unavailable');
  const unknown = count('unknown');

  /* An exception outranks the tally. "3 of 6 connected" is true while Hermes
     is missing, but it answers a question nobody asked — what you need to know
     is the thing that will stop an agent you launch. */
  if (unavailable > 0) {
    return {
      tone: 'attention',
      text: `Agent sign-ins — ${unavailable} unavailable`,
    };
  }
  if (unknown > 0) {
    return {
      tone: 'attention',
      text: `Agent sign-ins — ${unknown} not measured`,
    };
  }

  const connected =
    count('connected-named') + count('connected-unnamed');
  return {
    tone: 'quiet',
    text: `Agent sign-ins — ${connected} of ${status.providers.length} connected`,
  };
}

export function CredentialsCorner({ port, serverBaseUrl }: CredentialsCornerProps) {
  const [status, setStatus] = useState<CredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(() => {
    return port.load().then(
      (next) => { setStatus(next); setLoadError(null); },
      (error: unknown) => setLoadError(messageOf(error)),
    );
  }, [port]);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (next) => { if (live) { setStatus(next); setLoadError(null); } },
      (error: unknown) => { if (live) setLoadError(messageOf(error)); },
    );
    return () => { live = false; };
  }, [port]);

  /* Closing re-reads, because the panel's own writes (connect, disconnect)
     change what the closed sentence should say. */
  const close = useCallback(() => {
    setOpen(false);
    void reload();
    triggerRef.current?.focus();
  }, [reload]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }
    function onPointerDown(event: MouseEvent) {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) close();
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close]);

  /* The panel is the reason the button was pressed, so the keyboard goes
     there rather than to the end of the page. */
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const summary = summaryOf(status, loadError);

  return (
    <div className="cred-corner" ref={rootRef} data-testid="credentials-corner">
      <button
        type="button"
        ref={triggerRef}
        className="cred-corner__trigger"
        data-testid="credentials-corner-trigger"
        data-tone={summary.tone}
        aria-label={summary.text}
        title={summary.text}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-busy={status === null && loadError === null}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {/* Shape as well as colour: the tone is never carried by hue alone. */}
        <span className="cred-corner__flag" data-tone={summary.tone} aria-hidden="true" />
        <span className="cred-corner__text">{summary.text}</span>
      </button>

      {open ? (
        <div
          className="cred-corner__panel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Agent sign-ins"
          tabIndex={-1}
          data-testid="credentials-corner-panel"
        >
          <div className="cred-corner__panel-head">
            <span className="cred-corner__panel-title kit-eyebrow">Agent sign-ins</span>
            <button
              type="button"
              className="cred-corner__close"
              onClick={close}
              aria-label="Close agent sign-ins"
              data-testid="credentials-corner-close"
            >
              ×
            </button>
          </div>
          <div className="cred-corner__panel-body">
            <CredentialsProviderBlock port={port} serverBaseUrl={serverBaseUrl} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
