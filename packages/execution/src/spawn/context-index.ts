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
  clipIndexText,
  INDEX_DERIVED_HEADER_CHARS,
  loadPointerFor,
  serializeMemoryEntry,
  utf8Bytes,
  type ContextBudgetSettings,
  type ContextIndexGroupName,
  type ContextIndexVia,
  type PromptContextEntry,
  type PromptContextGroup,
} from '@tm8/prompt';
import { SPAWN_SELECTION_REFERENCE_KINDS, type ContextFloors, type SelectionHeader } from '@tm8/contract';
import { redactSecretTokens } from './secret-redaction.js';
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

/**
 * The ids whose headers the index renders: the selected references, the
 * tasks' linked rows and attached files, the equipped skills, and the
 * injected memories (a memory that collapses is routed by its
 * `subject_scope`, §10 Q1 rule 3).
 */
export function contextHeaderIds(context: SpawnContext): string[] {
  return [...new Set([
    ...(context.references ?? []).map((ref) => ref.entityId),
    ...context.tasks.flatMap((task) => [
      ...(task.linked ?? []).map((item) => item.entityId),
      ...(task.attachments ?? []).map((file) => file.fileEntityId),
    ]),
    ...(context.skillEquips ?? context.skills ?? []).map((row) => row.entityId),
    ...(context.teamMember.memoryIds ?? []),
  ])];
}

/**
 * The pinned profile's `contextBudgets` (§10 Q5), read tolerantly from the
 * resolved snapshot's draft. Only non-negative integers count; anything else
 * is the node default.
 */
export function contextBudgetsFrom(profileSnapshot: unknown): ContextBudgetSettings {
  const at = (v: unknown, key: string): unknown =>
    v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  const raw = at(at(profileSnapshot, 'draft'), 'contextBudgets');
  const out: ContextBudgetSettings = {};
  for (const key of ['memories', 'skills', 'references', 'teammates'] as const) {
    const value = at(raw, key);
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * The pinned profile's `contextFloors` (§10 Q5), read like
 * `contextBudgetsFrom`: only scores in 0..3 count; anything else is the node
 * default. Ask Jev's budget fill applies them; spawn has no scores to apply
 * them to (Q5.5).
 */
export function contextFloorsFrom(profileSnapshot: unknown): ContextFloors {
  const at = (v: unknown, key: string): unknown =>
    v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  const raw = at(at(profileSnapshot, 'draft'), 'contextFloors');
  const out: ContextFloors = {};
  for (const key of ['memories', 'skills', 'references', 'teammates'] as const) {
    const value = at(raw, key);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3) out[key] = value;
  }
  return out;
}

/** No sub-cap: the group is trimmed only against what the prompt has left. */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

/**
 * The sub-caps (§2.3, §10 Q3), with a profile's `contextBudgets` replacing
 * each node default (Q5). Collapsed memories come first: each is already the
 * fallback for a memory that did not fit whole. In a worker prompt teammates
 * share the reference cap unless the profile gives them their own; a
 * dispatcher's teammates are its roster. Skills take what remains unless the
 * profile caps them.
 */
export function contextIndexCaps(
  mode: string,
  budgets: ContextBudgetSettings = {},
): { groups: ContextIndexGroupName[]; cap: number }[] {
  const references = budgets.references ?? BYTE_BUDGETS.referenceIndex;
  const teammates = budgets.teammates ?? (mode === 'dispatcher' ? BYTE_BUDGETS.rosterIndex : undefined);
  return [
    { groups: ['memories'], cap: UNCAPPED },
    ...(teammates === undefined
      ? [{ groups: ['references', 'teammates'] as ContextIndexGroupName[], cap: references }]
      : [
          { groups: ['references'] as ContextIndexGroupName[], cap: references },
          { groups: ['teammates'] as ContextIndexGroupName[], cap: teammates },
        ]),
    ...(budgets.skills !== undefined ? [{ groups: ['skills'] as ContextIndexGroupName[], cap: budgets.skills }] : []),
  ];
}

// -- memory collapse (§2.4, §10 Q1) -------------------------------------------

/** The epistemic marks `renderMemories` appends: `statement [verified, …]`. */
const MARKS = /\s\[((?:superseded|disputed|verified)(?:, (?:superseded|disputed|verified))*)\]$/;

/** A rendered memory's statement and its tag. */
export function splitMemoryTag(text: string): { statement: string; tag: string | null } {
  const match = MARKS.exec(text);
  return match ? { statement: text.slice(0, match.index), tag: match[1]! } : { statement: text, tag: null };
}

/** Characters of a collapsed memory's statement shown as its excerpt (§10 Q1 rule 3). */
export const MEMORY_EXCERPT_CHARS = 200;

export interface MemoryCollapseInput {
  /** The injected memory texts with ids, in injection order (the prefix of `agent.memory`). */
  texts: readonly string[];
  ids: readonly string[];
  via: readonly ContextVia[];
  /** The legacy jsonb remainder: no ids, so never collapsible, but it counts. */
  legacy: readonly string[];
  scores?: ReadonlyArray<{ entityId: string; score: number; critical: boolean }>;
  cap: number;
}

export interface MemoryCollapseResult {
  /** Indices into `texts` kept whole, in injection order. */
  kept: number[];
  /** Indices collapsed, in collapse order (first collapsed first). */
  collapsed: number[];
  rank: 'jev' | 'none';
  cap: number;
  /** Rendered `<entry>` bytes of what stays whole, legacy included. */
  used: number;
  /** How far past `cap` the whole memories run (critical ones never collapse). */
  borrowed: number;
}

/** The §10 Q1 rank of an entry path when there is no Jev rank: first to collapse → last. */
const VIA_ORDER: Record<string, number> = { teammate: 0, inherited: 0, task: 1, requested: 2, selection: 2 };

/**
 * Whole memories up to the cap; beyond it the lowest-ranked collapse (§10
 * Q1). With Jev scores: lowest score first, a later pick before an earlier
 * one on a tie, and a critical memory never. Without: the stated order —
 * teammate-remembered, then task-remembered, then requested; within each,
 * unverified before verified; then oldest (earliest rendered) first.
 */
export function collapseMemories(input: MemoryCollapseInput): MemoryCollapseResult {
  const bytes = input.texts.map((text) => utf8Bytes(serializeMemoryEntry(text)));
  let used = bytes.reduce((a, b) => a + b, 0)
    + input.legacy.reduce((a, text) => a + utf8Bytes(serializeMemoryEntry(text)), 0);
  const scores = new Map((input.scores ?? []).map((s) => [s.entityId, s]));
  const rank: 'jev' | 'none' = scores.size > 0 ? 'jev' : 'none';
  const order = input.texts.map((_, i) => i).filter((i) => scores.get(input.ids[i]!)?.critical !== true);
  if (rank === 'jev') {
    const score = (i: number): number => scores.get(input.ids[i]!)?.score ?? Number.NEGATIVE_INFINITY;
    order.sort((a, b) => score(a) - score(b) || b - a);
  } else {
    const verified = (i: number): number => (splitMemoryTag(input.texts[i]!).tag?.split(', ').includes('verified') ? 1 : 0);
    order.sort((a, b) =>
      (VIA_ORDER[input.via[a] ?? 'teammate'] ?? 0) - (VIA_ORDER[input.via[b] ?? 'teammate'] ?? 0)
      || verified(a) - verified(b)
      || a - b);
  }
  const collapsed: number[] = [];
  for (const i of order) {
    if (used <= input.cap) break;
    collapsed.push(i);
    used -= bytes[i]!;
  }
  const gone = new Set(collapsed);
  return {
    kept: input.texts.map((_, i) => i).filter((i) => !gone.has(i)),
    collapsed,
    rank,
    cap: input.cap,
    used,
    borrowed: Math.max(0, used - input.cap),
  };
}

/** A collapsed memory's index entry: `subject_scope` routes, an excerpt summarizes, the tag stays a control attribute. */
export function collapsedMemoryEntry(
  id: string,
  text: string,
  via: ContextVia,
  header: SelectionHeader | undefined,
): PromptContextEntry {
  const { statement, tag } = splitMemoryTag(text);
  const chars = [...statement];
  const excerpt = chars.length > MEMORY_EXCERPT_CHARS;
  return {
    id,
    kind: 'memory',
    via: via as ContextIndexVia,
    load: loadPointerFor('memory', id),
    ...(header ? { bytes: header.bytes, source: header.source, stale: header.stale } : {}),
    ...(tag ? { tag } : {}),
    ...(excerpt ? { excerpt: true } : {}),
    header: {
      whenToUse: header?.whenToUse ?? null,
      summary: excerpt ? `${chars.slice(0, MEMORY_EXCERPT_CHARS).join('')}…` : statement,
    },
  };
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

/** The header fields a `<context_index>` entry renders, so the only ones `clipped` may name. */
const INDEX_TEXT_FIELDS: ReadonlySet<string> = new Set(['whenToUse', 'summary']);

/**
 * An entry's header fields. DERIVED text (nobody wrote it for routing) is cut
 * to `INDEX_DERIVED_HEADER_CHARS` per field here, and only here: Jev keeps its
 * 600 (`jevText`), and authored and native text is never cut. Every cut field
 * is named in `clipped`, together with any authored clip `resolveHeaders`
 * already declared, so a cut is never silent.
 */
function withHeader(header: SelectionHeader | undefined, fallbackName: string | null): Pick<PromptContextEntry, 'bytes' | 'source' | 'stale' | 'header' | 'clipped'> {
  if (!header) return fallbackName ? { header: { name: fallbackName } } : {};
  // Only the fields the index renders: an authored `keywords` clip is not
  // text this entry shows, so declaring it here would name nothing.
  const clipped = new Set<string>((header.clipped ?? []).filter((field) => INDEX_TEXT_FIELDS.has(field)));
  let { whenToUse, summary } = header;
  if (header.source === 'derived') {
    // Redact BEFORE the cut: a cut through a credential leaves a prefix too
    // short for the pattern, and the manifest-wide redaction after it would
    // ship that prefix.
    const cutWhen = clipIndexText(whenToUse === null ? null : redactSecretTokens(whenToUse), INDEX_DERIVED_HEADER_CHARS);
    if (cutWhen !== null) { whenToUse = cutWhen; clipped.add('whenToUse'); }
    const cutSummary = clipIndexText(summary === null ? null : redactSecretTokens(summary), INDEX_DERIVED_HEADER_CHARS);
    if (cutSummary !== null) { summary = cutSummary; clipped.add('summary'); }
  }
  return {
    bytes: header.bytes,
    source: header.source,
    stale: header.stale,
    header: { name: header.name, whenToUse, summary },
    ...(clipped.size > 0 ? { clipped: [...clipped].sort() } : {}),
  };
}

/** Whether a kind carries a header at all; others are id-only lines (headers design §2.2). */
const HEADERLESS = new Set(['work_session', 'chat', 'message']);

const REFERENCE_KINDS: ReadonlySet<string> = new Set(SPAWN_SELECTION_REFERENCE_KINDS);

/**
 * ONE ENTRY BUILDER PER KIND OF ROW. The launch's index and Ask Jev's
 * `promptBytes` (design 01a0d348 §10 Q5.8) both build entries here, so the
 * bytes the launch sheet meters are the bytes the launch renders.
 */

/** A reference or linked teammate: a selected reference, a task's linked row, or its attached file. */
export function referenceIndexEntry(
  ref: { entityId: string; kind: string; via: ContextIndexVia; link?: string | null; title: string | null },
  header: SelectionHeader | undefined,
): PromptContextEntry {
  return {
    id: ref.entityId,
    kind: ref.kind,
    via: ref.via,
    ...(ref.link ? { link: ref.link } : {}),
    load: loadPointerFor(ref.kind, ref.entityId),
    ...(HEADERLESS.has(ref.kind) ? {} : withHeader(header, ref.title)),
  };
}

/** A kept skill, as `computeEffectiveSkills` described it. */
export function skillIndexEntry(skill: ManifestSkillContext, via: ContextVia, header: SelectionHeader | undefined): PromptContextEntry {
  return {
    id: skill.entityId,
    kind: 'skill',
    via: via as ContextIndexVia,
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
}

export interface ContextIndexCandidatesInput {
  context: SpawnContext;
  /** Memories collapsed out of `agent.memory`, in collapse order (§10 Q1). */
  memories?: PromptContextEntry[];
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
    references.push(referenceIndexEntry(ref, headers.get(ref.entityId)));
  }
  for (const task of context.tasks) {
    for (const item of task.linked ?? []) {
      const teammate = item.kind === 'team_member';
      if (teammate && item.entityId === self) continue;
      if (selected && REFERENCE_KINDS.has(item.kind)) continue;
      if (seen.has(item.entityId)) continue;
      seen.add(item.entityId);
      const entry = referenceIndexEntry({ ...item, via: 'linked' }, headers.get(item.entityId));
      (teammate ? teammates : references).push(entry);
    }
    for (const file of selected ? [] : task.attachments ?? []) {
      if (seen.has(file.fileEntityId)) continue;
      seen.add(file.fileEntityId);
      references.push(referenceIndexEntry(
        { entityId: file.fileEntityId, kind: 'file', via: 'attached', link: 'attached_to', title: file.name },
        headers.get(file.fileEntityId),
      ));
    }
  }

  const skills: PromptContextEntry[] = input.skills.map((skill) =>
    skillIndexEntry(skill, skillVia(context, skill.entityId), headers.get(skill.entityId)));

  const firstTask = context.tasks[0]?.id;
  const connections = (id: string): string => `tm8 entity context ${id} --sections connections`;
  // Links past the spawn's row read have no ids, so they cannot be entries;
  // they are DECLARED in the references group's omitted count, with the
  // command that lists them (the first task that has some). A selected
  // reference set replaces the default links, so there is nothing unread to
  // declare in the index (the audit's `groups.references.unread` still counts
  // them; unselected, it is this same number).
  const unreadByTask = selected
    ? []
    : context.tasks.map((task) => ({
      id: task.id,
      unread: Math.max(0, (task.linkedTotal ?? (task.linked ?? []).length) - (task.linked ?? []).length),
    }));
  const unread = unreadByTask.reduce((n, t) => n + t.unread, 0);
  const referencesFetch = unreadByTask.find((t) => t.unread > 0)?.id ?? firstTask;
  const groups: PromptContextGroup[] = [
    // A memory dropped even from the index is still loadable by id from the
    // teammate's or task's connections.
    { name: 'memories', entries: input.memories ?? [], omitted: 0, fetch: connections(self) },
    { name: 'references', entries: references, omitted: unread, ...(referencesFetch ? { fetch: connections(referencesFetch) } : {}) },
    { name: 'teammates', entries: teammates, omitted: 0, ...(firstTask ? { fetch: connections(firstTask) } : {}) },
    { name: 'skills', entries: skills, omitted: 0, fetch: connections(self) },
  ];
  return groups;
}
