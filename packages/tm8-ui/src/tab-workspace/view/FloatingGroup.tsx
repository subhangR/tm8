/** Floating group (Spec A §8): section switcher · verbs · ⤢ · ⋯. Workstream E. */
import { useWorkspace } from './context';
import type { EntityTabRecord } from '../runtime/types';

export interface FloatingGroupProps {
  tab: EntityTabRecord;
}

export function FloatingGroup({ tab }: FloatingGroupProps) {
  const { dispatch } = useWorkspace();
  return (
    <div className="tws-floating" data-testid="tws-floating" data-tab={tab.id}>
      <button
        type="button"
        className="tws-icon-btn"
        aria-label="Expand"
        title="Expand"
        onClick={() => dispatch({ command: 'workspace.layout.set', args: { expanded: true }, source: 'click' })}
      >
        ⤢
      </button>
    </div>
  );
}
