/**
 * Active tab ↔ URL sync (Spec B §7 "Router"). STUB — workstream I: push on
 * click/keyboard/palette activation, replace on restore/system/scope
 * fallbacks, and on `hashchange` with a differing `tab` dispatch
 * `tabs.open({…, activate:true})` with source `history`.
 */
import type { NavView } from '../../routes/types';
import type { WorkspaceRuntime } from './dispatch';
import type { WorkspaceInitContext } from './persistence';

export interface UrlSyncContext extends WorkspaceInitContext {
  /** The route's `?tab=` (entity id) at mount, if any. */
  routeTab: string | undefined;
  /** Write a route view (push). */
  navigateView(view: NavView): void;
}

/** Wire URL sync for one runtime. Returns the teardown. */
export function initUrlSync(runtime: WorkspaceRuntime, ctx: UrlSyncContext): () => void {
  void runtime;
  void ctx;
  return () => {};
}
