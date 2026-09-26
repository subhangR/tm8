import type { SpawnSelectionGroup } from '@tm8/contract';

import type { LaunchContextRow, LaunchSelectionEdits } from '../domain/launch-selection';

/**
 * THE LAUNCH CARD'S DRAFT, per subject (owner's answer, form 01a0df2c): closing
 * the card with notes or strip edits keeps them, and the next open of the
 * same task starts from them. A successful Launch or Dispatch clears it.
 *
 * Browser-local, like the remembered picks: one viewer's unfinished launch,
 * not the task's state.
 */
export interface LaunchDraft {
  notes: string;
  edits?: LaunchSelectionEdits;
  /** Display rows of the additions, so an added row keeps its title on restore. */
  added?: Partial<Record<SpawnSelectionGroup, readonly LaunchContextRow[]>>;
}

const DRAFTS_KEY = 'tm8.launch.drafts.v1';

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, LaunchDraft> {
  const raw = store()?.getItem(DRAFTS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, LaunchDraft> : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, LaunchDraft>): void {
  try {
    store()?.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {
    /* quota or private mode: a lost draft is only a lost convenience */
  }
}

const isEmpty = (d: LaunchDraft) => !d.notes.trim()
  && (!d.edits || Object.values(d.edits).every((e) => e.added.length === 0 && e.removed.length === 0));

export function readDraft(subjectId: string): LaunchDraft | null {
  return readAll()[subjectId] ?? null;
}

/** Keeps the draft, or drops it when there is nothing in it. */
export function writeDraft(subjectId: string, draft: LaunchDraft): void {
  const all = readAll();
  if (isEmpty(draft)) delete all[subjectId];
  else {
    const added: Partial<Record<SpawnSelectionGroup, readonly LaunchContextRow[]>> = {};
    for (const [group, rows] of Object.entries(draft.added ?? {})) {
      const keep = draft.edits?.[group as SpawnSelectionGroup].added ?? [];
      added[group as SpawnSelectionGroup] = (rows ?? []).filter((r) => keep.includes(r.id));
    }
    all[subjectId] = { notes: draft.notes, ...(draft.edits ? { edits: draft.edits } : {}), added };
  }
  writeAll(all);
}

export function clearDraft(subjectId: string): void {
  const all = readAll();
  if (!(subjectId in all)) return;
  delete all[subjectId];
  writeAll(all);
}
