/**
 * CenterHost — renders the current route's center view from a pluggable
 * registry. The shell never imports a screen: W3 passes `views`, and anything
 * absent falls back to the data-backed placeholder, so the route is always
 * addressable and always shows real facade data.
 */
import { useCallback } from 'react';
import { useNavStore } from '../stores/nav';
import type { CollabFacade } from '../facade/CollabFacade';
import type { EntityId } from '../types/contract';
import { PlaceholderView } from './placeholders';
import type { ShellViewProps, ViewRegistry } from './types';

export interface CenterHostProps {
  facade: CollabFacade;
  views?: ViewRegistry;
  /** Rendered when no space is selected yet. */
  fallback?: React.ReactNode;
}

export function CenterHost({ facade, views = {}, fallback = null }: CenterHostProps) {
  const spaceId = useNavStore((s) => s.spaceId);
  const view = useNavStore((s) => s.view);
  const entityId = useNavStore((s) => s.entityId);
  const pushPanel = useNavStore((s) => s.pushPanel);
  const setView = useNavStore((s) => s.setView);

  const onOpenEntity = useCallback(
    (id: EntityId, opts?: { replace?: boolean }) => pushPanel({ entityId: id }, opts),
    [pushPanel],
  );

  if (!spaceId) return <main className="cv2-center cv2-center--empty">{fallback}</main>;

  const View = views[view] ?? PlaceholderView;
  const props: ShellViewProps = { facade, spaceId, view, entityId, onOpenEntity, onNavigate: setView };

  return (
    <main className="cv2-center" data-view={view} data-entity={entityId ?? undefined}>
      <View {...props} />
    </main>
  );
}
