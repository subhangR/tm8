/**
 * What Jev is shown: the subject and the four candidate groups (design
 * 01a0cb80 §4.1).
 *
 * Every loader takes the CALLER'S transaction (`deps.db.tx(claimsFor(owner,
 * ctx), …)`, as `skills.preview` does), so RLS decides what exists: Jev is
 * never shown an entity the person pressing Ask Jev cannot read.
 *
 * Candidates are the UNION of their sources, one entry per entity id, and each
 * keeps every source it came from in `sources[]`. A group holds at most
 * `CANDIDATE_LIMIT` entries; above that the direct sources (the teammate's and
 * the task's) come first and the rest of the space follows, most recently
 * updated first. `considered` and `total` say how many of how many.
 *
 * Text limits (§9 — what leaves the server): memory statements and personas
 * are cut at 600 characters, and a skill is its name and description — its
 * body is never selected, let alone sent.
 *
 * Each loader's SQL chooses the POOL (sources, order, the 240 cap, `total`);
 * the text comes from the header module — `jevText(resolveHeaders(ids))` — so
 * no loader builds its own snippet (headers design 01a0d31e §7).
 */
import { SPAWN_SELECTION_GROUP_LIMIT, type RankedEntityKind, type RankedEntitySource } from '@tm8/contract';
import { redactSecretTokens } from '@tm8/execution';

import type { Querier } from '../db/types.js';
import { ENTITY_COLUMNS, ENTITY_FROM, titleOf, type EntityRow } from '../facade/entity-read.js';
import { fail } from '../http/errors.js';
import { clip, HEADER_TEXT_LIMIT } from '../headers/derive.js';
import { jevText } from '../headers/render.js';
import { resolveHeaders } from '../headers/resolve.js';
import { loadSkillEquipment } from '../skills/equipment.js';
import type { JevSubject } from './port.js';

/**
 * 4 chunks of 60, each one parallel Jev call (§4.1). Defined FROM the spawn
 * selection's per-group ceiling (design 01a0d348 §10 Q5.7): nothing outside
 * the pool can be ticked, so the two are one number.
 */
export const CANDIDATE_LIMIT = SPAWN_SELECTION_GROUP_LIMIT;
/** Characters of a memory statement, a persona, or a skill description that may leave the server (§9). */
export const TEXT_LIMIT = HEADER_TEXT_LIMIT;

export interface Candidate {
  entityId: string;
  kind: RankedEntityKind;
  /** What the UI shows. Never sent anywhere but back to the caller. */
  title: string;
  /** What Jev is shown. */
  text: string;
  sources: RankedEntitySource[];
}

export interface CandidateSet {
  items: Candidate[];
  /** `items.length`: how many were sent to Jev. */
  considered: number;
  /** How many there were before the limit. */
  total: number;
}

export interface LoadedSubject {
  subject: JevSubject;
  /** The task whose `remembers` set is a memory source: the subject itself, or its one open derived task. */
  taskId: string | null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

interface TaskFactsRow {
  title: string;
  description: string | null;
  priority: string | null;
  work_status: string | null;
  acceptance_count: number;
  parent_id: string | null;
}

async function entityRow(q: Querier, spaceId: string, id: string): Promise<EntityRow | null> {
  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1 and e.space_id = $2 and e.deleted_at is null`,
    [id, spaceId],
  );
  return rows[0] ?? null;
}

/**
 * The task a launch from `subjectId` works on, read-only: the subject itself
 * when it is a task, else its one open derived task — the SAME derivation
 * spawn uses (`derive_task_for_entity`, 064/099/200: a message means its
 * thread root) but WITHOUT the write, so reading never mints a task. Null
 * `taskId` when no single open derived task exists yet. Undefined when the
 * subject is not a live entity the caller can read in this space.
 *
 * Shared by Ask Jev's subject and `launch.defaults`.
 */
export async function resolveSubjectTask(
  q: Querier,
  spaceId: string,
  subjectId: string,
): Promise<{ taskId: string | null; anchor: EntityRow } | undefined> {
  const root = await entityRow(q, spaceId, subjectId);
  if (!root) return undefined;
  if (root.kind === 'task') return { taskId: root.id, anchor: root };
  let anchor = root;
  if (root.kind === 'message' && root.root_message_id && root.root_message_id !== root.id) {
    anchor = (await entityRow(q, spaceId, root.root_message_id)) ?? root;
  }
  const derived = await q.query<{ id: string }>(
    `select t.entity_id as id
       from public.edges d
       join public.tasks t on t.entity_id = d.src_id
       join public.entities e on e.id = t.entity_id
      where d.type = 'derived_from' and d.dst_id = $1
        and e.space_id = $2 and e.deleted_at is null
        and t.work_status not in ('done', 'cancelled')`,
    [anchor.id, spaceId],
  );
  return { taskId: derived.length === 1 ? derived[0]!.id : null, anchor };
}

/**
 * The subject's facts, read-only.
 *
 * A non-task subject goes through the SAME derivation spawn uses
 * (`derive_task_for_entity`, 064/099/200) — a message means its thread root,
 * and exactly one open derived task is that entity's task — but WITHOUT the
 * write: pressing Ask Jev must never mint a task. When no single open derived
 * task exists, the facts are what the derivation would title it ("Work on: …",
 * "Continue: …" for a session) and, for a message, the root's body.
 */
export async function loadSubject(
  q: Querier,
  spaceId: string,
  subjectId: string,
  draft: { title: string; description: string } | undefined,
): Promise<LoadedSubject> {
  const resolved = await resolveSubjectTask(q, spaceId, subjectId);
  if (!resolved) throw fail('not_found', `subject ${subjectId} is not a live entity in this space`);
  const { taskId, anchor } = resolved;

  let subject: JevSubject;
  if (taskId) {
    const task = (await q.query<TaskFactsRow>(
      `select t.title, t.description, t.priority, t.work_status, e.parent_id,
              case when jsonb_typeof(t.acceptance_criteria) = 'array'
                   then jsonb_array_length(t.acceptance_criteria) else 0 end as acceptance_count
         from public.tasks t join public.entities e on e.id = t.entity_id
        where t.entity_id = $1 and e.space_id = $2 and e.deleted_at is null`,
      [taskId, spaceId],
    ))[0];
    if (!task) throw fail('not_found', `task ${taskId} is not a live task in this space`);
    const parent = task.parent_id ? await entityRow(q, spaceId, task.parent_id) : null;
    subject = {
      title: task.title ?? '',
      description: task.description ?? '',
      ...(task.priority ? { priority: task.priority } : {}),
      ...(task.work_status ? { status: task.work_status } : {}),
      acceptanceCriteriaCount: Number(task.acceptance_count),
      ...(parent ? { parentTitle: redactedTitleOf(parent) } : {}),
    };
  } else {
    subject = {
      title: `${anchor.kind === 'work_session' ? 'Continue: ' : 'Work on: '}${redactedTitleOf(anchor)}`,
      description: anchor.kind === 'message' ? anchor.message_body ?? '' : '',
    };
  }
  if (draft) subject = { ...subject, title: draft.title, description: draft.description };
  return { subject: redactSubject(subject), taskId };
}

/**
 * `titleOf` over redacted text: a memory's title is its statement cut to 120,
 * and a key straddling that cut would leave a prefix no pattern matches.
 */
function redactedTitleOf(row: EntityRow): string {
  const statement = row.memory_statement;
  return titleOf(statement == null ? row : { ...row, memory_statement: redactSecretTokens(statement) });
}

/** The subject leaves the server for the Jev model, so every text in it is redacted (the manifest's grammar). */
export function redactSubject(subject: JevSubject): JevSubject {
  return {
    ...subject,
    title: redactSecretTokens(subject.title),
    description: redactSecretTokens(subject.description),
    ...(subject.parentTitle !== undefined ? { parentTitle: redactSecretTokens(subject.parentTitle) } : {}),
  };
}

/** §8: nothing to ask about. Every group is skipped with `no_subject_text`. */
export function hasSubjectText(subject: JevSubject): boolean {
  return subject.title.trim().length > 0 || subject.description.trim().length > 0;
}

/** The teammate must be a live team_member in this space, readable by the caller. */
export async function requireTeammate(q: Querier, spaceId: string, teamMemberId: string): Promise<void> {
  const rows = await q.query<{ id: string }>(
    `select e.id from public.entities e join public.team_members tm on tm.entity_id = e.id
      where e.id = $1 and e.space_id = $2 and e.kind = 'team_member' and e.deleted_at is null`,
    [teamMemberId, spaceId],
  );
  if (rows.length === 0) throw fail('not_found', `teammate ${teamMemberId} not found in this space`);
}

// ---------------------------------------------------------------------------
// Teammates
// ---------------------------------------------------------------------------

/**
 * Every live teammate in the space. Text is "name — role. Equipped with:
 * skill names. persona (600)" — the skill names include what each teammate
 * inherits from its ancestors, which is what it would actually carry.
 */
export async function loadTeammates(q: Querier, spaceId: string): Promise<CandidateSet> {
  const rows = await q.query<{ id: string; total: string | number }>(
    `select e.id, count(*) over () as total
       from public.team_members tm
       join public.entities e on e.id = tm.entity_id
      where e.space_id = $1 and e.kind = 'team_member' and e.deleted_at is null
      order by e.updated_at desc, e.id
      limit ${CANDIDATE_LIMIT}`,
    [spaceId],
  );
  const skills = rows.length === 0 ? [] : await q.query<{ root: string; names: string[] }>(
    `with recursive chain as (
       select e.id as root, e.id, e.parent_id, 0 as depth from public.entities e
        where e.id = any($2::uuid[]) and e.space_id = $1
       union all
       select c.root, p.id, p.parent_id, c.depth + 1 from chain c join public.entities p on p.id = c.parent_id
        where p.space_id = $1 and p.kind = 'team_member' and p.deleted_at is null and c.depth < 16
     ) select c.root, array_agg(distinct sk.name order by sk.name) as names
         from chain c
         join public.edges ed on ed.src_id = c.id and ed.type = 'equips' and ed.space_id = $1
         join public.entities se on se.id = ed.dst_id and se.kind = 'skill' and se.space_id = $1 and se.deleted_at is null
         join public.skills sk on sk.entity_id = se.id
        group by c.root`,
    [spaceId, rows.map((row) => row.id)],
  );
  const equipped = new Map(skills.map((row) => [row.root, row.names]));
  const headers = await resolveHeaders(q, spaceId, rows.map((row) => row.id));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    // The pool query and `resolveHeaders` read separate READ COMMITTED
    // snapshots, so an entity deleted between them has no header: it is
    // dropped here and shows only as `considered` < the pool's rows.
    if (!header) return [];
    const text = jevText(header, { limit: TEXT_LIMIT, equippedSkills: equipped.get(row.id) ?? [] });
    return [{ entityId: row.id, kind: 'team_member', title: header.name, text, sources: ['space'] }];
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

/**
 * ① the teammate's `remembers` working set, ② the subject task's `remembers`
 * set, ③ every live memory in the space — all NON-SUPERSEDED, the same rule
 * spawn applies to a working set (a superseded memory is known-replaced
 * context; its successor is the candidate).
 */
export async function loadMemories(
  q: Querier,
  spaceId: string,
  teamMemberId: string,
  taskId: string | null,
): Promise<CandidateSet> {
  const rows = await q.query<{ id: string; from_teammate: boolean; from_task: boolean; total: string | number }>(
    `with pool as (
       select m.entity_id as id, e.updated_at,
              exists (select 1 from public.edges r
                       where r.type = 'remembers' and r.src_id = $2 and r.dst_id = m.entity_id) as from_teammate,
              ($3::uuid is not null and exists (select 1 from public.edges r
                       where r.type = 'remembers' and r.src_id = $3 and r.dst_id = m.entity_id)) as from_task
         from public.memories m
         join public.entities e on e.id = m.entity_id and e.kind = 'memory' and e.deleted_at is null
        where e.space_id = $1
          and not exists (select 1 from public.edges s
                           where s.type = 'supersedes' and s.dst_id = m.entity_id)
     )
     select id, from_teammate, from_task, count(*) over () as total
       from pool
      order by (from_teammate or from_task) desc, updated_at desc, id
      limit ${CANDIDATE_LIMIT}`,
    [spaceId, teamMemberId, taskId],
  );
  const headers = await resolveHeaders(q, spaceId, rows.map((row) => row.id));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    // The pool query and `resolveHeaders` read separate READ COMMITTED
    // snapshots, so an entity deleted between them has no header: it is
    // dropped here and shows only as `considered` < the pool's rows.
    if (!header) return [];
    return [{
      entityId: row.id,
      kind: 'memory',
      // The statement's first 600 characters, on one line, cut to 120.
      title: clip(oneLine(clip(header.summary)), 120) || 'Memory',
      text: jevText(header, { limit: TEXT_LIMIT }),
      sources: [
        ...(row.from_teammate ? ['teammate' as const] : []),
        ...(row.from_task ? ['task' as const] : []),
        'space',
      ],
    }];
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * ① what the teammate is equipped with, its ancestors' equipment included
 * (`loadSkillEquipment`, the reader spawn and `skills.preview` use — depth 0
 * is `teammate`, deeper is `inherited`), ② every live skill in the space.
 * A filesystem reference the scanner marked `missing` is excluded from both:
 * a session could not load it, so suggesting it would be advice nobody can take.
 */
export async function loadSkills(q: Querier, spaceId: string, teamMemberId: string): Promise<CandidateSet> {
  const direct = new Map<string, RankedEntitySource>();
  for (const row of await loadSkillEquipment(q, spaceId, teamMemberId)) {
    if (!row.missing) direct.set(row.entityId, row.depth === 0 ? 'teammate' : 'inherited');
  }
  const rows = await q.query<{ id: string; total: string | number }>(
    `select sk.entity_id as id, count(*) over () as total
       from public.skills sk
       join public.entities se on se.id = sk.entity_id and se.kind = 'skill' and se.deleted_at is null
      where se.space_id = $1 and not sk.missing
      order by (sk.entity_id = any($2::uuid[])) desc, se.updated_at desc, se.id
      limit ${CANDIDATE_LIMIT}`,
    [spaceId, [...direct.keys()]],
  );
  const headers = await resolveHeaders(q, spaceId, rows.map((row) => row.id));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    // The pool query and `resolveHeaders` read separate READ COMMITTED
    // snapshots, so an entity deleted between them has no header: it is
    // dropped here and shows only as `considered` < the pool's rows.
    if (!header) return [];
    const source = direct.get(row.id);
    return [{
      entityId: row.id,
      kind: 'skill',
      title: header.name,
      text: jevText(header, { limit: TEXT_LIMIT }),
      sources: source ? [source, 'space'] : ['space'],
    }];
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}
