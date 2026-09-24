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
import type { EntityId } from './contract.js';

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
 * Text caps. Resolved `whenToUse` and `summary` are each cut at 600 characters
 * (the Jev §9 limit on what may leave the server), with one exception kept
 * for byte parity with today's Jev text: a teammate's derived `whenToUse` is
 * its whole `role`, which has no length cap. The tighter authored caps
 * (`whenToUse` ≤ 400, keywords ≤ 12 × ≤ 40) belong to the authored-header
 * write path, not to this shape.
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
}
