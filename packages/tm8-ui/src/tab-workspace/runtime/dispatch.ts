/**
 * The dispatcher — the ONLY writer of Workspace state in this window (Spec B §3):
 *
 *   reduce (validate → policy → expectedRevision → plan) → commit → effects → Result
 *
 * The command semantics are `reduce` from `@tm8/contract/workspace`, the same
 * function the node runs for server-side apply (Spec D §2); this file only
 * lands its commits in the store, runs their `after` steps and the effects.
 * Commits are synchronous, so they are serialized by construction.
 *
 * Every top-level dispatch is reported to `onDispatched` listeners with the
 * ids it minted: the server sync (`serverSync.ts`) sends the same command and
 * ids to the node, which then reproduces the identical result.
 */
import { reduce } from '@tm8/contract/workspace';

import { draftStoreFor, type DraftStore } from './draftStore';
import { requestDraftFocus } from './draftFocus';
import { inspect } from './selectors';
import { getWorkspaceStore, newUuid, storeKey, type WorkspaceStore } from './store';
import type {
  CommandEnvelope,
  Result,
  TypedCommand,
  WorkspaceEffect,
  WorkspaceHooks,
  WorkspaceInspection,
} from './types';

// ---------------------------------------------------------------------------
// Effects registry
// ---------------------------------------------------------------------------

const globalEffects = new Set<WorkspaceEffect>();

/** Register an effect for EVERY runtime (e.g. a module-level logger). Returns the unregister. */
export function registerEffect(effect: WorkspaceEffect): () => void {
  globalEffects.add(effect);
  return () => globalEffects.delete(effect);
}

/** One top-level dispatch, as the server sync needs it. */
export interface DispatchRecord {
  env: CommandEnvelope;
  /** Ids `hooks.newId` minted during this dispatch, in order. */
  ids: string[];
  result: Result;
  /** True when at least one commit changed state significantly. */
  significant: boolean;
  /** True when any commit changed state at all. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface WorkspaceRuntime {
  readonly viewerId: string;
  readonly spaceId: string;
  readonly store: WorkspaceStore;
  readonly drafts: DraftStore;
  /** The single entry point. Synchronous commit; effects after. */
  dispatch(env: CommandEnvelope | TypedCommand): Result;
  inspect(): WorkspaceInspection;
  /** The current hooks (read at call time; replace with `setHooks`). */
  readonly hooks: WorkspaceHooks;
  /** Patch hooks; returns a restore function that puts the previous ones back. */
  setHooks(patch: Partial<WorkspaceHooks>): () => void;
  /** Register an effect for this runtime only. Returns the unregister. */
  registerEffect(effect: WorkspaceEffect): () => void;
  /** Listen to every top-level dispatch (Spec D sync). Returns the unregister. */
  onDispatched(listener: (record: DispatchRecord) => void): () => void;
}

export function createWorkspaceRuntime(viewerId: string, spaceId: string, store: WorkspaceStore): WorkspaceRuntime {
  const draftStore = draftStoreFor({ viewerId, spaceId });
  const effects = new Set<WorkspaceEffect>();
  const dispatched = new Set<(record: DispatchRecord) => void>();
  let runtime!: WorkspaceRuntime;

  let hooks: WorkspaceHooks = {
    deleteDraft: (draftId) => draftStore.delete(draftId),
    draftRevision: (draftId) => draftStore.revisionOf(draftId),
    toast: () => {},
    captureUi: () => undefined,
    canCreate: () => true,
    newId: newUuid,
    openEntity: (kind, entityId) =>
      void runtime.dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'click' }),
    focusDraft: (tabId) => requestDraftFocus(tabId),
    openDialog: () => ({ status: 'rejected', reason: 'dialog_unavailable' }),
    closeDialog: () => ({ status: 'rejected', reason: 'dialog_unavailable' }),
    showWorkspace: () => ({ status: 'rejected', reason: 'view_unavailable' }),
    viewMounted: () => false,
    userTyping: () => false,
  };

  const runEffects = (event: Parameters<WorkspaceEffect>[0]) => {
    for (const effect of [...globalEffects, ...effects]) {
      try {
        effect(event);
      } catch (error) {
        console.error('[workspace] effect failed', error);
      }
    }
  };

  const dispatch = (env: CommandEnvelope): Result => {
    // Record the ids this dispatch mints, so the node can mint the same ones.
    const ids: string[] = [];
    const recording: WorkspaceHooks = {
      ...hooks,
      newId: () => {
        const id = hooks.newId();
        ids.push(id);
        return id;
      },
    };
    const reduction = reduce(store.getState(), env, recording, {
      onPlannerError: (command, error) => console.error('[workspace] planner failed', command, error),
    });
    let significant = false;
    let changed = false;
    for (const commit of reduction.commits) {
      const didChange = commit.next !== commit.prev;
      if (didChange) store.setState(commit.next, true);
      for (const fn of commit.after) {
        try {
          fn();
        } catch (error) {
          console.error('[workspace] post-commit step failed', error);
        }
      }
      if (didChange) {
        changed = true;
        significant ||= commit.significant;
        runEffects({ env: commit.env, result: commit.result, prev: commit.prev, next: commit.next, significant: commit.significant, viewerId, spaceId });
      }
    }
    const record: DispatchRecord = { env, ids, result: reduction.result, significant, changed };
    for (const listener of dispatched) {
      try {
        listener(record);
      } catch (error) {
        console.error('[workspace] dispatch listener failed', error);
      }
    }
    return reduction.result;
  };

  runtime = {
    viewerId,
    spaceId,
    store,
    drafts: draftStore,
    dispatch: (env) => dispatch(env as CommandEnvelope),
    inspect: () => inspect(store.getState()),
    get hooks() {
      return hooks;
    },
    setHooks(patch) {
      // Restore only the keys this call patched, and only while they still hold
      // its value: two installers (the shell and the Workspace view) unmount in
      // either order without one putting back the other's stale hooks.
      const keys = Object.keys(patch) as (keyof WorkspaceHooks)[];
      const previous = Object.fromEntries(keys.map((key) => [key, hooks[key]])) as Partial<WorkspaceHooks>;
      hooks = { ...hooks, ...patch };
      return () => {
        const next = { ...hooks };
        for (const key of keys) {
          if (hooks[key] === patch[key]) (next as Record<string, unknown>)[key] = previous[key];
        }
        hooks = next;
      };
    },
    registerEffect(effect) {
      effects.add(effect);
      return () => effects.delete(effect);
    },
    onDispatched(listener) {
      dispatched.add(listener);
      return () => dispatched.delete(listener);
    },
  };
  return runtime;
}

const runtimes = new Map<string, WorkspaceRuntime>();

/** The kept-alive runtime (store + dispatcher) for (viewer, space). */
export function getWorkspaceRuntime(viewerId: string, spaceId: string): WorkspaceRuntime {
  const key = storeKey(viewerId, spaceId);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createWorkspaceRuntime(viewerId, spaceId, getWorkspaceStore(viewerId, spaceId));
    runtimes.set(key, runtime);
  }
  return runtime;
}
