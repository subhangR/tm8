/**
 * Placement execution — EVERY grammar drop (and every keyboard equivalent)
 * commits through `runPlacement`: exactly ONE `facade.placements` command,
 * optimistically applied, reconciled by clientMutationId, with typed-error
 * rollback (DEV-8/DEV-9) and the undo token registered for the toast.
 *
 * Rollback semantics:
 *  - `version_conflict` (409): adopt the server's `current` truth, toast
 *    "Edited by X just now" (X best-effort from the entity's latest activity).
 *  - `invariant_violation` / `forbidden` / anything else: plain rollback +
 *    a generic error toast. No merge dialogs, ever.
 */
import { nextMutationId } from '../collections';
import { useCollectionsStore, useGraphStore } from '../stores';
import { pushToast } from '../subsystems/live';
import { describeError } from '../subsystems/palette';
import {
  isCollabError, type CommandResult, type EntityDetail, type EntitySummary,
  type PlacementInput,
} from '../types/contract';
import type { CollabFacade } from '../facade';
import type { DragSourceRef, DropTargetRef, PlacementOption } from './grammar';
import { registerUndo } from './undo';

export interface PlacementRun {
  source: DragSourceRef;
  target: DropTargetRef;
  option: PlacementOption;
  /** Composer text for the attach-with-embed variant (defaults to card-only). */
  embedMessage?: string;
}

export interface PlacementOutcome {
  ok: boolean;
  result?: CommandResult;
  error?: Error;
  /** Server truth attached to a version_conflict rejection. */
  conflict?: EntityDetail;
}

/** Patch summaries into every store that renders them (same as collections). */
export function applyEverywhere(summaries: EntitySummary[]): void {
  if (summaries.length === 0) return;
  useGraphStore.getState().ingestSummaries(summaries);
  const collections = useCollectionsStore.getState();
  for (const s of summaries) collections.applyEntityPatch(s);
}

/**
 * Best-effort name of who last touched the entity, for the 409 toast.
 * The contract carries no `updatedBy`, so we read the newest activity item.
 */
async function editorName(facade: CollabFacade, current: EntityDetail): Promise<string> {
  try {
    const page = await facade.getActivity(current.id);
    return page.items[0]?.actor?.displayName ?? 'someone';
  } catch {
    return 'someone';
  }
}

export async function runPlacement(facade: CollabFacade, run: PlacementRun): Promise<PlacementOutcome> {
  const { source, target, option } = run;
  const clientMutationId = nextMutationId();
  const graph = useGraphStore.getState();

  // Hierarchy moves change a summary we may already hold — paint it now.
  // Edge/message placements have no local summary field to patch; they show
  // through the command's `patches` after the (mocked) round-trip.
  const before = graph.entities[source.entityId];
  const movesHierarchy = option.intent === 'subtask' || option.intent === 'reparent';
  const optimistic: EntitySummary[] = movesHierarchy && before
    ? [{ ...before, parentId: target.entityId }]
    : [];
  if (optimistic.length > 0) {
    graph.applyOptimistic(clientMutationId, optimistic);
    const collections = useCollectionsStore.getState();
    for (const p of optimistic) collections.applyEntityPatch(p);
  }

  const input: PlacementInput = {
    sourceId: source.entityId,
    targetId: target.entityId,
    intent: option.intent,
    clientMutationId,
  };
  if (option.withEmbed) input.embedMessage = run.embedMessage ?? '';

  try {
    const result = await facade.placements(input);
    useGraphStore.getState().reconcile(clientMutationId);
    applyEverywhere(result.patches);
    if (result.undo) registerUndo(result.undo);
    pushToast({
      kind: 'success',
      message: result.undo?.label ?? option.ghost,
      entityId: source.entityId,
    });
    return { ok: true, result };
  } catch (e) {
    useGraphStore.getState().rollback(clientMutationId);
    if (before) applyEverywhere([before]);
    if (isCollabError(e) && e.code === 'version_conflict' && e.current) {
      applyEverywhere([e.current]);
      const who = await editorName(facade, e.current);
      pushToast({
        kind: 'error',
        message: `Edited by ${who} just now — showing the latest version.`,
        entityId: e.current.id,
      });
      return { ok: false, error: e, conflict: e.current };
    }
    pushToast({ kind: 'error', message: `${option.label} failed — ${describeError(e)}` });
    return { ok: false, error: e as Error };
  }
}
