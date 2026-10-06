/** `workspace.tabScope.set` — atomic scope change, then §5.3 resolution. */
import { isWorkspaceKind } from '../types';
import type { KindId, TabScope, WorkspaceHooks, WorkspaceState } from '../types';
import { isRecord, reject, resolveAfterScopeChange, type Plan, type Planner } from './shared';

function sameScope(a: TabScope, b: TabScope): boolean {
  if (a.mode !== b.mode) return false;
  const ids = (s: TabScope) => (s.mode === 'mixed' ? s.lastByTypeIds : s.selectedTypeIds).join(',');
  return ids(a) === ids(b);
}

function normalizeKinds(ids: readonly KindId[]): KindId[] {
  return [...new Set(ids)].sort();
}

/**
 * Apply a scope to state. Exported for `interactions.resolve`, which runs a
 * scope change and then replays (§5.6 steps 3–4).
 */
export function applyScope(
  state: WorkspaceState,
  request: { mode: 'mixed' } | { mode: 'byType'; selectedTypeIds?: KindId[] },
  hooks: WorkspaceHooks,
): Plan {
  let scope: TabScope;
  if (request.mode === 'mixed') {
    // Mixed keeps the last applied By type set.
    const last = state.scope.mode === 'byType' ? state.scope.selectedTypeIds : state.scope.lastByTypeIds;
    scope = { mode: 'mixed', lastByTypeIds: last };
  } else {
    let ids = request.selectedTypeIds;
    // By type from Mixed with no ids restores `lastByTypeIds`.
    if ((ids === undefined || ids.length === 0) && state.scope.mode === 'mixed') ids = state.scope.lastByTypeIds;
    if (!ids || ids.length === 0) return reject('invalid_arguments');
    if (!ids.every(isWorkspaceKind)) return reject('unsupported_kind');
    scope = { mode: 'byType', selectedTypeIds: normalizeKinds(ids) };
  }
  if (sameScope(scope, state.scope)) return { type: 'commit', next: state };
  return { type: 'commit', next: resolveAfterScopeChange({ ...state, scope }, hooks) };
}

export const setScope: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args)) return reject('invalid_arguments');
  if (args.mode === 'mixed') return applyScope(state, { mode: 'mixed' }, hooks);
  if (args.mode !== 'byType') return reject('invalid_arguments');
  const ids = args.selectedTypeIds;
  if (ids !== undefined && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
    return reject('invalid_arguments');
  }
  return applyScope(state, { mode: 'byType', ...(ids ? { selectedTypeIds: ids as KindId[] } : {}) }, hooks);
};
