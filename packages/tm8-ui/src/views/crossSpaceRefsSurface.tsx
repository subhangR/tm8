/**
 * The Connections tab's IN OTHER SPACES section (cross-space references, 279),
 * composed ONCE for every host that mounts an `EntityDetailPanel` — the
 * `launchContextSurfaceFor` shape: the panel is presentational and never
 * reaches for the seam.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CrossSpaceRef, EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { CrossSpaceRefsSection, type CrossSpaceRefsState } from '../panels/detail/CrossSpaceRefsSection';

export function crossSpaceRefsSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return <CrossSpaceRefsSurface key={entityId} seam={seam} entityId={entityId as EntityId} />;
}

function CrossSpaceRefsSurface({ seam, entityId }: { seam: Seam; entityId: EntityId }) {
  const [state, setState] = useState<CrossSpaceRefsState>({ phase: 'loading' });
  useEffect(() => {
    let cancelled = false;
    seam.crossSpaceRefs.list(entityId).then(
      (refs) => { if (!cancelled) setState({ phase: 'ready', refs }); },
      (err: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: err instanceof Error ? err.message : 'cross-space references read failed' });
        }
      },
    );
    return () => { cancelled = true; };
  }, [seam, entityId]);
  const onRemove = useCallback((ref: CrossSpaceRef) => {
    seam.crossSpaceRefs.remove(entityId, ref.id).then(
      () => setState((prev) => prev.phase === 'ready'
        ? { phase: 'ready', refs: prev.refs.filter((r) => r.id !== ref.id) }
        : prev),
      (err: unknown) => setState({ phase: 'error', message: err instanceof Error ? err.message : 'remove failed' }),
    );
  }, [seam, entityId]);
  return <CrossSpaceRefsSection state={state} onRemove={onRemove} />;
}
