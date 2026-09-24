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
 */
import { SELECTION_HEADER_KINDS, type SelectionHeader } from '@tm8/contract';

import type { Querier } from '../db/types.js';
import { titleOf, type EntityRow } from '../facade/entity-read.js';
import { deriveHeader, HEADER_TEXT_LIMIT, type AuthoredHeader, type HeaderFacts } from './derive.js';

/** A doc's derived summary reads this much of the body for its first paragraph… */
const DOC_HEAD_CHARS = 4000;
/** …and at most this many of its headings. */
const DOC_HEADINGS_MAX = 24;

interface HeaderRow {
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
}

const L = HEADER_TEXT_LIMIT;

const HEADER_SQL = `
  select e.id, e.kind,
         sk.name as skill_name,
         left(nullif(sk.description, ''), ${L}) as skill_description,
         left(sk.frontmatter ->> 'when_to_use', ${L}) as skill_when_to_use,
         coalesce(sk.body_bytes, octet_length(sk.content)) as skill_bytes,
         memo.statement as memory_statement,
         left(memo.subject_scope, ${L}) as memory_subject_scope,
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
         left(col.description, ${L}) as collection_description,
         case when col.entity_id is null then null else (
           select jsonb_object_agg(member.kind, member.n) from (
             select me.kind, count(*) as n
               from public.edges ce
               join public.entities me on me.id = ce.dst_id and me.deleted_at is null
              where ce.src_id = e.id and ce.type = 'contains'
              group by me.kind
           ) member
         ) end as collection_members
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
   where e.id = any($2::uuid[]) and e.space_id = $1 and e.deleted_at is null
     and e.kind = any($3::text[])`;

const num = (value: string | number | null): number | null => (value == null ? null : Number(value));

function factsOf(row: HeaderRow): HeaderFacts | null {
  switch (row.kind) {
    case 'skill':
      return { kind: 'skill', description: row.skill_description, whenToUse: row.skill_when_to_use, bytes: num(row.skill_bytes) };
    case 'memory':
      if (row.memory_statement == null) return null;
      return { kind: 'memory', statement: row.memory_statement, subjectScope: row.memory_subject_scope, bytes: num(row.memory_bytes) };
    case 'team_member':
      return { kind: 'team_member', role: row.team_member_role, persona: row.team_member_persona, bytes: num(row.team_member_bytes) };
    case 'doc':
      return { kind: 'doc', head: row.doc_head, headings: row.doc_headings ?? [], bytes: num(row.doc_bytes) };
    case 'artifact':
      return { kind: 'artifact', description: row.artifact_description, bytes: num(row.artifact_bytes) };
    case 'drawing':
      return { kind: 'drawing', text: row.drawing_text, bytes: num(row.drawing_bytes) };
    case 'file':
      return { kind: 'file', name: row.file_name ?? 'File', mime: row.file_mime, bytes: num(row.file_size) };
    case 'task':
      return { kind: 'task', description: row.task_description, bytes: num(row.task_bytes) };
    case 'collection':
      return {
        kind: 'collection',
        description: row.collection_description,
        members: Object.fromEntries(Object.entries(row.collection_members ?? {}).map(([k, n]) => [k, Number(n)])),
      };
    default:
      return null;
  }
}

/**
 * Authored headers, keyed by entity id. The seam for `entity_headers` (I3):
 * until that table exists there are none, and every header is native or derived.
 */
async function loadAuthored(_q: Querier, _spaceId: string, _ids: readonly string[]): Promise<Map<string, AuthoredHeader>> {
  return new Map();
}

/**
 * Headers for `ids`, keyed by id, in the caller's transaction. Ids that are
 * unreadable, deleted, in another space or of a kind with no header are absent.
 */
export async function resolveHeaders(q: Querier, spaceId: string, ids: readonly string[]): Promise<Map<string, SelectionHeader>> {
  const wanted = [...new Set(ids)];
  const out = new Map<string, SelectionHeader>();
  if (wanted.length === 0) return out;
  const rows = await q.query<HeaderRow>(HEADER_SQL, [spaceId, wanted, [...SELECTION_HEADER_KINDS]]);
  const authored = await loadAuthored(q, spaceId, wanted);
  for (const row of rows) {
    const facts = factsOf(row);
    if (!facts) continue;
    // `titleOf` reads only the kind and that kind's own name column, all selected above.
    const name = titleOf({ ...row, deleted_at: null } as unknown as EntityRow);
    out.set(row.id, deriveHeader({ id: row.id, name }, facts, authored.get(row.id)));
  }
  return out;
}
