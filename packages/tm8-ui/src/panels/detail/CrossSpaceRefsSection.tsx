import type { CrossSpaceRef } from '@tm8/contract';
import { Chip, Eyebrow } from '../../kit';
import { KindIcon } from '../../domain';

export type CrossSpaceRefsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; refs: CrossSpaceRef[] };

/** What a chip shows: the live target when the viewer can read it, the snapshot otherwise. */
export function crossSpaceRefShown(ref: CrossSpaceRef): { kind: string; title: string; live: boolean } {
  return ref.live
    ? { kind: ref.live.kind, title: ref.live.title, live: true }
    : { kind: ref.kind, title: ref.titleSnapshot, live: false };
}

/**
 * IN OTHER SPACES — an entity's cross-space references (279, lane L3), in its
 * Connections tab. They are not edges (edges never cross spaces, D3), so they
 * are drawn as their own chip row rather than among the LINKED peers.
 *
 * A chip resolves LIVE only when the viewer can read the target entity; the
 * server decides that per viewer. Otherwise it shows the kind and title
 * snapshotted when the reference was made, and says so. Titles are graph
 * content from another space: rendered as text, never as markup.
 *
 * Presentational: `views/crossSpaceRefsSurface.tsx` reads and removes. Nothing
 * is drawn while there are no references, so every other entity is unchanged.
 */
export function CrossSpaceRefsSection({
  state,
  onRemove,
}: {
  state: CrossSpaceRefsState;
  onRemove?: (ref: CrossSpaceRef) => void;
}) {
  if (state.phase === 'loading') return null;
  if (state.phase === 'error') {
    return (
      <section className="pn-section" data-testid="cross-space-refs">
        <Eyebrow faint>IN OTHER SPACES</Eyebrow>
        <p className="pn-muted" role="alert">{state.message}</p>
      </section>
    );
  }
  if (state.refs.length === 0) return null;
  return (
    <section className="pn-section" data-testid="cross-space-refs">
      <Eyebrow faint>{`IN OTHER SPACES · ${state.refs.length}`}</Eyebrow>
      <div className="pn-chiprow">
        {state.refs.map((ref) => {
          const shown = crossSpaceRefShown(ref);
          const where = `space ${ref.targetSpaceId}`;
          return (
            <span key={ref.id} className="pn-xref" data-testid="cross-space-ref" data-live={shown.live ? 'true' : 'false'}>
              <Chip
                glyph={<KindIcon kind={shown.kind} />}
                title={shown.live
                  ? `${shown.title} — in ${where}`
                  : `${shown.title} — snapshot from ${ref.updatedAt}; you cannot read it in ${where}`}
              >
                {shown.title}
                {shown.live ? null : <span className="pn-muted"> · snapshot</span>}
              </Chip>
              {onRemove ? (
                <button
                  type="button"
                  className="pn-xref__remove"
                  aria-label={`Remove the reference to ${shown.title}`}
                  onClick={() => onRemove(ref)}
                >
                  ×
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
    </section>
  );
}
