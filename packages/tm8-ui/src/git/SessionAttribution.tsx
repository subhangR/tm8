import type { CommitSessionAttribution } from '@tm8/contract';
import { Pill } from '../kit';

/**
 * THE ATTRIBUTION OVERLAY, one honesty rule wearing one component. A commit's
 * session comes ONLY from the `created_in` provenance edge (082) — the server
 * joins it, this component renders it. Three states, all named:
 *   · joined      → the session (and teammate when the graph names one), a
 *                   click-through to its panel when the host wired one;
 *   · null        → "no tm8 session recorded" — an ABSENT FACT rendered as an
 *                   absent claim, never a guess from author name or timestamp;
 *   · uncommitted → the caller says so itself (blame's all-zero oid) and never
 *                   reaches this component with a session.
 */
export function SessionAttribution({
  session,
  onOpenEntity,
}: {
  session: CommitSessionAttribution | null;
  onOpenEntity?: ((id: string) => void) | undefined;
}) {
  if (session === null) {
    return (
      <span className="pn-attribution pn-attribution--none" data-testid="attribution-none">
        <Pill tone="idle">no tm8 session recorded</Pill>
      </span>
    );
  }
  const label = session.teamMemberName !== null && session.teamMemberName !== ''
    ? `${session.teamMemberName} · ${session.sessionTitle}`
    : session.sessionTitle;
  return (
    <span className="pn-attribution" data-testid="attribution-session">
      <Pill tone="info">tm8 session</Pill>
      <button
        type="button"
        className="pn-project-git__link"
        data-testid="attribution-open-session"
        onClick={onOpenEntity ? () => onOpenEntity(session.sessionId) : undefined}
        disabled={!onOpenEntity}
        title={session.sessionId}
      >
        {label !== '' ? label : `session ${session.sessionId.slice(0, 8)}…`}
      </button>
    </span>
  );
}
