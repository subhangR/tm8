/**
 * ARRIVALS (D31): what a redirected desktop address asks Work to open.
 *
 * GateApp answers a retired address (`/home…`, the old `/workspace?p=…`,
 * `e/{id}`, `k/{slug}`) with `workRedirectOf`, lands on Work with replace
 * history, and queues the rest here. The mounted Work view drains the queue
 * AFTER its persistence restore, so a redirect never stops a reload from
 * bringing the viewer's own tabs back (persistence hydrates a pristine store
 * only).
 *
 * The activated tab is not queued: it rides in the route (`?tab=`) and the URL
 * sync opens it as a deeplink. This opens the others, sets the browser kind,
 * seeds the activated tab's linked trail and opens its chat dock.
 */
import type { WorkspaceRuntime } from './dispatch';
import { isWorkspaceKind, type KindId, type TrailCrumb } from './types';

export interface WorkArrival {
  /** Entity ids to open as background tabs, in order. */
  open: string[];
  /** The tab the route activates (`?tab=`), or null. */
  activate: string | null;
  /** Ids walked before `activate`, oldest first: its seeded linked trail. */
  trail: string[];
  /** A Work kind for the browser, or null to keep it. */
  browserKind: KindId | null;
  /** Open the activated tab's chat dock on this thread. */
  chat: { thread: string } | null;
}

const pending = new Map<string, WorkArrival>();
const listeners = new Set<() => void>();
const keyOf = (viewerId: string, spaceId: string) => `${viewerId}\u0000${spaceId}`;

/** Queue an arrival for (viewer, space); a later one replaces an undrained one. */
export function queueWorkArrival(viewerId: string, spaceId: string, arrival: WorkArrival): void {
  pending.set(keyOf(viewerId, spaceId), arrival);
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever an arrival is queued. Returns the unsubscribe. */
export function onWorkArrival(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface DrainContext {
  viewerId: string;
  spaceId: string;
  /** The kind of an entity known only by id; undefined when not a Work kind. */
  resolveKind(entityId: string): Promise<KindId | undefined>;
  /** A known title, for trail crumbs. */
  titleOf(entityId: string): string;
}

function tabIdOf(runtime: WorkspaceRuntime, entityId: string): string | null {
  const state = runtime.store.getState();
  for (const id of state.orderedTabIds) {
    const tab = state.tabs[id];
    if (tab?.type === 'entity' && tab.entityId === entityId) return id;
  }
  return null;
}

/** Wait (bounded) until the URL sync has opened `entityId`. */
async function tabOpened(runtime: WorkspaceRuntime, entityId: string): Promise<string | null> {
  for (let waited = 0; waited <= 8000; waited += 100) {
    const id = tabIdOf(runtime, entityId);
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Apply the queued arrival for this runtime, if any. */
export function drainWorkArrival(runtime: WorkspaceRuntime, ctx: DrainContext): void {
  const key = keyOf(ctx.viewerId, ctx.spaceId);
  const arrival = pending.get(key);
  if (!arrival) return;
  pending.delete(key);
  if (arrival.browserKind && isWorkspaceKind(arrival.browserKind)) {
    runtime.dispatch({
      command: 'workspace.browser.set',
      args: { browserId: 'main', kind: arrival.browserKind },
      source: 'deeplink',
    });
  }
  void (async () => {
    for (const entityId of arrival.open) {
      if (entityId === arrival.activate) continue;
      const kind = await ctx.resolveKind(entityId);
      if (!kind || tabIdOf(runtime, entityId)) continue;
      runtime.dispatch({ command: 'workspace.tabs.open', args: { kind, entityId, activate: false }, source: 'system' });
    }
    if (!arrival.activate || (arrival.trail.length === 0 && !arrival.chat)) return;
    const tabId = await tabOpened(runtime, arrival.activate);
    if (!tabId) return;
    const trail: TrailCrumb[] = [];
    for (const entityId of arrival.trail) {
      const kind = await ctx.resolveKind(entityId);
      if (kind) trail.push({ entityId, kind, title: ctx.titleOf(entityId) });
    }
    runtime.dispatch({
      command: 'workspace.tabs.setUi',
      args: {
        tabId,
        patch: {
          ...(trail.length ? { trail } : {}),
          ...(arrival.chat ? { chat: { open: true, threadId: arrival.chat.thread } } : {}),
        },
      },
      source: 'system',
    });
  })();
}
