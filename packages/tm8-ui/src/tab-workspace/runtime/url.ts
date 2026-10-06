/**
 * Active tab ↔ URL sync (Spec B §7 "Router", Spec A §12).
 *
 * The address is `#/s/{space}/work?tab=<entityId>` while an entity tab is
 * active, and the bare `#/s/{space}/work` for a draft, the chooser or no tab
 * (D31: `work` is canonical; `tabs` still decodes, as a permanent alias).
 * It is written through the router's own store (`navStore`), never through
 * `location.hash`: `attachRouter` builds the hash with the codec and owns
 * push vs replaceState.
 *
 * OUT (state → URL): a runtime effect after each commit. A person activating
 * a tab (click / keyboard / palette / deeplink on open, activate, a new draft
 * or the chooser) PUSHES; everything else — scope changes and their
 * fallbacks, closes, restore, system binds, history — REPLACES. Writes that
 * bypass dispatch (persistence's restore hydrate) are caught by a store
 * subscription and always replace.
 *
 * IN (URL → state): when the routed `tab` differs from the active entity —
 * Back/Forward, or a pasted address — open it through the normal flow with
 * source `history` (`deeplink` for the address the view mounted with). The
 * codec carries only the entity id, so the kind comes from an open tab with
 * that id, else from the data layer (`resolveKind`).
 */
import type { SpaceId, EntityId } from '@tm8/contract';
import { build, defaultRoute } from '../../routes/codec';
import type { NavView } from '../../routes/types';
import { navStore } from '../../stores/navStore';
import type { WorkspaceRuntime } from './dispatch';
import type { WorkspaceInitContext } from './persistence';
import { activeEntityId } from './selectors';
import type { CommandName, KindId, Source, WorkspaceState } from './types';

export interface UrlSyncContext extends WorkspaceInitContext {
  /** The route's `?tab=` (entity id) at mount, if any. */
  routeTab: string | undefined;
  /** Write a route view (push). */
  navigateView(view: NavView): void;
  /**
   * ADDITIVE. The kind of an entity known only by id (the URL carries no
   * kind). Resolves undefined when it cannot be learned; the tab is then not
   * opened.
   */
  resolveKind?(entityId: string): Promise<KindId | undefined>;
}

/** The route view for a Workspace address. */
export function workspaceTabView(entityId?: string | null): NavView {
  return entityId ? { view: 'tabs', tab: entityId as EntityId } : { view: 'tabs' };
}

/**
 * The shareable URL of the Workspace with `entityId` as the active tab (the
 * bare Workspace without one). One spelling for every Copy link item.
 */
export function workspaceTabUrl(spaceId: string, entityId?: string | null): string {
  const { hash } = build(defaultRoute(spaceId as SpaceId, workspaceTabView(entityId)));
  if (typeof window === 'undefined') return hash;
  return new URL(hash, `${window.location.origin}${window.location.pathname}`).toString();
}

const PUSH_SOURCES: readonly Source[] = ['click', 'keyboard', 'palette', 'deeplink'];
const PUSH_COMMANDS: readonly CommandName[] = [
  'workspace.tabs.open',
  'workspace.tabs.activate',
  'workspace.drafts.open',
  'workspace.chooser.open',
];

function routedTab(): { inTabs: boolean; tab: string | null } {
  const view = navStore.getState().view;
  return view.view === 'tabs' ? { inTabs: true, tab: view.tab ?? null } : { inTabs: false, tab: null };
}

/** Write the Workspace route view with replace history (no new entry). */
function replaceView(view: NavView): void {
  navStore.setState((s) => ({ view, history: 'replace', revision: s.revision + 1 }));
}

function kindOfOpenTab(state: WorkspaceState, entityId: string): KindId | undefined {
  for (const id of state.orderedTabIds) {
    const tab = state.tabs[id];
    if (tab?.type === 'entity' && tab.entityId === entityId) return tab.kind;
  }
  return undefined;
}

/** Wire URL sync for one runtime. Returns the teardown. */
export function initUrlSync(runtime: WorkspaceRuntime, ctx: UrlSyncContext): () => void {
  let disposed = false;

  const syncOut = (mode: 'push' | 'replace') => {
    const routed = routedTab();
    if (!routed.inTabs) return;
    const want = activeEntityId(runtime.store.getState());
    if (routed.tab === want) return;
    if (mode === 'push') ctx.navigateView(workspaceTabView(want));
    else replaceView(workspaceTabView(want));
  };

  /** Open the routed entity unless it is already the active tab. */
  const syncIn = async (entityId: string, source: Source) => {
    if (activeEntityId(runtime.store.getState()) === entityId) return;
    const kind = kindOfOpenTab(runtime.store.getState(), entityId) ?? (await ctx.resolveKind?.(entityId));
    // The address may have moved on while the kind was resolving.
    if (disposed || !kind || routedTab().tab !== entityId) return;
    runtime.dispatch({ command: 'workspace.tabs.open', args: { kind, entityId, activate: true }, source });
  };

  /** States a dispatch effect already synced; the store listener skips them. */
  const handled = new WeakSet<WorkspaceState>();
  const unregister = runtime.registerEffect(({ env, prev, next }) => {
    handled.add(next);
    if (activeEntityId(prev) === activeEntityId(next)) return;
    const push = PUSH_SOURCES.includes(env.source) && PUSH_COMMANDS.includes(env.command);
    syncOut(push ? 'push' : 'replace');
  });

  // Non-dispatch writes (restore). Effects run synchronously right after the
  // commit's setState, so by this microtask a dispatched state is in `handled`.
  const unsubscribeStore = runtime.store.subscribe((next, prev) => {
    if (activeEntityId(prev) === activeEntityId(next)) return;
    queueMicrotask(() => {
      if (!disposed && !handled.has(next) && runtime.store.getState() === next) syncOut('replace');
    });
  });

  // Back/Forward and pasted addresses land in navStore through attachRouter.
  let lastTab = routedTab().tab;
  const unsubscribeNav = navStore.subscribe(() => {
    const routed = routedTab();
    if (!routed.inTabs || routed.tab === lastTab) return;
    lastTab = routed.tab;
    if (routed.tab) void syncIn(routed.tab, 'history');
  });

  // Mount: a deep link opens its tab; otherwise the address follows the state.
  if (ctx.routeTab) void syncIn(ctx.routeTab, 'deeplink');
  else syncOut('replace');

  return () => {
    disposed = true;
    unregister();
    unsubscribeStore();
    unsubscribeNav();
  };
}
