/** `workspace.chooser.open` and the read-only `workspace.inspect`. */
import type { ChooserTabRecord } from '../types';
import { activate, toFront, type Planner } from './shared';

/** Reuse or create the one chooser, move it to index 0, activate it. */
export const openChooser: Planner = ({ state, hooks }) => {
  const existing = state.orderedTabIds.map((id) => state.tabs[id]).find((tab) => tab?.type === 'chooser');
  if (existing) {
    const orderedTabIds = toFront(state.orderedTabIds, existing.id);
    const moved = orderedTabIds.some((id, i) => id !== state.orderedTabIds[i]);
    const next = activate(moved ? { ...state, orderedTabIds } : state, existing.id, hooks);
    return { type: 'commit', next, result: { tabId: existing.id, outcome: 'reused' } };
  }
  const record: ChooserTabRecord = { id: hooks.newId(), type: 'chooser', query: '' };
  const next = activate(
    { ...state, tabs: { ...state.tabs, [record.id]: record }, orderedTabIds: toFront(state.orderedTabIds, record.id) },
    record.id,
    hooks,
  );
  return { type: 'commit', next, result: { tabId: record.id, outcome: 'created' } };
};

export const inspectPlan: Planner = () => ({ type: 'inspect' });
