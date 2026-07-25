/**
 * Store barrel + the one event router: every WorkspaceEvent flows through
 * dispatchWorkspaceEvent so graph/collections/presence stay consistent.
 */
import { hasConnectionControl, type CollabFacade } from '../facade/CollabFacade';
import type { SpaceId, Unsubscribe, WorkspaceEvent } from '../types/contract';
import { useCollectionsStore } from './collections';
import { useConnectionStore } from './connection';
import { useGraphStore } from './graph';
import { usePresenceStore } from './presence';

export * from './graph';
export * from './nav';
export * from './collections';
export * from './presence';
export * from './connection';

export function dispatchWorkspaceEvent(event: WorkspaceEvent): void {
  useGraphStore.getState().applyEvent(event);
  usePresenceStore.getState().applyEvent(event);
  if (event.type === 'entity.upsert') {
    useCollectionsStore.getState().applyEntityPatch(event.entity);
  } else if (event.type === 'entity.deleted') {
    useCollectionsStore.getState().removeEntity(event.entity.id);
  }
}

/**
 * Wire the facade's two channels into the stores: the durable event stream
 * plus the client-synthesized presence channel (DEV-4 — presence/typing never
 * ride `subscribe`). Returns a combined unsubscribe.
 */
export function connectStores(facade: CollabFacade, spaceId: SpaceId): Unsubscribe {
  const unsubEvents = facade.subscribe(spaceId, dispatchWorkspaceEvent);
  const unsubPresence = facade.subscribePresence(spaceId, dispatchWorkspaceEvent);
  // DEF-17: facades exposing ConnectionControl feed the connection store
  // (offline banner + queued composer); others are treated as always connected.
  let unsubConnection: Unsubscribe | null = null;
  if (hasConnectionControl(facade)) {
    useConnectionStore.getState().setConnected(facade.isConnected());
    unsubConnection = facade.subscribeConnection((connected) =>
      useConnectionStore.getState().setConnected(connected));
  }
  return () => { unsubEvents(); unsubPresence(); unsubConnection?.(); };
}
