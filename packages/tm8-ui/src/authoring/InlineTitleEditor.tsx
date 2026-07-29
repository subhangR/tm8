import { useEffect, useRef, useState } from 'react';

/**
 * THE INLINE-EDITABLE TITLE.
 *
 * The title remains click/F2/Enter editable where the registry and server
 * permit it. The earlier dotted underline treatment was removed by user
 * direction; interaction semantics and keyboard access remain unchanged.
 *
 * WHICH TITLES LOCK, and why the caller decides rather than this component:
 * T0-4 draws three locked cases and each states its own reason — message
 * ("title is the excerpt, never editable"), member ("identity is theirs"),
 * commit ("tracked from GitHub"). Those reasons are per-kind sentences, which
 * makes them registry DATA (L2). This component takes `editable` and
 * `lockedReason` and knows nothing about kinds.
 *
 * THE ORACLE'S KEY LAW, from T5-6's generic-create caption: "Type the name,
 * enter commits, esc keeps the placeholder."
 *   · Enter  → commit, but ONLY if the text actually changed.
 *   · Escape → revert and exit. No command is sent at all.
 *   · Blur   → COMMIT if changed. See the note on `onBlur` below; this is a
 *              call made in this lane, flagged for ratification.
 *
 * THE CARET. T5-6 draws a 1.5px brass bar with `animation:pnPulse` beside the
 * text — that is a static mock drawing what a real caret looks like. A real
 * `<input>` has one, so we colour it brass (`caret-color`) rather than drawing
 * a second one beside it. Two carets in one field is a defect a transcription
 * produces and nobody notices in jsdom.
 */
export function InlineTitleEditor({
  value,
  editable,
  lockedReason,
  placeholder = false,
  autoFocus = false,
  onCommit,
  onCancel,
}: {
  value: string;
  /** Server truth (`capabilities.canEdit`) AND the kind's own lock, resolved by the caller. */
  editable: boolean;
  /** Why it is locked — shown on the title itself, so the lock is stated and not merely felt. */
  lockedReason?: string;
  /**
   * The value is the create-flow PLACEHOLDER ("Untitled task"), not a name the
   * user chose. T5-6 draws it in ink-4 rather than ink; once a real title
   * exists it is ordinary ink. DERIVED FROM the oracle's own colour choice,
   * which paints the placeholder state only.
   */
  placeholder?: boolean;
  /** The create flow opens straight into edit — "Z3 opens, title in inline-edit focus". */
  autoFocus?: boolean;
  onCommit(title: string): void;
  onCancel?(): void;
}) {
  const [editing, setEditing] = useState(autoFocus && editable);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement | null>(null);
  // Guards the blur handler while Escape is unmounting the field: without it
  // Escape would revert AND then the blur would commit the reverted value,
  // which is a no-op today and would stop being one the moment blur-commit
  // grows any side effect.
  const cancelling = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (!editable || !editing) {
    return (
      <span
        className={editable ? 'au-title au-title--editable' : 'au-title'}
        data-testid="authoring-title"
        data-placeholder={placeholder ? 'true' : undefined}
        title={editable ? value : lockedReason ? `${value} — ${lockedReason}` : value}
        role={editable ? 'button' : undefined}
        tabIndex={editable ? 0 : undefined}
        onClick={editable ? () => setEditing(true) : undefined}
        onKeyDown={
          editable
            ? (e) => {
                if (e.key === 'Enter' || e.key === 'F2') {
                  e.preventDefault();
                  setEditing(true);
                }
              }
            : undefined
        }
      >
        {value}
      </span>
    );
  }

  const finish = (commit: boolean) => {
    setEditing(false);
    if (commit && draft !== value) onCommit(draft);
    if (!commit) {
      setDraft(value);
      onCancel?.();
    }
  };

  return (
    <input
      ref={input}
      className="au-title-input"
      data-testid="authoring-title-input"
      aria-label="Title"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          // C6 layer 4: Esc in a focused field belongs to the FIELD. Consumed
          // here so it never also pops the panel stack underneath.
          e.stopPropagation();
          cancelling.current = true;
          finish(false);
        }
      }}
      /**
       * BLUR COMMITS IF CHANGED — a call made in this lane, flagged in the
       * handover for ratification because the oracle does not draw it.
       *
       * The two candidate behaviours both lose something, so it is a choice of
       * which loss: blur-reverts silently destroys typed text on a stray click
       * (a bug report), while blur-commits saves something the user typed and
       * can immediately edit again (not a bug report). Every save here is
       * version-checked and reversible, which is what makes the asymmetry
       * decidable rather than a matter of taste. Escape keeps the explicit
       * discard path the oracle DOES state.
       */
      onBlur={() => {
        if (cancelling.current) {
          cancelling.current = false;
          return;
        }
        finish(true);
      }}
    />
  );
}
