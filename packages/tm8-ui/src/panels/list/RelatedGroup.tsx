import type { ReactNode } from 'react';
import { KindIcon } from '../../domain';

/**
 * THE INLINE RELATION GROUP — what a clicked relation chip opens under its
 * tile (user ruling 2026-08-16).
 *
 * SAME LEVEL, NOT A DEEPER INDENT. Offset is the hierarchy tree's vocabulary
 * (parent → subtask), and these rows are RELATIONS, not children — so the
 * rows render at the owner's own level and the group's only claim of
 * ownership is the thin rail and the eyebrow line. The eyebrow states kind
 * and count so the block reads as "this tile's sessions", not as three loose
 * rows that happen to sit between two tasks.
 *
 * The three states are all stated, never blank:
 *   · loading — the edge projection has not arrived for this row yet;
 *   · empty — hydrated, and genuinely nothing of this kind is linked
 *     (or everything of it is an ancestor of this very expansion, which the
 *     sentence names because a chip promised a count the path suppressed);
 *   · rows — the caller's REAL tiles.
 */
export function RelatedGroup({
  kind,
  label,
  count,
  loading,
  children,
}: {
  kind: string;
  label: string;
  count: number;
  /** True while the row's connections are still unhydrated. */
  loading: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className="lp__related"
      role="group"
      aria-label={`Related ${label.toLowerCase()}`}
      data-testid="related-group"
      data-related-kind={kind}
    >
      <div className="lp__related-head">
        <KindIcon kind={kind} size={11} />
        <span>{`${label.toUpperCase()} · ${count}`}</span>
      </div>
      {loading && count === 0 ? (
        <p className="lp__related-note" data-testid="related-loading">
          {`Loading ${label.toLowerCase()}…`}
        </p>
      ) : count === 0 ? (
        <p className="lp__related-note" data-testid="related-empty">
          {`No linked ${label.toLowerCase()} to show here — anything already open above this row is not repeated.`}
        </p>
      ) : (
        children
      )}
    </div>
  );
}
