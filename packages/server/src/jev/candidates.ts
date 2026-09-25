/**
 * What Jev is shown: the subject and the candidate groups (design 01a0cb80
 * §4.1; the references group, design 01a0d348 §8 I7 / headers 01a0d31e §7.1).
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
 *
 * Every candidate also carries what the launch sheet fills a budget with
 * (design 01a0d348 §10 Q5): whether it is a DEFAULT of the launch (from
 * spawn's own loaders, `facade/spawn-defaults.ts`), the header in effect, and
 * its `promptBytes` (`measure.ts`, spawn's serializers).
 */
import {
  SPAWN_SELECTION_GROUP_LIMIT,
  SPAWN_SELECTION_REFERENCE_KINDS,
  type EntityHeaderView,
  type RankedEntityHeader,
  type RankedEntityKind,
  type RankedEntitySource,
} from '@tm8/contract';
import { redactSecretTokens, type ContextVia, type ResolvedSkillRow } from '@tm8/execution';

import type { Querier } from '../db/types.js';
import { ENTITY_COLUMNS, ENTITY_FROM, titleOf, type EntityRow } from '../facade/entity-read.js';
import { loadMemoryDefaults, loadReferenceDefaults, loadSkillDefaults } from '../facade/spawn-defaults.js';
import { loadMemoriesById, renderMemoryText } from '../facade/spawn-memories.js';
import { fail } from '../http/errors.js';
import { clip, HEADER_TEXT_LIMIT } from '../headers/derive.js';
import { jevText } from '../headers/render.js';
import { resolveHeaderViews } from '../headers/resolve.js';
import { loadSkillsById } from '../skills/equipment.js';
import { memoryPromptBytes, referencePromptBytes, skillPromptBytes, teammatePromptBytes, type MeasureContext } from './measure.js';
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
  /** What spawn loads for this group when nothing is selected. */
  default: boolean;
  /** Bytes it adds to the launch prompt when ticked (`measure.ts`). */
  promptBytes: number;
  header: RankedEntityHeader;
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
  /** That task's parent task, whose links are a reference source. */
  parentTaskId: string | null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The header in effect, as a ranked row carries it (coordinator note on I7: I1's resolver, under RLS). */
function rankedHeader(view: EntityHeaderView): RankedEntityHeader {
  return {
    whenToUse: view.whenToUse,
    summary: view.summary,
    keywords: [...view.keywords],
    source: view.source,
    version: view.version,
  };
}

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
  let parentTaskId: string | null = null;
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
    if (parent?.kind === 'task') parentTaskId = parent.id;
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
  return { subject: redactSubject(subject), taskId, parentTaskId };
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

/**
 * The teammate must be a live team_member in this space, readable by the
 * caller. Returns its own agent tool, the one a launch runs when it names none.
 */
export async function requireTeammate(q: Querier, spaceId: string, teamMemberId: string): Promise<{ agentTool: string | null }> {
  const rows = await q.query<{ id: string; agent_tool: string | null }>(
    `select e.id, tm.agent_tool from public.entities e join public.team_members tm on tm.entity_id = e.id
      where e.id = $1 and e.space_id = $2 and e.kind = 'team_member' and e.deleted_at is null`,
    [teamMemberId, spaceId],
  );
  if (rows.length === 0) throw fail('not_found', `teammate ${teamMemberId} not found in this space`);
  return { agentTool: rows[0]!.agent_tool };
}

// ---------------------------------------------------------------------------
// Teammates
// ---------------------------------------------------------------------------

/**
 * Every live teammate in the space. Text is "name — role. Equipped with:
 * skill names. persona (600)" — the skill names include what each teammate
 * inherits from its ancestors, which is what it would actually carry.
 */
export async function loadTeammates(q: Querier, spaceId: string, measure: MeasureContext): Promise<CandidateSet> {
  const rows = await q.query<{ id: string; name: string; mode: string | null; model: string | null; total: string | number }>(
    `select e.id, tm.name, tm.mode, tm.model, count(*) over () as total
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
  const headers = await resolveHeaderViews(q, spaceId, rows.map((row) => row.id));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    // The pool query and `resolveHeaders` read separate READ COMMITTED
    // snapshots, so an entity deleted between them has no header: it is
    // dropped here and shows only as `considered` < the pool's rows.
    if (!header) return [];
    const text = jevText(header, { limit: TEXT_LIMIT, equippedSkills: equipped.get(row.id) ?? [] });
    return [{
      entityId: row.id,
      kind: 'team_member',
      title: header.name,
      text,
      sources: ['space'],
      // Picking who runs the launch is not a context group: nothing is a default.
      default: false,
      // As a dispatcher's roster renders it (I8's `rosterEntry`): mode and model included.
      promptBytes: teammatePromptBytes({ entityId: row.id, name: row.name, mode: row.mode, model: row.model }, header, measure),
      header: rankedHeader(header),
    }];
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
  const defaults = new Set((await loadMemoryDefaults(q, spaceId, teamMemberId, taskId ? [taskId] : [])).map((row) => row.entityId));
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
  const headers = await resolveHeaderViews(q, spaceId, rows.map((row) => row.id));
  // The WHOLE statement with its marks, exactly as spawn injects it: that is
  // what a ticked memory costs.
  const rendered = new Map((await loadMemoriesById(q, spaceId, rows.map((row) => row.id)))
    .map((row) => [row.entity_id, renderMemoryText(row)]));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    const text = rendered.get(row.id);
    // The pool query and `resolveHeaders` read separate READ COMMITTED
    // snapshots, so an entity deleted between them has no header: it is
    // dropped here and shows only as `considered` < the pool's rows.
    if (!header || text === undefined) return [];
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
      default: defaults.has(row.id),
      promptBytes: memoryPromptBytes(text),
      header: rankedHeader(header),
    }];
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * ① what spawn equips by default — the teammate's equipment with its
 * ancestors' (`loadSkillEquipment`: depth 0 is `teammate`, deeper is
 * `inherited`) and the task's (`task`), through `loadSkillDefaults`, the
 * loader spawn itself runs; ② every live skill in the space. A filesystem
 * reference the scanner marked `missing` is excluded from both: a session
 * could not load it, so suggesting it would be advice nobody can take.
 */
export async function loadSkills(
  q: Querier,
  spaceId: string,
  teamMemberId: string,
  taskId: string | null,
  measure: MeasureContext,
): Promise<CandidateSet> {
  const direct = new Map<string, ResolvedSkillRow>();
  for (const row of await loadSkillDefaults(q, spaceId, teamMemberId, taskId ? [taskId] : [])) {
    if (!row.missing) direct.set(row.entityId, row);
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
  const headers = await resolveHeaderViews(q, spaceId, rows.map((row) => row.id));
  // A skill the launch does not equip rides it by id — spawn's own by-id read.
  const byId = new Map((await loadSkillsById(q, spaceId, rows.map((row) => row.id).filter((id) => !direct.has(id))))
    .map((row) => [row.entityId, row]));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    // The pool query and `resolveHeaders` read separate READ COMMITTED
    // snapshots, so an entity deleted between them has no header: it is
    // dropped here and shows only as `considered` < the pool's rows.
    const equipped = direct.get(row.id);
    const skill = equipped ?? byId.get(row.id);
    if (!header || !skill) return [];
    // How spawn names the path the skill arrives by (`skillVia`).
    const via: ContextVia = !equipped ? 'selection' : equipped.viaTaskId ? 'task' : equipped.depth > 0 ? 'inherited' : 'teammate';
    const source: RankedEntitySource | null = equipped ? (via as RankedEntitySource) : null;
    return [{
      entityId: row.id,
      kind: 'skill',
      title: header.name,
      text: jevText(header, { limit: TEXT_LIMIT }),
      sources: source ? [source, 'space'] : ['space'],
      default: equipped !== undefined,
      promptBytes: skillPromptBytes(skill, via, header, measure),
      header: rankedHeader(header),
    }];
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * The reference kinds the space pool offers (③): the live docs and artifacts,
 * most recently updated first (headers design 01a0d31e §7.1). The task's own
 * links may be of any kind `selection.referenceIds` names.
 */
const SPACE_REFERENCE_KINDS = ['doc', 'artifact'] as const;

/**
 * ① what the launch's task links — `loadReferenceDefaults`, the loader spawn
 * runs, so these are exactly the references an unselected launch carries
 * (`task`, a default); ② what the task's PARENT task links (`parent`): the
 * references its sibling work shares; ③ the space's live docs and artifacts
 * (`space`). A body is never read, let alone sent: the text is the header.
 */
export async function loadReferences(
  q: Querier,
  spaceId: string,
  taskId: string | null,
  parentTaskId: string | null,
  measure: MeasureContext,
): Promise<CandidateSet> {
  const defaults = new Map((await loadReferenceDefaults(q, spaceId, taskId ? [taskId] : [])).map((row) => [row.entityId, row]));
  const parentLinks = new Set((await loadReferenceDefaults(q, spaceId, parentTaskId ? [parentTaskId] : [])).map((row) => row.entityId));
  if (taskId) parentLinks.delete(taskId);
  const rows = await q.query<{ id: string; kind: string; total: string | number }>(
    `select e.id, e.kind, count(*) over () as total
       from public.entities e
      where e.space_id = $1 and e.deleted_at is null
        and e.kind = any($4::text[])
        and (e.id = any($2::uuid[]) or e.id = any($3::uuid[]) or e.kind = any($5::text[]))
        and ($6::uuid is null or e.id <> $6::uuid)
      order by (e.id = any($2::uuid[])) desc, (e.id = any($3::uuid[])) desc, e.updated_at desc, e.id
      limit ${CANDIDATE_LIMIT}`,
    [spaceId, [...defaults.keys()], [...parentLinks], [...SPAWN_SELECTION_REFERENCE_KINDS], [...SPACE_REFERENCE_KINDS], taskId],
  );
  const headers = await resolveHeaderViews(q, spaceId, rows.map((row) => row.id));
  const items = rows.flatMap((row): Candidate[] => {
    const header = headers.get(row.id);
    // Deleted between the two reads (see loadSkills).
    if (!header) return [];
    const dflt = defaults.get(row.id);
    const sources: RankedEntitySource[] = [
      ...(dflt ? ['task' as const] : []),
      ...(parentLinks.has(row.id) ? ['parent' as const] : []),
      'space',
    ];
    // Spawn's rule for a selected reference's `via` and `link`.
    const via = dflt ? (dflt.link === 'attached_to' && row.kind === 'file' ? 'attached' : 'linked') : 'selection';
    return [{
      entityId: row.id,
      kind: row.kind as RankedEntityKind,
      title: header.name,
      text: jevText(header, { limit: TEXT_LIMIT }),
      sources,
      default: dflt !== undefined,
      promptBytes: referencePromptBytes({ entityId: row.id, kind: row.kind, via, link: dflt?.link ?? null, title: header.name }, header, measure),
      header: rankedHeader(header),
    }];
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}
