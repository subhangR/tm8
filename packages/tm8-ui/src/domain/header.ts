/**
 * THE AUTHORED SELECTION HEADER, as the UI writes it (I9a; headers design
 * 01a0d31e). The kind literals live here because this is `domain/` — the
 * panel asks `headerAuthorable(kind)` and names no kind (§15.2).
 */
import {
  SELECTION_HEADER_KINDS,
  type EntityHeaderView,
  type HeaderTextInput,
} from '@tm8/contract';

/**
 * Kinds whose own purpose-written field IS their header — a skill's
 * `when_to_use`, a memory's `subject_scope` — so an authored row never
 * overrides it (server `headers/derive.ts`, migration 216's
 * `internal.header_kind_allowed`).
 */
const NATIVE_HEADER_KINDS: readonly string[] = ['skill', 'memory'];

/** Can an entity of this kind carry an authored header? */
export function headerAuthorable(kind: string): boolean {
  return (SELECTION_HEADER_KINDS as readonly string[]).includes(kind) && !NATIVE_HEADER_KINDS.includes(kind);
}

/**
 * SOFT GUIDANCE, NEVER A LIMIT (Subhang's ruling, msg 01a0d6f1 on task
 * 01a0d3b0): the UI shows these next to a live count and never disables a save
 * because of length. The server's own refusals are being removed (migration
 * 222); until then its refusal is shown as it words it.
 */
export const HEADER_GUIDANCE = { whenToUse: 400, summary: 600 } as const;

/** The editor's text, before it becomes a `HeaderTextInput`. Keywords are comma-separated. */
export interface HeaderDraft {
  whenToUse: string;
  summary: string;
  keywords: string;
}

export const EMPTY_HEADER_DRAFT: HeaderDraft = { whenToUse: '', summary: '', keywords: '' };

export function headerDraftOf(header: EntityHeaderView | undefined): HeaderDraft {
  if (!header) return EMPTY_HEADER_DRAFT;
  return {
    whenToUse: header.whenToUse ?? '',
    summary: header.summary ?? '',
    keywords: header.keywords.join(', '),
  };
}

/** Split, trim and de-duplicate the keyword field; blanks are dropped. */
export function parseKeywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const word = raw.trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * The WHOLE header a write sends: a set replaces every field, so a blank field
 * goes as `null` (removed), never as `''` — the server refuses an empty string.
 */
export function headerInputOf(draft: HeaderDraft): HeaderTextInput {
  return {
    whenToUse: draft.whenToUse.trim() || null,
    summary: draft.summary.trim() || null,
    keywords: parseKeywords(draft.keywords),
  };
}

/** A header needs `whenToUse` or `summary`; keywords alone are not one. */
export function headerDraftHasText(draft: HeaderDraft): boolean {
  return draft.whenToUse.trim() !== '' || draft.summary.trim() !== '';
}

export function headerDraftsEqual(a: HeaderDraft, b: HeaderDraft): boolean {
  const x = headerInputOf(a);
  const y = headerInputOf(b);
  return x.whenToUse === y.whenToUse
    && x.summary === y.summary
    && (x.keywords ?? []).join('\u0000') === (y.keywords ?? []).join('\u0000');
}

/**
 * Why the authored header no longer describes the body, or null when it does.
 *
 * The server's `stale` is the authority at read time; the version comparison
 * is added because the panel's detail can move on (an `entity.upsert` after an
 * edit) without the header being re-read. An artifact or file can also go
 * stale on a new revision / checksum at the SAME entity version — then there
 * is no second number to print, so the sentence says so.
 */
export function headerStaleness(
  header: EntityHeaderView,
  entityVersion: number,
): { pinned: number | null; now: number } | null {
  const drifted = header.pinnedVersion !== null && header.pinnedVersion < entityVersion;
  if (!header.stale && !drifted) return null;
  return { pinned: header.pinnedVersion, now: entityVersion };
}

export function staleSentence(stale: { pinned: number | null; now: number }): string {
  if (stale.pinned === null || stale.pinned === stale.now) return 'written for an earlier revision of the body';
  return `written for v${stale.pinned}, body is now v${stale.now}`;
}
