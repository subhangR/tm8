import { useState, type DragEvent, type ReactNode } from 'react';

/**
 * SHARE-INTO-SESSION drop target — row 8 of the drop grammar (RULING F).
 *
 * PHASE 1 IS DELIBERATELY REFUSING. `handoffs.send` is a §10.7 deferred seam
 * amendment, so the facade cannot perform this action, and L6 is categorical:
 * a ghost may never advertise an action the facade cannot perform. The target
 * is therefore VISIBLE (the user learns the gesture exists), LABELLED with the
 * honest reason, and NON-ACCEPTING.
 *
 * The refusal is implemented the only way a browser respects: by NOT calling
 * `preventDefault()` on dragover. That is what makes a drop zone reject — the
 * platform then shows the "no drop" cursor and fires no drop event, so there
 * is no window in which the UI could appear to accept and then silently
 * discard. Swallowing a drop and showing a toast afterwards would be exactly
 * the "silent drop" the canvas forbids.
 *
 * When the amendment is stamped, `accept` flips to true and the same
 * component starts calling preventDefault and firing `onShare` — no new
 * surface, no new copy path.
 */

export function ShareDropTarget({
  /** Whom the drop would share WITH — the ghost states receiver + verb. */
  receiverName,
  /** Honest reason while the operation is unavailable (§10.7). */
  unavailableReason,
  /** Flips when `handoffs.send` clears dual re-consensus. */
  accept = false,
  onShare,
  children,
}: {
  receiverName: string;
  unavailableReason: string;
  accept?: boolean;
  onShare?: (payload: string) => void;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    // ONLY preventDefault when the action is genuinely available: that call is
    // the browser-level promise "you may drop here".
    if (accept) e.preventDefault();
    setOver(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setOver(false);
    if (!accept) return; // unreachable while non-accepting; belt and braces
    e.preventDefault();
    onShare?.(e.dataTransfer.getData('text/plain'));
  };

  const cls = [
    'pn-drop',
    over ? 'pn-drop--over' : '',
    accept ? '' : 'pn-drop--refused',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid="share-drop-target"
      data-accept={accept ? 'true' : 'false'}
      aria-disabled={accept ? undefined : 'true'}
      /* The reason is on the element itself, so it is reachable by pointer
         and by AT without the user having to attempt a drag first. */
      title={accept ? `Share with ${receiverName}` : unavailableReason}
    >
      <span className="pn-drop__label">
        {accept ? `share with ${receiverName} ▸` : `can’t share here — ${shortReason(unavailableReason)}`}
      </span>
      {children}
    </div>
  );
}

/**
 * The drop label is a single narrow line; the full sentence stays on `title`.
 * Takes the clause before the first colon or em-dash — the reason strings are
 * authored cause-first for exactly this.
 */
function shortReason(reason: string): string {
  const head = reason.split(/[:—]/)[0]?.trim();
  return head && head.length > 0 ? head.toLowerCase() : reason;
}

/**
 * The drag ghost. Names the RECEIVER and the VERB before release, so no drop
 * is ever a surprise — "share with forge ▸", not a nameless floating chip.
 * Row 8 promises NO UNDO (R7 defers it entirely), so the copy says so before
 * the mouse comes up rather than after.
 */
export function ShareDragGhost({
  entityLabel,
  receiverName,
  glyph,
  refused,
}: {
  entityLabel: string;
  receiverName: string;
  glyph?: string;
  /** True while the target cannot accept — the ghost must not promise. */
  refused?: boolean;
}) {
  return (
    <div className="pn-ghost" data-testid="share-drag-ghost" data-refused={refused ? 'true' : 'false'}>
      <span className="pn-ghost__chip">
        {glyph ? <span aria-hidden>{glyph} </span> : null}
        {entityLabel}
      </span>
      <span className={refused ? 'pn-ghost__verb pn-ghost__verb--refused' : 'pn-ghost__verb'}>
        {refused ? 'can’t share here' : `share with ${receiverName} ▸`}
      </span>
      {!refused ? <span className="pn-ghost__warn">can’t be undone</span> : null}
    </div>
  );
}
