/**
 * THE Workspace reducer (Spec B §3, Spec D §2): the one implementation of the
 * command semantics, run by the window's dispatcher AND by the node.
 *
 *   validate source → remote policy → expectedRevision → plan → (pending | commit)
 *
 * Pure over the state it is given: it returns the commits it would make, in
 * order (a resolved interaction makes two — the resolution, then the replayed
 * command), and the Result. It never touches a store, never runs `after`
 * thunks and never runs effects; the caller does, commit by commit, exactly as
 * the dispatcher always has. Determinism across window and node rests on
 * `hooks.newId`: a window records the ids it consumed and sends them, so the
 * node mints the same ones.
 */
import { browser, drafts, external, interactions, layout, panels, rail, scope, tabs } from './commands/index.js';
import type { Plan, Planner } from './commands/shared.js';
import { inspect } from './selectors.js';
import { ACCEPTED_SOURCES, COMMAND_NAMES, UI_SOURCES } from './types.js';
import type { CommandEnvelope, CommandName, Result, WorkspaceHooks, WorkspaceState } from './types.js';

export const PLANNERS: Record<CommandName, Planner> = {
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
  'workspace.rail.set': rail.setRail,
};

/**
 * Never from remote. `interactions.resolve` is the human's answer (UI sources
 * only, below); `drafts.bind` is the draft host's own completion (system
 * only); `drafts.markDirty` would let a caller mark a draft clean so a later
 * close discards it without asking.
 */
export const REMOTE_FORBIDDEN: ReadonlySet<CommandName> = new Set([
  'workspace.interactions.resolve',
  'workspace.drafts.bind',
  'workspace.drafts.markDirty',
]);

/** Commands that act on the mounted Workspace view; in a window elsewhere they are refused, never queued. */
export const REMOTE_NEEDS_VIEW: ReadonlySet<CommandName> = new Set(
  COMMAND_NAMES.filter(
    (name) => !['workspace.inspect', 'workspace.dialogs.open', 'workspace.dialogs.close', 'workspace.view.set'].includes(name),
  ),
);

/**
 * Spec D §4: what still needs a live window. Everything else applies to the
 * stored workspace on the node.
 */
export const WINDOW_ONLY_COMMANDS: ReadonlySet<CommandName> = new Set([
  'workspace.dialogs.open',
  'workspace.dialogs.close',
  'workspace.view.set',
  'workspace.tabs.activate',
  'workspace.chooser.open',
  'workspace.interactions.resolve',
]);

/** Commands that move the human's focus — refused while they are typing. */
export function takesFocus(env: CommandEnvelope): boolean {
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

/** One state transition, as the dispatcher commits it. */
export interface WorkspaceCommit {
  env: CommandEnvelope;
  prev: WorkspaceState;
  next: WorkspaceState;
  /** True when `revision` moved (false for scroll-only commits). */
  significant: boolean;
  result: Result;
  /** Post-commit side effects; the caller runs them after the commit lands. */
  after: readonly (() => void)[];
}

export interface Reduction {
  /** The state after every commit (the input state when nothing committed). */
  state: WorkspaceState;
  result: Result;
  commits: WorkspaceCommit[];
}

export interface ReduceOptions {
  /** True while replaying a resolved interaction's command (§5.6). */
  replay?: boolean;
  /** Called when a planner throws; the command is answered invalid_arguments. */
  onPlannerError?: (command: string, error: unknown) => void;
}

function rejected(state: WorkspaceState, reason: Result['reason']): Reduction {
  return { state, result: { status: 'rejected', revision: state.revision, ...(reason ? { reason } : {}) }, commits: [] };
}

export function reduce(
  state: WorkspaceState,
  env: CommandEnvelope,
  hooks: WorkspaceHooks,
  options: ReduceOptions = {},
): Reduction {
  const replay = options.replay === true;
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
    return { state, result: { status: 'conflict', revision: state.revision, reason: 'revision_conflict' }, commits: [] };
  }
  // 3. Plan.
  let plan: Plan;
  try {
    plan = PLANNERS[env.command]({ state, env, hooks, replay });
  } catch (error) {
    options.onPlannerError?.(env.command, error);
    return rejected(state, 'invalid_arguments');
  }

  const commit = (
    prev: WorkspaceState,
    next: WorkspaceState,
    significant: boolean,
    result: Omit<Result, 'revision'>,
    after: readonly (() => void)[] = [],
  ): { state: WorkspaceState; result: Result; commit: WorkspaceCommit | null } => {
    const changed = next !== prev;
    const bump = changed && significant;
    const final = changed ? { ...next, revision: prev.revision + (bump ? 1 : 0) } : prev;
    const out: Result = {
      ...result,
      status: result.status === 'applied' && !changed ? 'no_op' : result.status,
      revision: final.revision,
    };
    // `after` thunks run even for an unchanged state (a reused draft still
    // takes focus), so an unchanged commit is still reported.
    return {
      state: final,
      result: out,
      commit: changed || after.length > 0 ? { env, prev, next: final, significant: bump, result: out, after } : null,
    };
  };

  switch (plan.type) {
    case 'reject':
      return rejected(state, plan.reason);
    case 'inspect':
      return { state, result: { status: 'no_op', revision: state.revision, inspection: inspect(state) }, commits: [] };
    case 'external':
      return { state, result: { ...plan.result, revision: state.revision }, commits: [] };
    case 'choice': {
      // 4. One blocking interaction at a time; a replay never re-prompts.
      if (state.pending) return rejected(state, 'busy');
      if (replay) return rejected(state, plan.pending.reason);
      const pending = { ...plan.pending, id: hooks.newId(), command: env, revisionAtRequest: state.revision };
      const c = commit(state, { ...state, pending }, true, {
        status: 'requires_user_choice',
        reason: plan.pending.reason,
        pendingInteractionId: pending.id,
        choices: pending.choices,
      });
      return { state: c.state, result: c.result, commits: c.commit ? [c.commit] : [] };
    }
    case 'commit': {
      const { status = 'applied', ...rest } = plan.result ?? {};
      const c = commit(state, plan.next, plan.significant !== false, { status, ...rest }, plan.after);
      return { state: c.state, result: c.result, commits: c.commit ? [c.commit] : [] };
    }
    case 'replay': {
      const first = commit(state, plan.next, true, { status: 'applied' }, plan.after);
      // The original command, exactly once, through the full pipeline.
      const second = reduce(first.state, plan.command, hooks, { ...options, replay: true });
      return {
        state: second.state,
        result: second.result,
        commits: [...(first.commit ? [first.commit] : []), ...second.commits],
      };
    }
  }
}
