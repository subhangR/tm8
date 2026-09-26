/**
 * The confirmation both membership endings pass through (G6, migration 231):
 * Remove on a members row, Leave in Danger zone.
 *
 * Both are one click from irreversible for the person on the other end —
 * their sessions stop and their tokens are revoked in the same commit — so
 * neither fires from the control itself. The dialog says what happens, and
 * the server's refusal (the last owner, an owner removed by an admin) is
 * printed here in its own words, beside the act that was refused.
 *
 * Cancel takes focus, for the reason `account/SignOutConfirm` gives: a stray
 * Enter aimed at the row underneath must not be the thing that confirms.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import './membership-confirm.css';

export interface MembershipConfirmProps {
  title: string;
  body: ReactNode;
  /** The verb on the confirming button: "Remove", "Leave space". */
  confirmLabel: string;
  testId: string;
  onCancel: () => void;
  /** Resolves when the write lands; a rejection is shown, and the dialog stays. */
  onConfirm: () => Promise<unknown>;
}

export function MembershipConfirm({
  title,
  body,
  confirmLabel,
  testId,
  onCancel,
  onConfirm,
}: MembershipConfirmProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  async function confirm() {
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setPending(false);
    }
  }

  return (
    <div className="set-mconfirm__scrim" data-testid={`${testId}-scrim`}>
      <div
        className="set-mconfirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        ref={ref}
      >
        <div className="set-mconfirm__title" id={`${testId}-title`}>
          {title}
        </div>
        <div className="set-mconfirm__body">{body}</div>
        {failure !== null ? (
          <p className="set-mconfirm__error" role="alert" data-testid={`${testId}-error`}>
            {failure}
          </p>
        ) : null}
        <div className="set-mconfirm__actions">
          <button type="button" className="set-mconfirm__cancel" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="set-mconfirm__go"
            onClick={() => void confirm()}
            disabled={pending}
            data-testid={`${testId}-go`}
          >
            {pending ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
