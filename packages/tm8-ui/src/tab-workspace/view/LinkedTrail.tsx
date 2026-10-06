/** Linked-entity trail under the strip (Spec A §11). Workstream H. */
import type { EntityTabRecord } from '../runtime/types';

export interface LinkedTrailProps {
  tab: EntityTabRecord;
}

export function LinkedTrail({ tab }: LinkedTrailProps) {
  const trail = tab.ui.trail;
  if (!trail || trail.length === 0) return null;
  return (
    <nav className="tws-trail" aria-label="Linked trail">
      {trail.map((crumb) => crumb.title).join(' › ')}
    </nav>
  );
}
