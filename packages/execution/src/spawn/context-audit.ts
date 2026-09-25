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
  contextEntryBytes,
  serializeAttachmentEntry,
  serializeLinkedEntity,
  serializeMemoryEntry,
  serializeSkillIndexEntry,
  utf8Bytes,
  type FitContextIndexResult,
  type PromptContextEntry,
} from '@tm8/prompt';
import { SPAWN_SELECTION_REFERENCE_KINDS } from '@tm8/contract';
import type { SkippedSkill, SpawnSelection, SpawnSelectionDefaultReason, SpawnSelectionGroup } from '@tm8/contract';
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
  'missing',
  'disabled',
]);

export interface ManifestContextInput {
  context: SpawnContext;
  /** The skills the prompt indexes, after the byte-budget trim, in index order. */
  skills: readonly ManifestSkillContext[];
  /** `effectiveSkills.skipped`, including the byte-budget drops. */
  skippedSkills: readonly SkippedSkill[];
  /** The request's selection; the loader's audit of which groups it selected wins when present. */
  requestSelection?: SpawnSelection;
  /** The request's per-group reasons for keeping defaults (audit-only, validated at the wire). */
  selectionReasons?: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>>;
  /** A resume could not parse the launch's recorded selection (`SpawnRequest.selectionReplayInvalid`). */
  selectionReplayInvalid?: boolean;
  /**
   * The trimmed `<context_index>`, when the launch rendered one. Its groups
   * are then what the prompt carries for skills, references and teammates,
   * and each of its drops is recorded (`header` or `entry`, `byte-budget`).
   */
  index?: FitContextIndexResult;
  /** The memory collapse (§10 Q1), when one ran; indices are into `teamMember.memoryIds`. */
  memoryCollapse?: import('./context-index.js').MemoryCollapseResult;
}

const REFERENCE_KINDS: ReadonlySet<string> = new Set(SPAWN_SELECTION_REFERENCE_KINDS);

/** The groups a selection names, each as an exact set. */
function selectionGroupsOf(selection: SpawnSelection | undefined): SpawnSelectionGroup[] {
  if (!selection) return [];
  return [
    ...(selection.memoryIds !== undefined ? ['memories' as const] : []),
    ...(selection.skillIds !== undefined ? ['skills' as const] : []),
    ...(selection.referenceIds !== undefined ? ['references' as const] : []),
  ];
}

/** An index entry's audit state: what the budget left of its header. */
function indexState(entry: PromptContextEntry): 'collapsed' | 'summary-dropped' | 'header-dropped' {
  if (entry.headerDropped) return 'header-dropped';
  return entry.summaryDropped ? 'summary-dropped' : 'collapsed';
}

/** `groups`, `entries` and `dropped`; the caller keeps `memoryIds`. */
export function buildManifestContext(input: ManifestContextInput): Required<Omit<ManifestContext, 'memoryIds' | 'index' | 'budgets'>> {
  const { context } = input;
  const audit = context.contextAudit;
  const selectedGroups = new Set<SpawnSelectionGroup>(audit?.selectedGroups ?? selectionGroupsOf(input.requestSelection));
  const entries: ContextEntryRecord[] = [];
  const dropped: ContextDrop[] = [...(audit?.dropped ?? [])];
  const ranks: Record<ContextGroupName, number> = { memories: 0, skills: 0, references: 0, teammates: 0 };
  const add = (entry: Omit<ContextEntryRecord, 'rank'>): void => {
    ranks[entry.group] += 1;
    entries.push({ ...entry, rank: ranks[entry.group] });
  };

  // Memories: the PREFIX RULE — the first `memoryIds.length` texts are these.
  // A memory the budget collapsed is a `<context_index>` line instead of a
  // whole `<entry>`, recorded as a `body`-level drop (§10 Q1 rule 3).
  const member = context.teamMember;
  const collapsed = new Set(input.memoryCollapse?.collapsed ?? []);
  const indexedMemories = new Map(
    (input.index?.index.groups.find((g) => g.name === 'memories')?.entries ?? []).map((e) => [e.id, e]),
  );
  (member.memoryIds ?? []).forEach((entityId, index) => {
    const text = member.memories[index];
    const via = audit?.memoryVia[index] ?? (selectedGroups.has('memories') ? 'selection' : 'teammate');
    if (collapsed.has(index)) {
      const entry = indexedMemories.get(entityId);
      dropped.push({ entityId, kind: 'memory', group: 'memories', reason: 'byte-budget', level: 'body' });
      // Dropped from the index too: its `entry`-level drop is recorded below.
      if (!entry) return;
      add({
        entityId,
        kind: 'memory',
        group: 'memories',
        via,
        state: indexState(entry),
        bytes: contextEntryBytes(entry),
      });
      return;
    }
    add({
      entityId,
      kind: 'memory',
      group: 'memories',
      via,
      state: 'expanded',
      bytes: typeof text === 'string' ? utf8Bytes(serializeMemoryEntry(text)) : 0,
    });
  });

  // Skills: the kept index, in index order. `+ 1` is the joining newline, as
  // the manifest's own budget pass counts it.
  const rows = new Map((context.skillEquips ?? context.skills ?? []).map((row) => [row.entityId, row]));
  const selectionOnly = new Set(audit?.selectionOnlySkillIds ?? []);
  // Under `<context_index>` an entry's bytes are its index line, and a summary
  // the trim dropped shows as `summary-dropped`.
  const indexed = new Map(
    (input.index?.index.groups ?? []).flatMap((group) => group.entries.map((entry) => [`${group.name}:${entry.id}`, entry] as const)),
  );
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
      ...(input.index
        ? (() => {
            const entry = indexed.get(`skills:${skill.entityId}`);
            return {
              state: entry ? indexState(entry) : ('collapsed' as const),
              bytes: entry ? contextEntryBytes(entry) : 0,
            };
          })()
        : { state: 'collapsed' as const, bytes: utf8Bytes(serializeSkillIndexEntry(skill)) + 1 }),
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
  //
  // Every id lands in exactly one place. The loader's drops are claimed first,
  // and when references were SELECTED a snapshot row of a selectable kind
  // outside the set is not a context entry: the snapshot still names it (its
  // <linked> list is the task's identity list, §2.2), but it is recorded only
  // as the loader's `not-selected`.
  const seen = new Set<string>(dropped.map((drop) => `${drop.group}:${drop.entityId}`));
  const selectedReferences = context.references ? new Set(context.references.map((ref) => ref.entityId)) : null;
  const outsideSelection = (kind: string, entityId: string): boolean =>
    selectedReferences !== null && REFERENCE_KINDS.has(kind) && !selectedReferences.has(entityId);
  const capped: ContextDrop[] = [];
  let unreadReferences = 0;
  if (input.index) {
    // The index lists every linked row the spawn read, or the selected
    // reference set (its byte caps, not the snapshot's count cap, bound it),
    // so its groups are the record.
    for (const group of input.index.index.groups) {
      if (group.name !== 'references' && group.name !== 'teammates') continue;
      for (const entry of group.entries) {
        const key = `${group.name}:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add({
          entityId: entry.id,
          kind: entry.kind,
          group: group.name,
          via: entry.via as ContextVia,
          ...(entry.link ? { link: entry.link } : {}),
          state: indexState(entry),
          bytes: contextEntryBytes(entry),
        });
      }
    }
    for (const drop of input.index.drops) {
      // A skill's whole-entry drop is already recorded from `skippedSkills`.
      if (drop.group === 'harness' || (drop.group === 'skills' && drop.level === 'entry')) continue;
      // Claimed, so a selected reference the trim dropped is not ALSO `not-rendered` below.
      seen.add(`${drop.group}:${drop.id}`);
      dropped.push({ entityId: drop.id, kind: drop.kind, group: drop.group, reason: 'byte-budget', level: drop.level });
    }
    for (const task of context.tasks) {
      unreadReferences += Math.max(0, (task.linkedTotal ?? (task.linked ?? []).length) - (task.linked ?? []).length);
    }
  }
  for (const task of input.index ? [] : context.tasks) {
    const linked = task.linked ?? [];
    linked.forEach((item, index) => {
      const group: ContextGroupName = item.kind === 'team_member' ? 'teammates' : 'references';
      if (outsideSelection(item.kind, item.entityId)) return;
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
      if (outsideSelection('file', file.fileEntityId)) return;
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

  // A selected reference that is not one of the tasks' own links has no
  // rendering when the context index is off: the snapshot lists only task
  // links. (On, the index renders the selected set and claimed each id above.)
  // Recorded, so the selection never shrinks silently.
  // A selected DEFAULT the snapshot never read (past the spawn read's row
  // cap, so only counted in `unread`) gets its own per-id `count-cap`.
  for (const reference of context.references ?? []) {
    const key = `references:${reference.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dropped.push(reference.via === 'selection'
      ? { entityId: reference.entityId, kind: reference.kind, group: 'references', reason: 'not-rendered', level: 'entry' }
      : { entityId: reference.entityId, kind: reference.kind, group: 'references', reason: 'count-cap', level: 'entry' });
  }

  const selectable = (group: SpawnSelectionGroup): ContextGroupAudit =>
    selectedGroups.has(group)
      ? { mode: 'selected' }
      : {
        mode: 'default',
        reason: input.selectionReplayInvalid ? 'replay-invalid' : input.selectionReasons?.[group] ?? 'no-selection',
      };
  const groups: Record<ContextGroupName, ContextGroupAudit> = {
    memories: {
      ...selectable('memories'),
      ...(audit?.legacyMemoriesDropped ? { legacyDropped: audit.legacyMemoriesDropped } : {}),
      ...(input.memoryCollapse && input.memoryCollapse.collapsed.length > 0
        ? input.memoryCollapse.rank === 'jev'
          ? { rank: 'jev' as const }
          : { rank: 'none' as const, collapseOrder: 'teammate>task>requested' as const }
        : {}),
    },
    skills: selectable('skills'),
    references: {
      ...selectable('references'),
      ...(unreadReferences > 0 ? { unread: unreadReferences } : {}),
    },
    // Selection cannot name teammates: the teammate pick is its own click.
    // A dispatcher's roster rows past its read are counted, as unread links are.
    teammates: {
      mode: 'default',
      reason: 'not-selectable',
      ...(input.index && context.roster && context.roster.total > context.roster.members.length
        ? { unread: context.roster.total - context.roster.members.length }
        : {}),
    },
  };
  return { groups, entries, dropped };
}
