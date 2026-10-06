/**
 * `workspace.interactions.resolve` (§5.6). The dispatcher has already
 * refused any source other than click / keyboard.
 */
import { selectedKinds } from '../selectors';
import type { InteractionChoice, TabId, WorkspaceState } from '../types';
import { applyScope } from './scope';
import { isNonEmptyString, isRecord, reject, removeTabs, type Planner } from './shared';

const CHOICES: readonly InteractionChoice[] = ['addType', 'useMixed', 'cancel', 'discard', 'keep'];

export const resolve: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isNonEmptyString(args.interactionId)) return reject('invalid_arguments');
  const choice = args.choice as InteractionChoice;
  if (!CHOICES.includes(choice)) return reject('invalid_arguments');
  const pending = state.pending;
  if (!pending || pending.id !== args.interactionId || !pending.choices.includes(choice)) {
    return reject('invalid_arguments');
  }
  const cleared: WorkspaceState = { ...state };
  delete cleared.pending;

  switch (choice) {
    case 'cancel':
    case 'keep':
      return { type: 'commit', next: cleared };

    case 'addType':
    case 'useMixed': {
      const plan =
        choice === 'useMixed'
          ? applyScope(cleared, { mode: 'mixed' }, hooks)
          : applyScope(
              cleared,
              { mode: 'byType', selectedTypeIds: [...selectedKinds(cleared.scope), ...(pending.targetKind ? [pending.targetKind] : [])] },
              hooks,
            );
      if (plan.type !== 'commit') return plan;
      // Replay the original request exactly once, with its own source; the
      // person has just answered, so a stale expectedRevision does not apply.
      const command = { ...pending.command };
      delete command.expectedRevision;
      return { type: 'replay', next: plan.next, command };
    }

    case 'discard': {
      // A keystroke after the prompt cancels the discard for that draft.
      const changed = new Set<TabId>();
      for (const [tabId, revision] of Object.entries(pending.draftRevisions ?? {})) {
        const tab = state.tabs[tabId];
        if (tab?.type === 'draft' && hooks.draftRevision(tab.draftId) !== revision) changed.add(tabId);
      }
      const ids = (pending.closeTabIds ?? pending.tabIds ?? []).filter((id) => !changed.has(id));
      const { next, after } = removeTabs(cleared, ids, hooks);
      return { type: 'commit', next, after };
    }
  }
};
