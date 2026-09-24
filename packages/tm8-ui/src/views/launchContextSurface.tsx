/**
 * The session Connections tab's LAUNCH CONTEXT section, composed ONCE for
 * every host that mounts an `EntityDetailPanel` — the `debugSurfaceFor` shape,
 * for the same reason: the panel is presentational and never reaches for the
 * seam, so a host that hand-rolled this could drift or forget it.
 *
 * The panel renders it only for a work session, so building it for any other
 * kind costs nothing: the read happens on mount.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { LaunchContextSection, type LaunchContextState } from '../panels/detail/LaunchContextSection';

export function launchContextSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  onOpenEntity?: (id: string) => void,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return <LaunchContextSurface seam={seam} sessionId={entityId as EntityId} onOpenEntity={onOpenEntity} />;
}

function LaunchContextSurface({
  seam,
  sessionId,
  onOpenEntity,
}: {
  seam: Seam;
  sessionId: EntityId;
  onOpenEntity?: (id: string) => void;
}) {
  const [state, setState] = useState<LaunchContextState>({ phase: 'loading' });
  // ONE read, no poll: a launch record is written at spawn and never changes.
  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    seam.launch(sessionId).then(
      (record) => { if (!cancelled) setState({ phase: 'ready', record }); },
      (err: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: err instanceof Error ? err.message : 'launch record read failed' });
        }
      },
    );
    return () => { cancelled = true; };
  }, [seam, sessionId]);
  return <LaunchContextSection state={state} onOpenEntity={onOpenEntity} />;
}
