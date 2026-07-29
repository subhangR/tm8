/**
 * SIGN-OUT CONFIRM — T3-3, "SIGN-OUT CONFIRM — HONEST COPY".
 *
 * The canvas's whole point here is the COPY, so the copy is transcribed rather
 * than paraphrased: on a local node, signing out ends a browser session and
 * nothing else. The agents keep running; anyone at this machine can sign back
 * in. The canvas annotation states the intent in one line — "No fake security
 * theater" — and softening this text would be exactly that.
 *
 * The dialog is only ever reachable when a real sign-out executor exists; the
 * menu row refuses with a reason otherwise (see `reasons.ts`), so this surface
 * can never become a confirm button for an action nothing can perform.
 */
import { useEffect, useRef } from 'react';

export interface SignOutConfirmProps {
  /** Names the agents that keep running, when the host knows them. */
  runningLabel?: string;
  onCancel(): void;
  onConfirm(): void;
}

export function SignOutConfirm({ runningLabel, onCancel, onConfirm }: SignOutConfirmProps) {
  const ref = useRef<HTMLDivElement>(null);

  // The dialog takes focus so the confirm is never dispatched by a stray Enter
  // aimed at the row underneath it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  return (
    <div className="acct-confirm__scrim" data-testid="account-sign-out-scrim">
      <div
        className="acct-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acct-confirm-title"
        ref={ref}
      >
        <div className="acct-confirm__title" id="acct-confirm-title">
          Sign out of tm8?
        </div>
        <p className="acct-confirm__body">
          This ends your browser session. On a local node that is all it does —{' '}
          <strong>{runningLabel ?? 'running agents'} keep running</strong>, and anyone at this
          machine can sign back in.
        </p>
        <div className="acct-confirm__actions">
          <button type="button" className="acct-confirm__cancel" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="acct-confirm__go"
            onClick={onConfirm}
            data-testid="account-sign-out-confirm"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
