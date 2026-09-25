/**
 * SelectionHeader — the small, cross-kind "should this be picked, and how do I
 * get the rest?" record (headers design 01a0d31e §2.1; integrated design
 * 01a0d348 §2.1).
 *
 * Every consumer that selects entities — Ask Jev's candidate text today, the
 * spawn context index and `entity context` later — reads the SAME resolved
 * value, built by one server resolver (`packages/server/src/headers/`), so no
 * consumer builds its own snippet.
 *
 * Header text is graph content: wherever it enters a prompt it rides inside an
 * `untrusted_data` block, never as instructions.
 */
import type { CommandContext, CommandResult, EntityId } from './contract.js';

/** Where a header's text came from. */
export type SelectionHeaderSource =
  /** An `entity_headers` row a person or agent wrote (lands with that table). */
  | 'authored'
  /** The kind's own purpose-written field: a skill's description / `when_to_use`, a memory's `subject_scope`. */
  | 'native'
  /** A deterministic fallback computed from the entity's own fields. */
  | 'derived';

export const SELECTION_HEADER_SOURCES = ['authored', 'native', 'derived'] as const satisfies readonly SelectionHeaderSource[];

/** Kinds that resolve to a header. Anything else (work_session, chat, message, …) is referenced by id alone. */
export type SelectionHeaderKind =
  | 'skill'
  | 'memory'
  | 'team_member'
  | 'doc'
  | 'artifact'
  | 'drawing'
  | 'file'
  | 'task'
  | 'collection';

export const SELECTION_HEADER_KINDS = [
  'skill',
  'memory',
  'team_member',
  'doc',
  'artifact',
  'drawing',
  'file',
  'task',
  'collection',
] as const satisfies readonly SelectionHeaderKind[];

/**
 * Text caps. A resolved `whenToUse` is NEVER cut for length, whatever its
 * source (task 01a0da5a): it is the one line a later agent routes by, so every
 * reader shows it whole. Only `HEADER_WHEN_TO_USE_BACKSTOP_CHARS` bounds it,
 * against a pathological header, and that cut is declared in `clipped`. A
 * `summary` is cut at 600 characters (the Jev §9 limit on what may leave the
 * server). The authored guidance (`whenToUse` ≤ 400, keywords ≤ 12 × ≤ 40)
 * belongs to the write path, which warns and never refuses.
 */
export interface SelectionHeader {
  entityId: EntityId;
  kind: SelectionHeaderKind;
  /** `titleOf(row)`: the same label every list shows. */
  name: string;
  /** "Pick/load me when …" — routing text. */
  whenToUse: string | null;
  /** What it is / what it contains. */
  summary: string | null;
  /** Optional lexical prefilter + UI chips. Empty until authored headers exist. */
  keywords: string[];
  /**
   * The source of the header as a whole: `authored` when an authored row
   * supplied any field, else `native` when the kind's own purpose-written field
   * did, else `derived`.
   */
  source: SelectionHeaderSource;
  /** Authored, and the body changed since it was written. Always false for native and derived headers. */
  stale: boolean;
  /** Size in bytes of the body a load would bring in, computed at read; null when unknown. */
  bytes: number | null;
  /** The exact command that fetches the body; null when the body is always injected. */
  loadPointer: string | null;
  /**
   * The fields cut at resolve time, so every reader (Jev, the prompt's context
   * index, `entities.get/context`, the header commands' result) sees one
   * bounded value: an authored `summary` or keywords past
   * `AUTHORED_HEADER_LIMITS`, or a `whenToUse` of any source past
   * `HEADER_WHEN_TO_USE_BACKSTOP_CHARS`. Absent when nothing was cut; a cut is
   * never silent. The full authored text stays in `entity_headers`.
   */
  clipped?: HeaderClippedField[];
}

/**
 * Authored-header GUIDANCE, not bounds (lenient ruling, migration 223): the
 * help, the MCP guides and the prompt state these numbers, and nothing refuses
 * a header over them. A `whenToUse` over its guidance is shown WHOLE (up to
 * `HEADER_WHEN_TO_USE_BACKSTOP_CHARS`), and its write warns `header_long`;
 * `resolveHeaders` clips a `summary` and keywords to these numbers and
 * declares it (`SelectionHeader.clipped`). Text is trimmed; a field that trims
 * to nothing is dropped, never refused.
 */
export const AUTHORED_HEADER_LIMITS = {
  whenToUse: 400,
  summary: 600,
  keywords: 12,
  keyword: 40,
} as const;

/**
 * The header an entity read carries (`entities.get`, `entities.context`, and
 * the result of `entities.header.set/clear`): the resolved `SelectionHeader`,
 * plus the authored row's own bookkeeping so a caller can write it next.
 */
export interface EntityHeaderView extends SelectionHeader {
  /**
   * The authored header's OWN version, never `entities.version`: the value
   * `entities.header.set/clear` take as `expectedVersion`. 0 when no authored
   * header exists (the header shown is native or derived).
   */
  version: number;
  /** The entity version the authored header was written against; null when not authored. */
  pinnedVersion: number | null;
}

export type HeaderClippedField = 'whenToUse' | 'summary' | 'keywords';

/**
 * The only cut a `whenToUse` ever gets (task 01a0da5a, decision D2): a
 * backstop against a pathological header, five times the authored guidance,
 * declared in `clipped` wherever it bites. Anything a person or agent would
 * write for routing is far below it, so in practice a whenToUse is shown
 * whole, in the context index, in Jev's candidate text and in entity reads.
 */
export const HEADER_WHEN_TO_USE_BACKSTOP_CHARS = 2000;

/**
 * The text of an authored header. The WHOLE header is written: an absent or
 * null field is removed, so a set with only `summary` leaves no `whenToUse`.
 * Every field is optional and nothing is refused for content (migration 223):
 * text is trimmed, blank text and blank keywords are dropped, duplicate
 * keywords removed. A set with nothing left is a no-op (warning `header_empty`).
 */
export interface HeaderTextInput {
  whenToUse?: string | null;
  summary?: string | null;
  keywords?: string[];
}

/**
 * PUT /v2/entities/:id/header — write (create or replace) an entity's authored
 * header and re-pin it to the entity's current version. Never moves
 * `entities.version`. `expectedVersion` is the HEADER's version (0 = "no header
 * yet"); omitted, the write is unguarded.
 */
export interface SetEntityHeaderInput extends CommandContext, HeaderTextInput {
  expectedVersion?: number;
}

/**
 * DELETE /v2/entities/:id/header — remove the authored header; the entity falls
 * back to its native/derived header. `expectedVersion` (the header's) is
 * optional: omitted, the clear is unguarded; given, it must match. Clearing an
 * entity with no authored header is a no-op (warning `header_absent`).
 */
export interface ClearEntityHeaderInput extends CommandContext {
  expectedVersion?: number;
}

/**
 * The result of `entities.header.set/clear`: the command result, and the
 * header now in effect. `header` is absent for a kind that has none
 * (work_session, chat, message, c:*), where the command was a no-op with
 * warning `header_not_stored`.
 */
export interface EntityHeaderResult extends CommandResult {
  header?: EntityHeaderView;
}
