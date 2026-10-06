/**
 * Persistence (Spec B §8): sessionStorage tabs snapshot, localStorage mirror,
 * prefs and browser state, all scoped `{viewerId}:{spaceId}`. STUB — the
 * Persistence and URL workstream (I) implements load/save/migrate, typically
 * by registering a debounced effect with `runtime.registerEffect`.
 */
import type { WorkspaceRuntime } from './dispatch';

export interface WorkspaceInitContext {
  viewerId: string;
  spaceId: string;
}

/** Wire persistence for one runtime. Returns the teardown (flush + unregister). */
export function initPersistence(runtime: WorkspaceRuntime, ctx: WorkspaceInitContext): () => void {
  void runtime;
  void ctx;
  return () => {};
}
