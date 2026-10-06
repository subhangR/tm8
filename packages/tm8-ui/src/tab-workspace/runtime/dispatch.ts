/**
 * The dispatcher — the ONLY writer of Workspace state (Spec B §3):
 *
 *   validate source → expectedRevision → plan → (pending | commit) → effects → Result
 *
 * Commits are synchronous, so they are serialized by construction. A commit
 * bumps `revision` only when state actually changed (and not for scroll-only
 * patches). Effects run after the commit; persistence and URL sync plug in
 * through `registerEffect` without editing this file.
 */
import { browser, drafts, external, interactions, layout, panels, scope, tabs } from './commands';
import type { Plan, Planner } from './commands/shared';
import { draftStoreFor, type DraftStore } from './draftStore';
import { inspect } from './selectors';
import { getWorkspaceStore, newUuid, storeKey, type WorkspaceStore } from './store';
import { ACCEPTED_SOURCES, COMMAND_NAMES, UI_SOURCES } from './types';
import type {
  CommandEnvelope,
  CommandName,
  Result,
  TypedCommand,
  WorkspaceEffect,
  WorkspaceHooks,
  WorkspaceInspection,
  WorkspaceState,
} from './types';

const PLANNERS: Record<CommandName, Planner> = {
  'workspace.inspect': panels.inspectPlan,
  'workspace.browser.set': browser.setBrowser,
  'workspace.tabScope.set': scope.setScope,
  'workspace.tabs.open': tabs.open,
  'workspace.tabs.activate': tabs.activateTab,
  'workspace.tabs.close': tabs.close,
  'workspace.tabs.closeVisible': tabs.closeVisible,
  'workspace.tabs.move': tabs.move,
  'workspace.tabs.setUi': tabs.setUi,
  'workspace.drafts.open': drafts.openDraft,
  'workspace.drafts.markDirty': drafts.markDirty,
  'workspace.drafts.bind': drafts.bind,
  'workspace.chooser.open': panels.openChooser,
  'workspace.layout.set': layout.setLayout,
  'workspace.interactions.resolve': interactions.resolve,
  'workspace.dialogs.open': external.openDialog,
  'workspace.dialogs.close': external.closeDialog,
  'workspace.view.set': external.setView,
};

// ---------------------------------------------------------------------------
// The remote policy (Spec C §4): what a command from the node's bridge may do
// ---------------------------------------------------------------------------

/**
 * Never from remote. `interactions.resolve` is the human's answer (UI sources
 * only, below); `drafts.bind` is the draft host's own completion (system
 * only); `drafts.markDirty` would let a caller mark a draft clean so a later
 * close discards it without asking.
 */
const REMOTE_FORBIDDEN: ReadonlySet<CommandName> = new Set([
  'workspace.interactions.resolve',
  'workspace.drafts.bind',
  'workspace.drafts.markDirty',
]);

/** Commands that act on the mounted Workspace view; elsewhere they are refused, never queued. */
const REMOTE_NEEDS_VIEW: ReadonlySet<CommandName> = new Set(
  COMMAND_NAMES.filter(
    (name) => !['workspace.inspect', 'workspace.dialogs.open', 'workspace.dialogs.close', 'workspace.view.set'].includes(name),
  ),
);

/** Commands that move the human's focus — refused while they are typing. */
function takesFocus(env: CommandEnvelope): boolean {
  switch (env.command) {
    case 'workspace.tabs.open': {
      const args = env.args as { activate?: unknown } | null | undefined;
      return args?.activate !== false;
    }
    case 'workspace.tabs.activate':
    case 'workspace.chooser.open':
    case 'workspace.drafts.open':
    case 'workspace.dialogs.open':
    case 'workspace.view.set':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Effects registry
// ---------------------------------------------------------------------------

const globalEffects = new Set<WorkspaceEffect>();

/** Register an effect for EVERY runtime (e.g. a module-level logger). Returns the unregister. */
export function registerEffect(effect: WorkspaceEffect): () => void {
  globalEffects.add(effect);
  return () => globalEffects.delete(effect);
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
}

function rejected(state: WorkspaceState, reason: Result['reason']): Result {
  return { status: 'rejected', revision: state.revision, ...(reason ? { reason } : {}) };
}

export function createWorkspaceRuntime(viewerId: string, spaceId: string, store: WorkspaceStore): WorkspaceRuntime {
  const draftStore = draftStoreFor({ viewerId, spaceId });
  const effects = new Set<WorkspaceEffect>();
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

  const commit = (
    env: CommandEnvelope,
    prev: WorkspaceState,
    next: WorkspaceState,
    significant: boolean,
    result: Omit<Result, 'revision'>,
    after: readonly (() => void)[] = [],
  ): Result => {
    const changed = next !== prev;
    const bump = changed && significant;
    const final = changed ? { ...next, revision: prev.revision + (bump ? 1 : 0) } : prev;
    if (changed) store.setState(final, true);
    const out: Result = {
      ...result,
      status: result.status === 'applied' && !changed ? 'no_op' : result.status,
      revision: final.revision,
    };
    for (const fn of after) {
      try {
        fn();
      } catch (error) {
        console.error('[workspace] post-commit step failed', error);
      }
    }
    if (changed) runEffects({ env, result: out, prev, next: final, significant: bump, viewerId, spaceId });
    return out;
  };

  const run = (env: CommandEnvelope, replay: boolean): Result => {
    const state = store.getState();
    // 0. Shape and source: the local sources, plus `remote` from the bridge.
    if (
      typeof env !== 'object' ||
      env === null ||
      !(COMMAND_NAMES as readonly string[]).includes(env.command) ||
      !ACCEPTED_SOURCES.includes(env.source)
    ) {
      return rejected(state, typeof env === 'object' && env && !ACCEPTED_SOURCES.includes(env.source) ? 'permission_denied' : 'invalid_arguments');
    }
    // 1. The remote policy (Spec C §4), before anything can plan or prompt.
    if (env.source === 'remote' && !replay) {
      if (REMOTE_FORBIDDEN.has(env.command)) return rejected(state, 'permission_denied');
      if (REMOTE_NEEDS_VIEW.has(env.command) && !hooks.viewMounted()) return rejected(state, 'view_unavailable');
      if (takesFocus(env) && hooks.userTyping()) return rejected(state, 'user_typing');
    }
    if (env.command === 'workspace.drafts.bind' && env.source !== 'system') return rejected(state, 'permission_denied');
    if (env.command === 'workspace.interactions.resolve' && !UI_SOURCES.includes(env.source)) {
      return rejected(state, 'permission_denied');
    }
    // 2. Optimistic concurrency.
    if (env.expectedRevision !== undefined && env.expectedRevision !== state.revision) {
      return { status: 'conflict', revision: state.revision, reason: 'revision_conflict' };
    }
    // 3. Plan.
    let plan: Plan;
    try {
      plan = PLANNERS[env.command]({ state, env, hooks, replay });
    } catch (error) {
      console.error('[workspace] planner failed', env.command, error);
      return rejected(state, 'invalid_arguments');
    }

    switch (plan.type) {
      case 'reject':
        return rejected(state, plan.reason);
      case 'inspect':
        return { status: 'no_op', revision: state.revision, inspection: inspect(state) };
      case 'external':
        return { ...plan.result, revision: state.revision };
      case 'choice': {
        // 4. One blocking interaction at a time; a replay never re-prompts.
        if (state.pending) return rejected(state, 'busy');
        if (replay) return rejected(state, plan.pending.reason);
        const pending = { ...plan.pending, id: hooks.newId(), command: env, revisionAtRequest: state.revision };
        const out = commit(env, state, { ...state, pending }, true, {
          status: 'requires_user_choice',
          reason: plan.pending.reason,
          pendingInteractionId: pending.id,
          choices: pending.choices,
        });
        return out;
      }
      case 'commit': {
        // 5–6. Single commit, then effects.
        const { status = 'applied', ...rest } = plan.result ?? {};
        return commit(env, state, plan.next, plan.significant !== false, { status, ...rest }, plan.after);
      }
      case 'replay': {
        commit(env, state, plan.next, true, { status: 'applied' }, plan.after);
        // The original command, exactly once, through the full pipeline.
        return run(plan.command, true);
      }
    }
  };

  runtime = {
    viewerId,
    spaceId,
    store,
    drafts: draftStore,
    dispatch: (env) => run(env as CommandEnvelope, false),
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
