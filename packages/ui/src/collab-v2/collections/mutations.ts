/**
 * Collection mutations — every drag in a collection resolves to ONE of these.
 *
 * Optimistic protocol (graph-store journal + collections-store patch):
 *   1. patch the summary locally under a fresh clientMutationId
 *   2. run the facade command with that same id (idempotent replay, DEV-9)
 *   3. success → reconcile the journal entry + apply the server's patches
 *   4. failure → roll back; on `version_conflict` adopt the server's
 *      `current` truth (DEV-8: handling switches on the error CODE).
 */
import type { CollabFacade } from '../facade/CollabFacade';
import { useCollectionsStore } from '../stores/collections';
import { useGraphStore } from '../stores/graph';
import {
  isCollabError, type CommandResult, type EntityDetail, type EntityId,
  type EntitySummary, type WorkStatus,
} from '../types/contract';

let seq = 0;
export function nextMutationId(): string {
  seq += 1;
  return `cv2m_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface MutationOutcome {
  ok: boolean;
  error?: Error;
  /** Server truth attached to a version_conflict (409) rejection. */
  conflict?: EntityDetail;
}

function applyEverywhere(summaries: EntitySummary[]): void {
  if (summaries.length === 0) return;
  useGraphStore.getState().ingestSummaries(summaries);
  const collections = useCollectionsStore.getState();
  for (const s of summaries) collections.applyEntityPatch(s);
}

async function runOptimistic(
  optimistic: EntitySummary[],
  original: EntitySummary[],
  exec: (clientMutationId: string) => Promise<CommandResult>,
): Promise<MutationOutcome> {
  const cmid = nextMutationId();
  useGraphStore.getState().applyOptimistic(cmid, optimistic);
  const collections = useCollectionsStore.getState();
  for (const p of optimistic) collections.applyEntityPatch(p);
  try {
    const res = await exec(cmid);
    useGraphStore.getState().reconcile(cmid);
    applyEverywhere(res.patches);
    return { ok: true };
  } catch (e) {
    useGraphStore.getState().rollback(cmid);
    applyEverywhere(original);
    if (isCollabError(e) && e.code === 'version_conflict' && e.current) {
      applyEverywhere([e.current]);
      return { ok: false, error: e, conflict: e.current };
    }
    return { ok: false, error: e as Error };
  }
}

/** Board drag between workStatus columns → `patchTask({workStatus})`. */
export async function moveTaskToStatus(
  facade: CollabFacade, entity: EntitySummary, to: WorkStatus,
): Promise<MutationOutcome> {
  if (entity.state.kind !== 'task' || entity.state.workStatus === to) return { ok: true };
  const patched: EntitySummary = { ...entity, state: { ...entity.state, workStatus: to } };
  return runOptimistic([patched], [entity], (clientMutationId) =>
    facade.patchTask(entity.id, { expectedVersion: entity.version, workStatus: to, clientMutationId }));
}

/**
 * Board drag between axis columns → `patchTask({axes})`. The facade REPLACES
 * the whole axes map, so send the merged map, not just the changed key.
 */
export async function moveTaskToAxisValue(
  facade: CollabFacade, entity: EntitySummary, axis: string, value: string,
): Promise<MutationOutcome> {
  if (entity.state.kind !== 'task' || entity.state.axes[axis] === value) return { ok: true };
  const axes = { ...entity.state.axes, [axis]: value };
  const patched: EntitySummary = { ...entity, state: { ...entity.state, axes } };
  return runOptimistic([patched], [entity], (clientMutationId) =>
    facade.patchTask(entity.id, { expectedVersion: entity.version, axes, clientMutationId }));
}

/** Board drag between assignee columns → placement intent `assign`. */
export async function assignTaskTo(
  facade: CollabFacade, entity: EntitySummary, actorId: EntityId,
): Promise<MutationOutcome> {
  if (entity.state.kind === 'task'
    && entity.state.assignees.some((a) => a.id === actorId)) return { ok: true };
  // No local ActorSummary to paint optimistically — rely on the command's
  // patches (the mock emits the fresh summary synchronously after latency).
  return runOptimistic([], [], (clientMutationId) =>
    facade.placements({ sourceId: entity.id, targetId: actorId, intent: 'assign', clientMutationId }));
}

/** Tree drag onto a new parent (same kind) → `moveEntity`. */
export async function reparentEntity(
  facade: CollabFacade, entity: EntitySummary, parentId: EntityId | null, position: number,
): Promise<MutationOutcome> {
  if (entity.parentId === parentId) return { ok: true };
  const patched: EntitySummary = { ...entity, parentId };
  return runOptimistic([patched], [entity], (clientMutationId) =>
    facade.moveEntity(entity.id, { parentId, position, expectedVersion: entity.version, clientMutationId }));
}
