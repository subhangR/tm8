/**
 * ADDITIVE (File tabs) `workspace.files.open`: a read-only tab for one file
 * in a connected project folder, keyed by (projectId, path).
 *
 *   already open        focus it; a keep (non-preview) open pins it
 *   preview, none open  replace the one preview tab (or create it)
 *   keep, none open     create a kept tab
 *
 * A new or replaced tab moves right after the active tab (`afterActive`).
 */
import { findFileTab, findPreviewFileTab } from '../selectors.js';
import { isFileTabPath, isFileTabProjectId, type FileTabRecord } from '../types.js';
import { activate, afterActive, isRecord, reject, type Planner } from './shared.js';

export const openFile: Planner = ({ state, env, hooks }) => {
  const args = env.args;
  if (!isRecord(args) || !isFileTabProjectId(args.projectId) || !isFileTabPath(args.path)) return reject('invalid_arguments');
  if (args.preview !== undefined && typeof args.preview !== 'boolean') return reject('invalid_arguments');
  if (args.activate !== undefined && typeof args.activate !== 'boolean') return reject('invalid_arguments');
  const { projectId, path } = args;
  const preview = args.preview === true;
  const shouldActivate = args.activate !== false;

  const existing = findFileTab(state, projectId, path);
  if (existing) {
    let next = state;
    if (!preview && existing.preview) {
      next = { ...next, tabs: { ...next.tabs, [existing.id]: { ...existing, preview: false } } };
    }
    if (shouldActivate) next = activate(next, existing.id, hooks);
    return {
      type: 'commit',
      next,
      result: { tabId: existing.id, outcome: 'focused', ...(next === state ? { status: 'no_op' } : {}) },
    };
  }

  const replaced = preview ? findPreviewFileTab(state) : null;
  const record: FileTabRecord = { id: replaced?.id ?? hooks.newId(), type: 'file', projectId, path, preview };
  let next = {
    ...state,
    tabs: { ...state.tabs, [record.id]: record },
    orderedTabIds: afterActive(state, record.id),
    recency: shouldActivate || replaced ? state.recency : [...state.recency, record.id],
  };
  if (shouldActivate) next = activate(next, record.id, hooks);
  return { type: 'commit', next, result: { tabId: record.id, outcome: replaced ? 'reused' : 'created' } };
};
