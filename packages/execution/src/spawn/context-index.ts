// @tm8/execution — the launch's `<context_index>` entries (design 01a0d348 §2).
//
// Builds the candidate groups from what `loadSpawnContext` read (the selected
// reference set or the tasks' linked entities and attached files, linked
// teammates, the kept skills, and the resolved selection headers), in rank
// order: the selected order, else edge order. The trim and the rendering
// live in `@tm8/prompt` so the prompt and the manifest measure with one
// serializer.
//
// Shipped DARK (§10 Q2): nothing here runs unless `contextIndexSwitch` says
// the node env or the pinned profile turned it on.

import {
  BYTE_BUDGETS,
  loadPointerFor,
  type ContextIndexGroupName,
  type ContextIndexVia,
  type PromptContextEntry,
  type PromptContextGroup,
} from '@tm8/prompt';
import { SPAWN_SELECTION_REFERENCE_KINDS, type SelectionHeader } from '@tm8/contract';
import type { ContextVia, ManifestSkillContext, SpawnContext } from './types.js';

/** `TM8_CONTEXT_INDEX` values that turn the index on, and off, for every launch on the node. */
const ON = new Set(['1', 'true', 'on']);
const OFF = new Set(['0', 'false', 'off']);

/**
 * Whether a launch renders `<context_index>`, and which switch decided. The
 * node env outranks the profile both ways (an operator can force it on for an
 * A/B arm, or off everywhere); unset, the pinned profile's draft
 * `contextIndex: true` turns it on. Default OFF (§10 Q2).
 */
export function contextIndexSwitch(
  env: Readonly<Record<string, string | undefined>>,
  profileSnapshot: unknown,
): { on: true; source: 'env' | 'profile' } | { on: false } {
  const raw = env.TM8_CONTEXT_INDEX?.trim().toLowerCase();
  if (raw && ON.has(raw)) return { on: true, source: 'env' };
  if (raw && OFF.has(raw)) return { on: false };
  const draft = profileSnapshot && typeof profileSnapshot === 'object'
    ? (profileSnapshot as Record<string, unknown>).draft
    : undefined;
  const flag = draft && typeof draft === 'object' ? (draft as Record<string, unknown>).contextIndex : undefined;
  return flag === true ? { on: true, source: 'profile' } : { on: false };
}

/**
 * A resume renders `<context_index>` when its launch did — the same launch,
 * replayed — unless the node env now turns it off, which wins everywhere.
 */
export function contextIndexForResume(
  env: Readonly<Record<string, string | undefined>>,
  recorded: 'env' | 'profile' | null,
): { source: 'env' | 'profile' } | null {
  if (!recorded) return null;
  const raw = env.TM8_CONTEXT_INDEX?.trim().toLowerCase();
  return raw && OFF.has(raw) ? null : { source: recorded };
}

/** The ids whose headers the index renders: the selected references, the tasks' linked rows and attached files, and the equipped skills. */
export function contextHeaderIds(context: SpawnContext): string[] {
  return [...new Set([
    ...(context.references ?? []).map((ref) => ref.entityId),
    ...context.tasks.flatMap((task) => [
      ...(task.linked ?? []).map((item) => item.entityId),
      ...(task.attachments ?? []).map((file) => file.fileEntityId),
    ]),
    ...(context.skillEquips ?? context.skills ?? []).map((row) => row.entityId),
  ])];
}

/**
 * The sub-caps (§2.3, §10 Q3). In a worker prompt teammates share the
 * reference cap; a dispatcher's teammates are its roster and have their own.
 * Skills are uncapped here: they take what remains, as today.
 */
export function contextIndexCaps(mode: string): { groups: ContextIndexGroupName[]; cap: number }[] {
  return mode === 'dispatcher'
    ? [
        { groups: ['references'], cap: BYTE_BUDGETS.referenceIndex },
        { groups: ['teammates'], cap: BYTE_BUDGETS.rosterIndex },
      ]
    : [{ groups: ['references', 'teammates'], cap: BYTE_BUDGETS.referenceIndex }];
}

/** How an equipped skill entered the set, as the audit records it. */
export function skillVia(context: SpawnContext, entityId: string): ContextVia {
  const audit = context.contextAudit;
  if (audit?.selectionOnlySkillIds?.includes(entityId)) return 'selection';
  const row = (context.skillEquips ?? context.skills ?? []).find((r) => r.entityId === entityId) as
    | { viaTaskId?: string; depth?: number }
    | undefined;
  if (row?.viaTaskId) return 'task';
  return (row?.depth ?? 0) > 0 ? 'inherited' : 'teammate';
}

function withHeader(header: SelectionHeader | undefined, fallbackName: string | null): Pick<PromptContextEntry, 'bytes' | 'source' | 'stale' | 'header'> {
  if (!header) return fallbackName ? { header: { name: fallbackName } } : {};
  return {
    bytes: header.bytes,
    source: header.source,
    stale: header.stale,
    header: { name: header.name, whenToUse: header.whenToUse, summary: header.summary },
  };
}

/** Whether a kind carries a header at all; others are id-only lines (headers design §2.2). */
const HEADERLESS = new Set(['work_session', 'chat', 'message']);

const REFERENCE_KINDS: ReadonlySet<string> = new Set(SPAWN_SELECTION_REFERENCE_KINDS);

export interface ContextIndexCandidatesInput {
  context: SpawnContext;
  /** The skills the index may carry (after the native-shadow pass), in index order. */
  skills: readonly ManifestSkillContext[];
}

/**
 * The candidate groups, each in rank order. References and teammates are the
 * tasks' linked rows and attached files (first task first, linked before
 * attached, de-duplicated) — the same rows the assignment snapshot lists by
 * name; the index adds their headers and load pointers. When the launch
 * SELECTED references (I6, `context.references`), that exact set replaces the
 * selectable-kind defaults and leads the group in the selected order; a linked
 * row of a kind selection cannot name still comes from the tasks.
 */
export function contextIndexCandidates(input: ContextIndexCandidatesInput): PromptContextGroup[] {
  const { context } = input;
  const headers = new Map((context.headers ?? []).map((h) => [h.entityId, h]));
  const self = context.teamMember.id;
  const references: PromptContextEntry[] = [];
  const teammates: PromptContextEntry[] = [];
  const seen = new Set<string>();
  const selected = context.references !== undefined;
  for (const ref of context.references ?? []) {
    if (seen.has(ref.entityId)) continue;
    seen.add(ref.entityId);
    references.push({
      id: ref.entityId,
      kind: ref.kind,
      via: ref.via,
      ...(ref.link ? { link: ref.link } : {}),
      load: loadPointerFor(ref.kind, ref.entityId),
      ...(HEADERLESS.has(ref.kind) ? {} : withHeader(headers.get(ref.entityId), ref.title)),
    });
  }
  for (const task of context.tasks) {
    for (const item of task.linked ?? []) {
      const teammate = item.kind === 'team_member';
      if (teammate && item.entityId === self) continue;
      if (selected && REFERENCE_KINDS.has(item.kind)) continue;
      if (seen.has(item.entityId)) continue;
      seen.add(item.entityId);
      const entry: PromptContextEntry = {
        id: item.entityId,
        kind: item.kind,
        via: 'linked',
        link: item.link,
        load: loadPointerFor(item.kind, item.entityId),
        ...(HEADERLESS.has(item.kind) ? {} : withHeader(headers.get(item.entityId), item.title)),
      };
      (teammate ? teammates : references).push(entry);
    }
    for (const file of selected ? [] : task.attachments ?? []) {
      if (seen.has(file.fileEntityId)) continue;
      seen.add(file.fileEntityId);
      references.push({
        id: file.fileEntityId,
        kind: 'file',
        via: 'attached',
        link: 'attached_to',
        load: loadPointerFor('file', file.fileEntityId),
        ...withHeader(headers.get(file.fileEntityId), file.name),
      });
    }
  }

  const skills: PromptContextEntry[] = input.skills.map((skill) => {
    const header = headers.get(skill.entityId);
    return {
      id: skill.entityId,
      kind: 'skill',
      via: skillVia(context, skill.entityId) as ContextIndexVia,
      // A native skill opens through the harness's own loader (its pointer was
      // built by `loadPointerFor` in `computeEffectiveSkills`); every other
      // skill is a tm8 entity and opens with `tm8 entity context`.
      load: skill.native ? skill.loadPointer : loadPointerFor('skill', skill.entityId),
      skill: {
        name: skill.name,
        provider: skill.provider ?? 'tm8',
        level: skill.level ?? 'space',
        native: skill.native === true,
        implicit: skill.allowImplicitInvocation !== false,
      },
      ...(header
        ? withHeader(header, null)
        : skill.description
          ? { header: { whenToUse: skill.description } }
          : {}),
    };
  });

  const firstTask = context.tasks[0]?.id;
  const connections = (id: string): string => `tm8 entity context ${id} --sections connections`;
  const groups: PromptContextGroup[] = [
    { name: 'references', entries: references, omitted: 0, ...(firstTask ? { fetch: connections(firstTask) } : {}) },
    { name: 'teammates', entries: teammates, omitted: 0, ...(firstTask ? { fetch: connections(firstTask) } : {}) },
    { name: 'skills', entries: skills, omitted: 0, fetch: connections(self) },
  ];
  return groups;
}
