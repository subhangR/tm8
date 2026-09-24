// @tm8/execution — the launch-context audit, `manifest.context` (design
// 01a0d348 §6).
//
// The prompt shows an agent what it was given; this records, for the people
// and tools reading the manifest afterwards, what went in, how each entry got
// there, and everything that was left out and why. It is execution-internal
// and carries ids and enums only — never a title, statement or description —
// so it adds no graph text to the manifest beyond what the prompt already
// carries.
//
// Bytes are measured with the prompt's own serializers, so a recorded size is
// the rendered size, not an estimate.

import {
  ATTACHMENT_MANIFEST_MAX,
  LINKED_MANIFEST_MAX,
  serializeAttachmentEntry,
  serializeLinkedEntity,
  serializeMemoryEntry,
  serializeSkillIndexEntry,
  utf8Bytes,
} from '@tm8/prompt';
import type { SkippedSkill } from '@tm8/contract';
import type {
  ContextDrop,
  ContextDropReason,
  ContextEntryRecord,
  ContextGroupAudit,
  ContextGroupName,
  ContextVia,
  ManifestContext,
  ManifestSkillContext,
  SpawnContext,
} from './types.js';

/** The skip reasons that are context drops; the rest stay in `effectiveSkills.skipped` only. */
const SKILL_DROP_REASONS: ReadonlySet<string> = new Set<ContextDropReason>([
  'not-selected',
  'byte-budget',
  'task-name-collision',
  'native-shadowed',
]);

export interface ManifestContextInput {
  context: SpawnContext;
  /** The skills the prompt indexes, after the byte-budget trim, in index order. */
  skills: readonly ManifestSkillContext[];
  /** `effectiveSkills.skipped`, including the byte-budget drops. */
  skippedSkills: readonly SkippedSkill[];
  /** Whether the request carried a selection; the loader's audit wins when present. */
  requestSelected: boolean;
}

/** `groups`, `entries` and `dropped`; the caller keeps `memoryIds`. */
export function buildManifestContext(input: ManifestContextInput): Required<Omit<ManifestContext, 'memoryIds'>> {
  const { context } = input;
  const audit = context.contextAudit;
  const selected = audit?.selected ?? input.requestSelected;
  const entries: ContextEntryRecord[] = [];
  const dropped: ContextDrop[] = [...(audit?.dropped ?? [])];
  const ranks: Record<ContextGroupName, number> = { memories: 0, skills: 0, references: 0, teammates: 0 };
  const add = (entry: Omit<ContextEntryRecord, 'rank'>): void => {
    ranks[entry.group] += 1;
    entries.push({ ...entry, rank: ranks[entry.group] });
  };

  // Memories: the PREFIX RULE — the first `memoryIds.length` texts are these.
  const member = context.teamMember;
  (member.memoryIds ?? []).forEach((entityId, index) => {
    const text = member.memories[index];
    add({
      entityId,
      kind: 'memory',
      group: 'memories',
      via: audit?.memoryVia[index] ?? (selected ? 'selection' : 'teammate'),
      state: 'expanded',
      bytes: typeof text === 'string' ? utf8Bytes(serializeMemoryEntry(text)) : 0,
    });
  });

  // Skills: the kept index, in index order. `+ 1` is the joining newline, as
  // the manifest's own budget pass counts it.
  const rows = new Map((context.skillEquips ?? context.skills ?? []).map((row) => [row.entityId, row]));
  const selectionOnly = new Set(audit?.selectionOnlySkillIds ?? []);
  for (const skill of input.skills) {
    const row = rows.get(skill.entityId) as { viaTaskId?: string; depth?: number } | undefined;
    const via: ContextVia = selectionOnly.has(skill.entityId)
      ? 'selection'
      : row?.viaTaskId
        ? 'task'
        : (row?.depth ?? 0) > 0
          ? 'inherited'
          : 'teammate';
    add({
      entityId: skill.entityId,
      kind: 'skill',
      group: 'skills',
      via,
      state: 'collapsed',
      bytes: utf8Bytes(serializeSkillIndexEntry(skill)) + 1,
    });
  }
  for (const skip of input.skippedSkills) {
    if (!SKILL_DROP_REASONS.has(skip.reason)) continue;
    dropped.push({
      entityId: skip.entityId,
      kind: 'skill',
      group: 'skills',
      reason: skip.reason as ContextDropReason,
      ...(skip.reason === 'byte-budget' ? { level: 'entry' as const } : {}),
    });
  }

  // References and teammates: each task's linked entities and attached files,
  // as its assignment snapshot renders them. Past the snapshot's count cap a
  // row is declared `omitted` in the prompt and recorded here as `count-cap`;
  // past the spawn read it has no id, so it is counted as `unread`.
  // Shown rows first across every task, so an entity one task shows and
  // another caps is recorded as shown.
  const seen = new Set<string>();
  const capped: ContextDrop[] = [];
  let unreadReferences = 0;
  for (const task of context.tasks) {
    const linked = task.linked ?? [];
    linked.forEach((item, index) => {
      const group: ContextGroupName = item.kind === 'team_member' ? 'teammates' : 'references';
      if (index >= LINKED_MANIFEST_MAX) {
        capped.push({ entityId: item.entityId, kind: item.kind, group, reason: 'count-cap', level: 'entry' });
        return;
      }
      if (seen.has(`${group}:${item.entityId}`)) return;
      seen.add(`${group}:${item.entityId}`);
      add({
        entityId: item.entityId,
        kind: item.kind,
        group,
        via: 'linked',
        link: item.link,
        state: 'collapsed',
        bytes: utf8Bytes(serializeLinkedEntity(item)),
      });
    });
    unreadReferences += Math.max(0, (task.linkedTotal ?? linked.length) - linked.length);
    (task.attachments ?? []).forEach((file, index) => {
      if (index >= ATTACHMENT_MANIFEST_MAX) {
        capped.push({ entityId: file.fileEntityId, kind: 'file', group: 'references', reason: 'count-cap', level: 'entry' });
        return;
      }
      if (seen.has(`references:${file.fileEntityId}`)) return;
      seen.add(`references:${file.fileEntityId}`);
      add({
        entityId: file.fileEntityId,
        kind: 'file',
        group: 'references',
        via: 'attached',
        link: 'attached_to',
        state: 'collapsed',
        bytes: utf8Bytes(serializeAttachmentEntry(file)),
      });
    });
  }
  for (const drop of capped) {
    const key = `${drop.group}:${drop.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dropped.push(drop);
  }

  const selectable = (): ContextGroupAudit =>
    selected ? { mode: 'selected' } : { mode: 'default', reason: 'no-selection' };
  const groups: Record<ContextGroupName, ContextGroupAudit> = {
    memories: {
      ...selectable(),
      ...(audit?.legacyMemoriesDropped ? { legacyDropped: audit.legacyMemoriesDropped } : {}),
    },
    skills: selectable(),
    // Selection cannot name references or teammates yet (I6), so they are
    // always the edge defaults.
    references: {
      mode: 'default',
      reason: 'not-selectable',
      ...(unreadReferences > 0 ? { unread: unreadReferences } : {}),
    },
    teammates: { mode: 'default', reason: 'not-selectable' },
  };
  return { groups, entries, dropped };
}
