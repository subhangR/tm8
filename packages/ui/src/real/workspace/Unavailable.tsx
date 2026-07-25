/**
 * Shared honest-degradation primitives for the workspace lanes (blueprint §4/§5-C).
 *
 * WHY A PRIMITIVE AND NOT A CONVENTION. `real/capabilities.ts` states which
 * facade methods have no server behind them and which fields are permanently
 * hollow, but stating it does nothing on its own — the screen still has to
 * DECIDE, per affordance, between captioning, disabling and hiding. Left to each
 * lane that decision drifts: one tab hides an unbuilt button, the next renders it
 * enabled and lets it throw, and the product now lies in two different ways. This
 * file makes the three rules callable so all three lanes degrade identically.
 *
 * THE THREE RULES, and why each is what it is:
 *
 *   READ not built     → CAPTION the empty region (`<Unavailable method>`).
 *                        An unlabelled empty list is indistinguishable from "you
 *                        have nothing", and only one of those is true.
 *
 *   WRITE not built    → render the affordance DISABLED with the reason in a
 *                        `title` (`disabledBecause`). Never hidden — the user
 *                        hunts for a control that isn't there. Never enabled —
 *                        that is a 501 in the user's face.
 *
 *   FIELD hollow       → prefer HIDING the affordance to rendering the zero
 *                        (`isHollow`), and where the region must exist, caption
 *                        it (`<HollowNote field>`). A real 0 and an unbuilt 0
 *                        are pixel-identical.
 *
 * Styling is INLINE on purpose. This is imported by all three lanes; putting it
 * in one lane's stylesheet would make every other lane's rendering depend on a
 * file it does not own and cannot see in its own tests.
 */
import type { ReactNode } from 'react';
import { hollowReason, isHollow, isUnavailable } from '../capabilities';

const NOTE_STYLE = { opacity: 0.6, fontSize: 12, fontStyle: 'italic' as const, margin: 0 };

/**
 * The sentence a disabled affordance carries, phrased as a property of THIS NODE
 * rather than of the product. "Not implemented on this node" is the true
 * statement — the operation exists in the contract and is unbuilt here — and it
 * tells the reader the difference between "we don't do that" and "not yet".
 */
export function unavailableReason(method: string): string | null {
  return isUnavailable(method) ? `${method} is not implemented on this node` : null;
}

/**
 * Caption for a read that isn't built. Renders NOTHING when the method is real,
 * so a call site can wrap it around a genuinely-empty list unconditionally and
 * the caption appears only when the emptiness is a gap rather than a fact.
 */
export function Unavailable({ method, children, testId }: {
  method: string;
  children?: ReactNode;
  testId?: string;
}) {
  if (!isUnavailable(method)) return null;
  return (
    <p className="ws-unavailable" style={NOTE_STYLE} data-testid={testId ?? `unavailable-${method}`}>
      {children ?? 'not available on this node'}
    </p>
  );
}

/**
 * Caption for a PRESENT-BUT-PERMANENTLY-EMPTY field. Separate from `Unavailable`
 * because the two failures read differently to a user: an unbuilt read shows
 * nothing and admits it, whereas a hollow field shows a confident value that is
 * structurally valid and semantically meaningless. Renders nothing when the
 * field is real, so wiring it in costs nothing once the server fills the gap.
 */
export function HollowNote({ field, children, testId }: {
  field: string;
  children?: ReactNode;
  testId?: string;
}) {
  const reason = hollowReason(field);
  if (!reason) return null;
  return (
    <p className="ws-hollow" style={NOTE_STYLE} data-testid={testId ?? `hollow-${field}`}>
      {children ?? reason}
    </p>
  );
}

/**
 * A caption for a gap that `capabilities.ts` does not key — the reason is known
 * locally (a session that exited, a pane with nothing selected) rather than
 * being a property of the node. Always renders: the caller has already decided
 * there is something to say.
 */
export function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="ws-note" style={NOTE_STYLE} data-testid={testId}>{children}</p>
  );
}

/**
 * Props to spread onto a control whose write isn't built: `disabled`, with the
 * reason in `title`.
 *
 * `extraReason` lets a caller disable for its OWN reason (an exited session, an
 * empty draft) through the same helper, so a button has one disabled path
 * instead of two that can disagree. The capability check wins when both apply —
 * "unbuilt" is the more fundamental answer and the one a bug report needs.
 */
export function disabledBecause(method: string, extraReason?: string | null): {
  disabled: boolean;
  title?: string;
} {
  const unbuilt = unavailableReason(method);
  if (unbuilt) return { disabled: true, title: unbuilt };
  if (extraReason) return { disabled: true, title: extraReason };
  return { disabled: false };
}

export { isHollow, hollowReason, isUnavailable };
