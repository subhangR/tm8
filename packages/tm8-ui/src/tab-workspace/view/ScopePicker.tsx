/** Tab scope control and popover (Spec A §7). Workstream D. */
import { useWorkspaceState } from './context';

export function ScopePicker() {
  const scope = useWorkspaceState((s) => s.scope);
  const label = scope.mode === 'mixed' ? 'Mixed' : `By type · ${scope.selectedTypeIds.length}`;
  return (
    <button type="button" className="tws-quiet-btn tws-scope-btn" aria-label="Workspace tab scope" data-testid="tws-scope">
      {label} ▾
    </button>
  );
}
