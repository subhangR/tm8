/**
 * THE WORKSPACE BODY AND STRIP, HOSTED OUTSIDE THE WORKSPACE (Craft → Designs,
 * change list items 10–11). A design's page shows the same entity body and
 * action strip a Workspace tab does; those components read one context — a
 * runtime, its store, the gate handles — so a host that is not the tab strip
 * gives them a PRIVATE runtime of its own.
 *
 * PRIVATE AND NEVER PERSISTED: the runtime is created per host mount, with no
 * persistence, no URL sync and no tab strip. It holds only what the body and
 * strip keep per entity (the section, the Expand flag). The viewer's real
 * Workspace — `getWorkspaceRuntime(viewer, space)` — is never touched, and a
 * design keeps no per-user tab state (D5): the page row is the design's.
 */
import { useMemo, type ReactNode } from 'react';
import { createWorkspaceRuntime, type WorkspaceRuntime } from './runtime/dispatch';
import { createWorkspaceStore } from './runtime/store';
import type { EntityTabRecord } from './runtime/types';
import { WorkspaceProvider, type WorkspaceContextValue, type WorkspaceGateHandles } from './view/context';

export { ActionStrip, type ActionStripOwner } from './view/ActionStrip';
export { useEntityChromeValue } from './view/ContentHost';
export { EntityChromeContext, EntityTabBody, type EntityChromeContextValue } from './adapters/entity';
export { getKindAdapter } from './adapters/registry';
export type { EntityTabRecord } from './runtime/types';
export type { WorkspaceRuntime } from './runtime/dispatch';

/** A fresh private runtime for one host mount. */
export function useEmbeddedRuntime(viewerId: string, spaceId: string): WorkspaceRuntime {
  return useMemo(() => createWorkspaceRuntime(viewerId, spaceId, createWorkspaceStore(viewerId, spaceId)), [viewerId, spaceId]);
}

/**
 * The record for `entityId` in the private store, seeded on first ask. The
 * tab id IS the entity id: there is one record per entity in a host.
 *
 * Seeded by a direct store write because `workspace.tabs.open` admits only
 * Workspace kinds (graph and design are not), and this record is host
 * scaffolding — never shown on a strip, never persisted — not a tab the
 * viewer opened. Every later change goes through `dispatch`.
 */
export function embeddedTab(runtime: WorkspaceRuntime, entityId: string, kind: string): EntityTabRecord {
  const state = runtime.store.getState();
  const existing = state.tabs[entityId];
  if (existing?.type === 'entity' && existing.kind === kind) return existing;
  const record: EntityTabRecord = { id: entityId, type: 'entity', kind, entityId, ui: { subview: 'entity' } };
  runtime.store.setState({
    ...state,
    tabs: { ...state.tabs, [entityId]: record },
    orderedTabIds: state.orderedTabIds.includes(entityId) ? state.orderedTabIds : [...state.orderedTabIds, entityId],
  });
  return record;
}

export function EmbeddedWorkspace({
  runtime,
  gate,
  children,
}: {
  runtime: WorkspaceRuntime;
  gate: WorkspaceGateHandles;
  children: ReactNode;
}) {
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      runtime,
      store: runtime.store,
      dispatch: runtime.dispatch,
      viewerId: runtime.viewerId,
      spaceId: runtime.spaceId,
      gate,
    }),
    [runtime, gate],
  );
  return <WorkspaceProvider value={value}>{children}</WorkspaceProvider>;
}
