/** The chooser body (Spec A §6 `+`): search over in-scope kinds, Recent, New <kind>. Also the start surface body. Workstream F. */
import type { TabId } from '../runtime/types';

export interface ChooserProps {
  /** The chooser tab, or null when rendered as the start surface. */
  tabId: TabId | null;
  variant: 'tab' | 'start';
}

export function Chooser({ variant }: ChooserProps) {
  return (
    <div className="tws-chooser" data-testid={`tws-chooser-${variant}`}>
      <input className="tws-search" type="search" placeholder="Search…" aria-label="Search entities" />
    </div>
  );
}
