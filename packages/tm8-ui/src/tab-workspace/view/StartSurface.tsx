/** Start surface (Spec A §13): "No open tabs", search, Recent, New <kind> — the chooser body without a tab. Workstream F. */
import { Chooser } from './Chooser';
import { useWorkspaceState } from './context';

export function StartSurface() {
  const byType = useWorkspaceState((s) => s.scope.mode === 'byType');
  return (
    <div className="tws-start" data-testid="tws-start">
      <h2 className="tws-start-title">{byType ? 'No open tabs for the selected types' : 'No open tabs'}</h2>
      <Chooser tabId={null} variant="start" />
    </div>
  );
}
