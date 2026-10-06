/**
 * Gate-side opens into the Workspace (W2-H). The ⌘K palette is mounted by
 * GateApp, outside the Workspace view; on the tabs route its entity picks open
 * as Workspace tabs (source `palette`, a direct open: no trail) instead of on
 * Home's route.
 */
import { getWorkspaceRuntime } from './runtime/dispatch';
import { isWorkspaceKind } from './runtime/types';

/** Open `entityId` as a Workspace tab. `false` ⇒ not a Workspace kind; the caller falls back. */
export function openInWorkspace(viewerId: string, spaceId: string, kind: string, entityId: string): boolean {
  if (!isWorkspaceKind(kind)) return false;
  getWorkspaceRuntime(viewerId, spaceId).dispatch({
    command: 'workspace.tabs.open',
    args: { kind, entityId },
    source: 'palette',
  });
  return true;
}
