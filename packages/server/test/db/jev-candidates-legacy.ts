/**
 * FROZEN: Ask Jev's teammate, memory and skill loaders exactly as they were
 * before the header module (main e4172e3d, `packages/server/src/jev/candidates.ts`).
 * The golden parity test (`headers-jev-parity.pg.test.ts`) compares the live
 * loaders against these, byte for byte. Do not edit to make a test pass: a
 * change in Jev's candidate text is a deliberate change (headers T4) and
 * retires this file with it.
 */
import type { Querier } from '../../src/db/types.js';
import type { Candidate, CandidateSet } from '../../src/jev/candidates.js';
import { CANDIDATE_LIMIT } from '../../src/jev/candidates.js';
import { loadSkillEquipment } from '../../src/skills/equipment.js';
import type { RankedEntitySource } from '@tm8/contract';

const TEXT_LIMIT = 600;
const clip = (text: string | null | undefined, limit = TEXT_LIMIT): string => [...(text ?? '')].slice(0, limit).join('');
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Teammates
// ---------------------------------------------------------------------------

/**
 * Every live teammate in the space. Text is "name — role. Equipped with:
 * skill names. persona (600)" — the skill names include what each teammate
 * inherits from its ancestors, which is what it would actually carry.
 */
export async function legacyLoadTeammates(q: Querier, spaceId: string): Promise<CandidateSet> {
  const rows = await q.query<{ id: string; name: string; role: string | null; persona: string | null; total: string | number }>(
    `select e.id, tm.name, tm.role, left(tm.identity, ${TEXT_LIMIT}) as persona, count(*) over () as total
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
  const items = rows.map((row): Candidate => {
    const names = equipped.get(row.id) ?? [];
    const parts = [row.role?.trim() ? `${row.name} — ${row.role.trim()}.` : `${row.name}.`];
    if (names.length > 0) parts.push(`Equipped with: ${names.join(', ')}.`);
    if (row.persona?.trim()) parts.push(clip(row.persona));
    return { entityId: row.id, kind: 'team_member', title: row.name, text: parts.join(' '), sources: ['space'] };
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
export async function legacyLoadMemories(
  q: Querier,
  spaceId: string,
  teamMemberId: string,
  taskId: string | null,
): Promise<CandidateSet> {
  const rows = await q.query<{ id: string; statement: string; from_teammate: boolean; from_task: boolean; total: string | number }>(
    `with pool as (
       select m.entity_id as id, left(m.statement, ${TEXT_LIMIT}) as statement, e.updated_at,
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
     select id, statement, from_teammate, from_task, count(*) over () as total
       from pool
      order by (from_teammate or from_task) desc, updated_at desc, id
      limit ${CANDIDATE_LIMIT}`,
    [spaceId, teamMemberId, taskId],
  );
  const items = rows.map((row): Candidate => ({
    entityId: row.id,
    kind: 'memory',
    title: clip(oneLine(row.statement), 120) || 'Memory',
    text: clip(row.statement),
    sources: [
      ...(row.from_teammate ? ['teammate' as const] : []),
      ...(row.from_task ? ['task' as const] : []),
      'space',
    ],
  }));
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
export async function legacyLoadSkills(q: Querier, spaceId: string, teamMemberId: string): Promise<CandidateSet> {
  const direct = new Map<string, RankedEntitySource>();
  for (const row of await loadSkillEquipment(q, spaceId, teamMemberId)) {
    if (!row.missing) direct.set(row.entityId, row.depth === 0 ? 'teammate' : 'inherited');
  }
  const rows = await q.query<{ id: string; name: string; description: string | null; total: string | number }>(
    `select sk.entity_id as id, sk.name,
            left(coalesce(nullif(sk.description, ''), sk.frontmatter ->> 'when_to_use', ''), ${TEXT_LIMIT}) as description,
            count(*) over () as total
       from public.skills sk
       join public.entities se on se.id = sk.entity_id and se.kind = 'skill' and se.deleted_at is null
      where se.space_id = $1 and not sk.missing
      order by (sk.entity_id = any($2::uuid[])) desc, se.updated_at desc, se.id
      limit ${CANDIDATE_LIMIT}`,
    [spaceId, [...direct.keys()]],
  );
  const items = rows.map((row): Candidate => {
    const description = clip(row.description);
    const source = direct.get(row.id);
    return {
      entityId: row.id,
      kind: 'skill',
      title: row.name,
      text: description ? `${row.name}: ${description}` : row.name,
      sources: source ? [source, 'space'] : ['space'],
    };
  });
  return { items, considered: items.length, total: Number(rows[0]?.total ?? 0) };
}
