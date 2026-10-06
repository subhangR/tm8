/**
 * The Workspace's share route (Spec A §4, §12): `tabs?tab=<active entity id>`.
 * GateApp builds the account menu's Copy link row before the Workspace view
 * mounts, so it reads the active entity here, straight from the kept-alive
 * store for (viewer, space). Null outside the Workspace view.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { EntityId } from '@tm8/contract';
import type { NavView } from '../../routes/types';
import { activeEntityId } from '../runtime/selectors';
import { getWorkspaceStore } from '../runtime/store';
import type { WorkspaceState } from '../runtime/types';

/** Subscribed while the Workspace is not mounted, so the hook stays unconditional. */
const IDLE_STORE = createStore<WorkspaceState | null>()(() => null);

export function useWorkspaceShareRoute(viewerId: string | null, spaceId: string | null, active: boolean): NavView | null {
  const store = active && viewerId && spaceId ? getWorkspaceStore(viewerId, spaceId) : IDLE_STORE;
  const entityId = useStore(store as typeof IDLE_STORE, (state) => (state ? activeEntityId(state) : null));
  if (store === IDLE_STORE) return null;
  return entityId ? { view: 'tabs', tab: entityId as EntityId } : { view: 'tabs' };
}
