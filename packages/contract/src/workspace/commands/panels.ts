/** `workspace.chooser.open` and the read-only `workspace.inspect`. */
import type { ChooserTabRecord } from '../types.js';
import { activate, afterActive, type Planner } from './shared.js';

/** Reuse or create the one chooser, move it right after the active tab, activate it. */
export const openChooser: Planner = ({ state, hooks }) => {
  const existing = state.orderedTabIds.map((id) => state.tabs[id]).find((tab) => tab?.type === 'chooser');
  if (existing) {
    const orderedTabIds = afterActive(state, existing.id);
    const moved = orderedTabIds.some((id, i) => id !== state.orderedTabIds[i]);
    const next = activate(moved ? { ...state, orderedTabIds } : state, existing.id, hooks);
    return { type: 'commit', next, result: { tabId: existing.id, outcome: 'reused' } };
  }
  const record: ChooserTabRecord = { id: hooks.newId(), type: 'chooser', query: '' };
  const next = activate(
    { ...state, tabs: { ...state.tabs, [record.id]: record }, orderedTabIds: afterActive(state, record.id) },
    record.id,
    hooks,
  );
  return { type: 'commit', next, result: { tabId: record.id, outcome: 'created' } };
};

export const inspectPlan: Planner = () => ({ type: 'inspect' });
