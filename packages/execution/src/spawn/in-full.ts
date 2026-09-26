// The in-full channel's one-listing rule (launch card v3, contract decision
// 1): an entity sent in full is not ALSO a memory, an index entry or a
// `<linked>` line. In full wins. Pure, and applied by `composeManifest` to the
// context it composes from, so spawn, resume and `launch.preview` dedup alike.
import type { PromptContextGroup } from '@tm8/prompt';
import type { SpawnContext } from './types.js';

export interface InFullDuplicate {
  entityId: string;
  kind: string;
  title: string;
}

/**
 * `context` with every in-full id taken out of the memories, the selected
 * references and the tasks' `linked`, and what was taken out. Unchanged (the
 * same object) when nothing is sent in full.
 */
export function dedupInFull(context: SpawnContext): { context: SpawnContext; duplicates: InFullDuplicate[] } {
  const inFull = context.inFull ?? [];
  if (inFull.length === 0) return { context, duplicates: [] };
  const ids = new Set(inFull.map((entity) => entity.entityId));
  const titles = new Map(inFull.map((entity) => [entity.entityId, entity]));
  const duplicates = new Map<string, InFullDuplicate>();
  const note = (id: string): void => {
    const entity = titles.get(id);
    if (entity && !duplicates.has(id)) duplicates.set(id, { entityId: id, kind: entity.kind, title: entity.title });
  };

  // Memories: the first `memoryIds.length` texts are the entities, in order,
  // and `memoryVia` is aligned with them; the legacy remainder has no ids.
  let teamMember = context.teamMember;
  let contextAudit = context.contextAudit;
  const memoryIds = teamMember.memoryIds;
  if (memoryIds?.some((id) => ids.has(id))) {
    const keep = memoryIds.map((id) => !ids.has(id));
    memoryIds.forEach((id, i) => { if (!keep[i]) note(id); });
    teamMember = {
      ...teamMember,
      memoryIds: memoryIds.filter((_, i) => keep[i]),
      memories: [
        ...teamMember.memories.slice(0, memoryIds.length).filter((_, i) => keep[i]),
        ...teamMember.memories.slice(memoryIds.length),
      ],
    };
    if (contextAudit) {
      contextAudit = { ...contextAudit, memoryVia: contextAudit.memoryVia.filter((_, i) => keep[i]) };
    }
  }

  const references = context.references?.filter((ref) => {
    if (!ids.has(ref.entityId)) return true;
    note(ref.entityId);
    return false;
  });

  const tasks = context.tasks.map((task) => {
    if (!task.linked?.some((item) => ids.has(item.entityId))) return task;
    const linked = task.linked.filter((item) => {
      if (!ids.has(item.entityId)) return true;
      note(item.entityId);
      return false;
    });
    const removed = task.linked.length - linked.length;
    return {
      ...task,
      linked,
      ...(task.linkedTotal === undefined ? {} : { linkedTotal: Math.max(0, task.linkedTotal - removed) }),
    };
  });

  // Skills stay equipped (the harness may load them natively); only their
  // index entry gives way, in `withoutInFullEntries`.
  for (const skill of context.skillEquips ?? context.skills ?? []) {
    if (ids.has(skill.entityId)) note(skill.entityId);
  }

  return {
    context: {
      ...context,
      teamMember,
      tasks,
      ...(references === undefined ? {} : { references }),
      ...(contextAudit === undefined ? {} : { contextAudit }),
    },
    duplicates: [...duplicates.values()],
  };
}

/** Index candidate groups without any entity sent in full. */
export function withoutInFullEntries(groups: readonly PromptContextGroup[], context: SpawnContext): PromptContextGroup[] {
  const ids = new Set((context.inFull ?? []).map((entity) => entity.entityId));
  if (ids.size === 0) return [...groups];
  return groups.map((group) => ({ ...group, entries: group.entries.filter((entry) => !ids.has(entry.id)) }));
}
