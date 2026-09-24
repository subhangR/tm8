/**
 * Per-kind header fallbacks (headers design 01a0d31e §2.3). Pure: no I/O, so
 * the UI preview and tests can share them.
 *
 * Each field resolves in the order authored → native → derived, and falls
 * back separately: an authored `whenToUse` with no `summary` still gets the
 * native or derived `summary`. Authored headers are `entity_headers` rows
 * (migration 216), read by `resolveHeaders` in the same statement.
 *
 * Text cuts count characters (code points), the same unit Postgres `left()`
 * counts, so a cut made in SQL and a cut made here agree.
 */
import { SELECTION_HEADER_KINDS, type SelectionHeader, type SelectionHeaderKind, type SelectionHeaderSource } from '@tm8/contract';

/** Characters of header text that may leave the server (Jev design 01a0cb80 §9). */
export const HEADER_TEXT_LIMIT = 600;
/** A doc's derived summary leads with its first paragraph, cut here, then its headings. */
export const DOC_PARAGRAPH_LIMIT = 400;

export const clip = (text: string | null | undefined, limit = HEADER_TEXT_LIMIT): string =>
  [...(text ?? '')].slice(0, limit).join('');

const blankToNull = (text: string | null | undefined): string | null =>
  text == null || text.trim().length === 0 ? null : text;

/**
 * The one place a load pointer is built (integrated design 01a0d348 §4.1): every
 * tm8 entity opens with `tm8 entity context`, which is bounded, pages with
 * `--offset`, and names the next call for bodies that live outside the envelope.
 * A harness-native skill's pointer is the harness's own, set at spawn.
 */
export function loadPointerFor(_kind: SelectionHeaderKind, id: string): string {
  return `tm8 entity context ${id}`;
}

/** An `entity_headers` row, with its staleness computed at read. */
export interface AuthoredHeader {
  whenToUse: string | null;
  summary: string | null;
  keywords: string[];
  stale: boolean;
}

/** The per-kind facts `resolveHeaders` reads, already cut where the cut is safe to make in SQL. */
export type HeaderFacts =
  | { kind: 'skill'; description: string | null; whenToUse: string | null; bytes: number | null }
  | { kind: 'memory'; statement: string; subjectScope: string | null; bytes: number | null }
  | { kind: 'team_member'; role: string | null; persona: string | null; bytes: number | null }
  | { kind: 'doc'; head: string | null; headings: string[]; bytes: number | null }
  | { kind: 'artifact'; description: string | null; bytes: number | null }
  | { kind: 'drawing'; text: string | null; bytes: number | null }
  | { kind: 'file'; name: string; mime: string | null; bytes: number | null }
  | { kind: 'task'; description: string | null; bytes: number | null }
  | { kind: 'collection'; description: string | null; members: Record<string, number> };

interface Fields {
  whenToUse: string | null;
  summary: string | null;
  /** Which of the two came from the kind's own purpose-written field. */
  native: boolean;
  bytes: number | null;
}

/** First paragraph (≤ 400) then the outline headings, within 600. */
export function docSummary(head: string | null, headings: readonly string[]): string | null {
  const paragraph = (head ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .find((block) => block.length > 0 && !/^#{1,6}\s/.test(block));
  const parts: string[] = [];
  if (paragraph) parts.push(clip(paragraph, DOC_PARAGRAPH_LIMIT));
  const outline = headings.map((h) => h.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (outline.length > 0) parts.push(`Sections: ${outline.join(' · ')}`);
  return blankToNull(clip(parts.join(' '), HEADER_TEXT_LIMIT));
}

function fileSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function kindFields(facts: HeaderFacts): Fields {
  switch (facts.kind) {
    case 'skill': {
      // Native: the description is the summary; `when_to_use` frontmatter leads
      // routing, falling back to the description. An empty description is absent.
      const description = facts.description ? clip(facts.description) : null;
      const whenToUse = facts.whenToUse ? clip(facts.whenToUse) : description;
      return { whenToUse, summary: description, native: whenToUse !== null || description !== null, bytes: facts.bytes };
    }
    case 'memory':
      // Native: `subject_scope` is the "when"; the statement (injected whole at
      // spawn anyway) is the "what".
      return { whenToUse: facts.subjectScope ? clip(facts.subjectScope) : null, summary: clip(facts.statement), native: true, bytes: facts.bytes };
    case 'team_member':
      // Derived: the trimmed role, uncut (today's Jev text sends it whole), and
      // the persona cut at 600, untrimmed, when it has any text at all.
      return {
        whenToUse: blankToNull(facts.role)?.trim() ?? null,
        summary: blankToNull(facts.persona) ? clip(facts.persona) : null,
        native: false,
        bytes: facts.bytes,
      };
    case 'doc':
      return { whenToUse: null, summary: docSummary(facts.head, facts.headings), native: false, bytes: facts.bytes };
    case 'artifact':
      return { whenToUse: null, summary: blankToNull(facts.description) ? clip(facts.description) : null, native: false, bytes: facts.bytes };
    case 'drawing':
      return { whenToUse: null, summary: blankToNull(facts.text) ? clip(facts.text!.replace(/\s+/g, ' ').trim()) : null, native: false, bytes: facts.bytes };
    case 'file':
      return {
        whenToUse: null,
        summary: clip([facts.name, facts.mime, fileSize(facts.bytes)].filter((part): part is string => !!part).join(' · ')),
        native: false,
        bytes: facts.bytes,
      };
    case 'task':
      return { whenToUse: null, summary: blankToNull(facts.description) ? clip(facts.description) : null, native: false, bytes: facts.bytes };
    case 'collection': {
      const counts = Object.entries(facts.members)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, n]) => `${n} ${kind}`);
      return {
        whenToUse: blankToNull(facts.description) ? clip(facts.description) : null,
        summary: counts.length > 0 ? clip(`Contains ${counts.join(', ')}`) : null,
        native: false,
        bytes: null,
      };
    }
  }
}

/** Skills and memories have a purpose-written header of their own; an authored row never overrides it. */
const AUTHORABLE = (kind: SelectionHeaderKind): boolean => kind !== 'skill' && kind !== 'memory';

/**
 * Whether an entity of `kind` may carry an authored header: migration 216's
 * `internal.header_kind_allowed`, which entity-headers.pg.test.ts pins to
 * `SELECTION_HEADER_KINDS` less skill and memory.
 */
export function headerAuthorable(kind: string): boolean {
  return (SELECTION_HEADER_KINDS as readonly string[]).includes(kind) && AUTHORABLE(kind as SelectionHeaderKind);
}

/** One entity's header: authored → native → derived, per field. */
export function deriveHeader(
  entity: { id: string; name: string },
  facts: HeaderFacts,
  authored?: AuthoredHeader | null,
): SelectionHeader {
  const base = kindFields(facts);
  const own = authored && AUTHORABLE(facts.kind) ? authored : null;
  const whenToUse = own?.whenToUse ?? base.whenToUse;
  const summary = own?.summary ?? base.summary;
  const source: SelectionHeaderSource =
    own && (own.whenToUse !== null || own.summary !== null) ? 'authored' : base.native ? 'native' : 'derived';
  return {
    entityId: entity.id,
    kind: facts.kind,
    name: entity.name,
    whenToUse,
    summary,
    keywords: own?.keywords ?? [],
    source,
    stale: source === 'authored' && own!.stale,
    bytes: base.bytes,
    loadPointer: loadPointerFor(facts.kind, entity.id),
  };
}
