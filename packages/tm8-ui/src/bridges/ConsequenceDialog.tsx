import { useRef, useState } from 'react';
import { useDismissable } from '../panels/useDismissable';

/**
 * The one confirm for a change that widens who can do what, or deletes data
 * (BRIDGES-V2-DESIGN §1.5): its consequence in words, and a second click.
 *
 * D45: the words are computed from the `bridges.get` facts the page holds
 * (participants, linked, target), not from a server dry run, until
 * `bridges.update --dry-run` serves `consequences[]`. Then this dialog takes
 * the server's list unchanged.
 */
export function ConsequenceDialog({
  title,
  consequences,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  consequences: readonly string[];
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useDismissable(true, dialog, () => { if (!busy) onCancel(); });
  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog" role="alertdialog" aria-modal="true" aria-label={title} data-testid="bridge-consequences">
        <h2 className="brg-dialog__title">{title}</h2>
        <ul className="brg-dialog__list">
          {consequences.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <div className="brg-dialog__actions">
          <button type="button" className="pn-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="pn-btn pn-btn--primary"
            disabled={busy}
            onClick={() => { setBusy(true); void onConfirm().finally(() => setBusy(false)); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
