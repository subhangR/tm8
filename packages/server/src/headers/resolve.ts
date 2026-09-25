/**
 * `resolveHeaders` — the one reader of selection headers (headers design
 * 01a0d31e §7; integrated design 01a0d348 §2.1).
 *
 * One SQL statement, run in the CALLER'S transaction, so RLS decides what
 * exists: an entity the caller cannot read, one in another space, a deleted
 * one, or one of a kind that has no header (work_session, chat, message, …) is
 * simply absent from the result. Nothing here writes.
 *
 * Bodies never leave Postgres whole: text is cut in SQL to what the header
 * needs, and `bytes` is `octet_length` of the body a load would bring in.
 *
 * Authored headers (`entity_headers`, migration 216) are a left join in the
 * same statement, under the same RLS (`internal.entity_readable`), so a header
 * is exactly as visible as its entity. Staleness is computed here, never
 * stored: the entity's version moved past the pinned one, or, for artifacts
 * and files, the body ref did.
 */
import {
  AUTHORED_HEADER_LIMITS, HEADER_WHEN_TO_USE_BACKSTOP_CHARS, SELECTION_HEADER_KINDS,
  type EntityHeaderView, type HeaderClippedField, type SelectionHeader,
} from '@tm8/contract';

import { redactSecretTokens, TOKEN_CHAR_CLASS } from '@tm8/execution';

import type { Querier } from '../db/types.js';
import { titleOf, type EntityRow } from '../facade/entity-read.js';
import { deriveHeader, HEADER_TEXT_LIMIT, type AuthoredHeader, type Backstopped, type HeaderFacts } from './derive.js';

/** A doc's derived summary reads this much of the body for its first paragraph… */
const DOC_HEAD_CHARS = 4000;
/** …and at most this many of its headings. */
const DOC_HEADINGS_MAX = 24;

export interface HeaderRow {
  id: string;
  kind: string;
  skill_name: string | null;
  skill_description: string | null;
  skill_when_to_use: string | null;
  skill_bytes: number | null;
  memory_statement: string | null;
  memory_subject_scope: string | null;
  memory_bytes: number | null;
  team_member_name: string | null;
  team_member_role: string | null;
  team_member_persona: string | null;
  team_member_bytes: number | null;
  doc_title: string | null;
  doc_head: string | null;
  doc_headings: string[] | null;
  doc_bytes: number | null;
  artifact_name: string | null;
  artifact_description: string | null;
  artifact_bytes: string | number | null;
  drawing_title: string | null;
  drawing_text: string | null;
  drawing_bytes: number | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: string | number | null;
  task_title: string | null;
  task_description: string | null;
  task_bytes: number | null;
  collection_name: string | null;
  collection_description: string | null;
  collection_members: Record<string, number | string> | null;
  header_when_to_use: string | null;
  header_summary: string | null;
  header_keywords: string[] | null;
  header_stale: boolean | null;
  header_version: number | null;
  header_pinned_version: number | null;
}

/**
 * Every text this module cuts is REDACTED FIRST (the manifest's grammar,
 * `redactSecretTokens`), because a cut through a credential leaves a prefix
 * too short for the pattern, and nothing downstream can recognise it again:
 * the manifest-wide redaction runs on already-cut text, and Jev's candidate
 * text leaves the server.
 *
 * SQL cuts first, `REDACTION_MARGIN` characters past each limit. A token can
 * only start where a run of token characters (`TOKEN_CHAR_CLASS`) starts: the
 * pattern's left boundary forbids one mid-run. So the run the SQL cut ends on
 * is either at least `REDACTION_MARGIN` long, which is more than any pattern's
 * minimum match (the longest, `github_pat_` + 20, is 31), so a credential there
 * is matched and redacted; or it is shorter, and `safeText` drops it. A run
 * shorter than the margin starts past the limit, so dropping it never changes
 * ordinary text: the later cut would have removed it anyway.
 */
export const REDACTION_MARGIN = 64;

/**
 * A text read from SQL, safe to cut. When SQL cut it (`fetched` reached) and
 * the run of token characters it ends on is shorter than `REDACTION_MARGIN`,
 * that run is dropped: it may be a credential's prefix no pattern matches, and
 * redaction elsewhere in the text can shorten the text enough to pull it back
 * under the limit. Then every credential-shaped token is redacted.
 */
const TRAILING_RUN = new RegExp(`[${TOKEN_CHAR_CLASS}]+$`);

export function safeText(text: string | null, fetched?: number): string | null {
  if (text === null) return null;
  let cut = text;
  if (fetched !== undefined && Array.from(text).length >= fetched) {
    const tail = TRAILING_RUN.exec(text)?.[0] ?? '';
    if (tail.length < REDACTION_MARGIN) cut = text.slice(0, text.length - tail.length);
  }
  return redactSecretTokens(cut);
}

const L = HEADER_TEXT_LIMIT + REDACTION_MARGIN;
/**
 * Text a whenToUse may come from (an authored one, a skill's description or
 * `when_to_use`, a memory's `subject_scope`, a collection's description) is
 * read to the BACKSTOP, not to the 600 summary cut: a whenToUse is never cut
 * for length (task 01a0da5a), and `backstopped` declares the one cut it can get.
 */
const W = HEADER_WHEN_TO_USE_BACKSTOP_CHARS + REDACTION_MARGIN;
/**
 * Authored text is cut IN SQL past its limit (a whenToUse at `W`), so an
 * unbounded header never leaves Postgres whole while `clipAuthored` can still
 * tell a cut from a fit. Keywords: one past the count, each one past the length.
 */
const AS = AUTHORED_HEADER_LIMITS.summary + REDACTION_MARGIN;
const AK = AUTHORED_HEADER_LIMITS.keywords + 1;
const AKL = AUTHORED_HEADER_LIMITS.keyword + REDACTION_MARGIN;

const HEADER_SQL = `
  select e.id, e.kind,
         sk.name as skill_name,
         left(nullif(sk.description, ''), ${W}) as skill_description,
         left(sk.frontmatter ->> 'when_to_use', ${W}) as skill_when_to_use,
         coalesce(sk.body_bytes, octet_length(sk.content)) as skill_bytes,
         -- 600 covers both the summary cut and titleOf's 120-character title.
         left(memo.statement, ${L}) as memory_statement,
         left(memo.subject_scope, ${W}) as memory_subject_scope,
         octet_length(memo.statement) as memory_bytes,
         tm.name as team_member_name,
         tm.role as team_member_role,
         left(tm.identity, ${L}) as team_member_persona,
         octet_length(tm.identity) as team_member_bytes,
         d.title as doc_title,
         left(d.body, ${DOC_HEAD_CHARS}) as doc_head,
         case when d.entity_id is null then null else array(
           select h[1] from regexp_matches(d.body, '^#{1,6}[ \\t]+(.*\\S)[ \\t]*$', 'gn') as h limit ${DOC_HEADINGS_MAX}
         ) end as doc_headings,
         octet_length(d.body) as doc_bytes,
         art.name as artifact_name,
         left(art.description, ${L}) as artifact_description,
         arev.total_size_bytes as artifact_bytes,
         drw.title as drawing_title,
         case when drw.entity_id is null then null else left((
           select string_agg(el ->> 'text', ' ')
             from jsonb_array_elements(case when jsonb_typeof(drw.elements) = 'array' then drw.elements else '[]'::jsonb end) as el
            where el ->> 'type' = 'text' and (el ->> 'isDeleted') is distinct from 'true'
         ), ${L}) end as drawing_text,
         octet_length(drw.elements::text) as drawing_bytes,
         f.name as file_name, f.mime_type as file_mime, f.size_bytes as file_size,
         t.title as task_title,
         left(t.description, ${L}) as task_description,
         octet_length(t.description) as task_bytes,
         col.name as collection_name,
         left(col.description, ${W}) as collection_description,
         case when col.entity_id is null then null else (
           select jsonb_object_agg(member.kind, member.n) from (
             select me.kind, count(*) as n
               from public.edges ce
               join public.entities me on me.id = ce.dst_id and me.deleted_at is null
              where ce.src_id = e.id and ce.type = 'contains'
              group by me.kind
           ) member
         ) end as collection_members,
         left(eh.when_to_use, ${W}) as header_when_to_use,
         left(eh.summary, ${AS}) as header_summary,
         case when eh.entity_id is null then null else (
           select coalesce(array_agg(left(kw.k, ${AKL}) order by kw.o), '{}')
             from unnest(eh.keywords[1:${AK}]) with ordinality as kw(k, o)
         ) end as header_keywords,
         eh.version as header_version,
         eh.pinned_version as header_pinned_version,
         case when eh.entity_id is null then null else (
           eh.pinned_version <> e.version
           or (e.kind = 'artifact' and eh.pinned_ref is distinct from art.current_revision_id::text)
           or (e.kind = 'file' and eh.pinned_ref is distinct from f.checksum_sha256)
         ) end as header_stale
    from public.entities e
    left join public.skills sk        on e.kind = 'skill'       and sk.entity_id = e.id
    left join public.memories memo    on e.kind = 'memory'      and memo.entity_id = e.id
    left join public.team_members tm  on e.kind = 'team_member' and tm.entity_id = e.id
    left join public.documents d      on e.kind = 'doc'         and d.entity_id = e.id
    left join public.artifacts art    on e.kind = 'artifact'    and art.entity_id = e.id
    left join public.artifact_bundle_revisions arev on arev.id = art.current_revision_id
    left join public.drawings drw     on e.kind = 'drawing'     and drw.entity_id = e.id
    left join public.files f          on e.kind = 'file'        and f.entity_id = e.id
    left join public.tasks t          on e.kind = 'task'        and t.entity_id = e.id
    left join public.collections col  on e.kind = 'collection'  and col.entity_id = e.id
    left join public.entity_headers eh on eh.entity_id = e.id
   where e.id = any($2::uuid[]) and e.space_id = $1 and e.deleted_at is null
     and e.kind = any($3::text[])`;

const num = (value: string | number | null): number | null => (value == null ? null : Number(value));

/**
 * A field a whenToUse may come from, read at `fetched` (`W` when SQL cut it),
 * redacted, and cut only at the backstop, declared: the `clipAuthored` rule,
 * so a cut is never silent even when redaction shrank what was read.
 */
function backstopped(raw: string | null, fetched = W): Backstopped {
  const { text, clipped } = clipAuthored(raw, fetched, HEADER_WHEN_TO_USE_BACKSTOP_CHARS);
  return { text, cut: clipped };
}

/** Every text field goes through `safeText`: fields SQL cut with their fetch length, whole ones without. */
function factsOf(row: HeaderRow): HeaderFacts | null {
  switch (row.kind) {
    case 'skill':
      return { kind: 'skill', description: backstopped(row.skill_description), whenToUse: backstopped(row.skill_when_to_use), bytes: num(row.skill_bytes) };
    case 'memory':
      if (row.memory_statement == null) return null;
      return { kind: 'memory', statement: safeText(row.memory_statement, L)!, subjectScope: backstopped(row.memory_subject_scope), bytes: num(row.memory_bytes) };
    case 'team_member':
      // The role is read whole (today's Jev text sends it uncut); only the backstop bounds it.
      return { kind: 'team_member', role: backstopped(row.team_member_role, Number.MAX_SAFE_INTEGER), persona: safeText(row.team_member_persona, L), bytes: num(row.team_member_bytes) };
    case 'doc':
      return {
        kind: 'doc',
        head: safeText(row.doc_head, DOC_HEAD_CHARS),
        headings: (row.doc_headings ?? []).map((h) => safeText(h)!),
        bytes: num(row.doc_bytes),
      };
    case 'artifact':
      return { kind: 'artifact', description: safeText(row.artifact_description, L), bytes: num(row.artifact_bytes) };
    case 'drawing':
      return { kind: 'drawing', text: safeText(row.drawing_text, L), bytes: num(row.drawing_bytes) };
    case 'file':
      return { kind: 'file', name: safeText(row.file_name) ?? 'File', mime: safeText(row.file_mime), bytes: num(row.file_size) };
    case 'task':
      return { kind: 'task', description: safeText(row.task_description, L), bytes: num(row.task_bytes) };
    case 'collection':
      return {
        kind: 'collection',
        description: backstopped(row.collection_description),
        members: Object.fromEntries(Object.entries(row.collection_members ?? {}).map(([k, n]) => [k, Number(n)])),
      };
    default:
      return null;
  }
}

/** `text` cut to `max` code points, the last one an ellipsis; null when it already fits. */
function clipText(text: string | null, max: number): string | null {
  if (text === null) return null;
  const points = Array.from(text);
  return points.length <= max ? null : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * An authored field read at `fetched` characters, redacted, then clipped to
 * `max`: the clipped text, or null when the field fits. A field SQL cut (it
 * reached `fetched`, which is past `max`) was longer than `max`, so it is
 * ALWAYS a clip, even when redaction shrank what was read back under `max`:
 * a key longer than the margin would otherwise make a cut silent.
 */
export function clipAuthored(raw: string | null, fetched: number, max: number): { text: string | null; clipped: boolean } {
  const safe = safeText(raw, fetched);
  if (raw === null || safe === null) return { text: null, clipped: false };
  const points = Array.from(safe);
  if (points.length <= max && Array.from(raw).length < fetched) return { text: safe, clipped: false };
  return { text: `${points.slice(0, Math.min(points.length, max - 1)).join('')}…`, clipped: true };
}

/**
 * The row's `entity_headers` columns, when it has one. The `whenToUse` is shown
 * WHOLE (task 01a0da5a, D2): only `HEADER_WHEN_TO_USE_BACKSTOP_CHARS` cuts it.
 * The summary and keywords are cut to the `AUTHORED_HEADER_LIMITS` guidance.
 * Every cut is DECLARED in `clipped`. Nothing refuses a longer header
 * (migration 223), so the cut happens here, once, for every reader: Jev's
 * candidate text, the prompt's context index and `entity get/context` (where
 * `header` is a never-dropped core section).
 */
function authoredOf(row: HeaderRow): AuthoredHeader | null {
  if (row.header_stale == null) return null;
  const clipped: HeaderClippedField[] = [];
  // Redacted before the cut (see REDACTION_MARGIN), so a clip never leaves a credential's prefix.
  const whenToUse = clipAuthored(row.header_when_to_use, W, HEADER_WHEN_TO_USE_BACKSTOP_CHARS);
  if (whenToUse.clipped) clipped.push('whenToUse');
  const summary = clipAuthored(row.header_summary, AS, AUTHORED_HEADER_LIMITS.summary);
  if (summary.clipped) clipped.push('summary');
  const raw = row.header_keywords ?? [];
  const keywords = raw.slice(0, AUTHORED_HEADER_LIMITS.keywords)
    .map((k) => clipAuthored(k, AKL, AUTHORED_HEADER_LIMITS.keyword));
  if (raw.length > AUTHORED_HEADER_LIMITS.keywords || keywords.some((k) => k.clipped)) clipped.push('keywords');
  return {
    whenToUse: whenToUse.text,
    summary: summary.text,
    keywords: keywords.map((k) => k.text!),
    stale: row.header_stale,
    ...(clipped.length > 0 ? { clipped } : {}),
  };
}

/**
 * The header's `name`: `titleOf`, from REDACTED text. A memory's title is its
 * statement cut to 120, so the statement is redacted before `titleOf` cuts it
 * (a key straddling 120 would leave a prefix no pattern matches); every other
 * kind's name is its own column, uncut, and is redacted like every other field.
 */
export function headerNameOf(row: HeaderRow): string {
  const memory_statement = row.kind === 'memory' ? safeText(row.memory_statement, L) : row.memory_statement;
  // `titleOf` reads only the kind and that kind's own name column, all selected above.
  return safeText(titleOf({ ...row, memory_statement, deleted_at: null } as unknown as EntityRow))!;
}

/** One resolved header per readable row, with the row it came from. */
async function resolveRows(
  q: Querier,
  spaceId: string,
  ids: readonly string[],
): Promise<Array<{ row: HeaderRow; header: SelectionHeader }>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = await q.query<HeaderRow>(HEADER_SQL, [spaceId, wanted, [...SELECTION_HEADER_KINDS]]);
  const out: Array<{ row: HeaderRow; header: SelectionHeader }> = [];
  for (const row of rows) {
    const facts = factsOf(row);
    if (!facts) continue;
    out.push({ row, header: deriveHeader({ id: row.id, name: headerNameOf(row) }, facts, authoredOf(row)) });
  }
  return out;
}

/**
 * Headers for `ids`, keyed by id, in the caller's transaction. Ids that are
 * unreadable, deleted, in another space or of a kind with no header are absent.
 */
export async function resolveHeaders(q: Querier, spaceId: string, ids: readonly string[]): Promise<Map<string, SelectionHeader>> {
  return new Map((await resolveRows(q, spaceId, ids)).map(({ row, header }) => [row.id, header]));
}

/**
 * `resolveHeaders` for an entity read (`entities.get`, `entities.context`,
 * the header commands' result): the same header, plus the authored row's own
 * `version` (0 when there is none) and `pinnedVersion`, which a caller needs
 * to write it next.
 */
export async function resolveHeaderViews(
  q: Querier,
  spaceId: string,
  ids: readonly string[],
): Promise<Map<string, EntityHeaderView>> {
  return new Map((await resolveRows(q, spaceId, ids)).map(({ row, header }) => [row.id, {
    ...header,
    version: row.header_version == null ? 0 : Number(row.header_version),
    pinnedVersion: row.header_pinned_version == null ? null : Number(row.header_pinned_version),
  }]));
}

/**
 * The AUTHORED header of one entity, or undefined — what an entity read
 * (`entities.get`, `entities.context`) shows, already clipped and declared
 * by `authoredOf`. Almost no entity has an `entity_headers` row, so a
 * one-row probe (under the same RLS) runs first and the full resolve only
 * when it finds one.
 */
export async function resolveAuthoredHeaderView(
  q: Querier,
  spaceId: string,
  id: string,
): Promise<EntityHeaderView | undefined> {
  const probe = await q.query<{ found: number }>(
    'select 1 as found from public.entity_headers where entity_id = $1',
    [id],
  );
  if (probe.length === 0) return undefined;
  const header = (await resolveHeaderViews(q, spaceId, [id])).get(id);
  return header && header.version > 0 ? header : undefined;
}
