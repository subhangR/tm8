import { resolveSkills, type ResolvedSkillRow } from '@tm8/execution';
import type { Querier } from '../db/types.js';
import { SKILL_REFERENCE_SQL, skillReferenceOf } from './reference.js';

/** No task/session equips and no body column. RLS and explicit Space predicates both apply. */
export async function loadSkillEquipment(q: Querier, spaceId: string, teamMemberId: string): Promise<ResolvedSkillRow[]> {
  const rows = await q.query<{ entity_id: string; version: number; name: string; description: string; reference: Record<string, unknown>; depth: number }>(
    `with recursive chain as (
      select e.id, e.parent_id, 0 as depth from public.entities e
       where e.id = $1 and e.space_id = $2 and e.kind = 'team_member' and e.deleted_at is null
      union all
      select p.id, p.parent_id, c.depth + 1 from chain c join public.entities p on p.id = c.parent_id
       where p.space_id = $2 and p.kind = 'team_member' and p.deleted_at is null and c.depth < 16
    ) select sk.entity_id, se.version, sk.name, sk.description, ${SKILL_REFERENCE_SQL} as reference, min(chain.depth) as depth
      from chain join public.edges ed on ed.src_id = chain.id and ed.type = 'equips' and ed.space_id = $2
      join public.entities se on se.id = ed.dst_id and se.kind = 'skill' and se.space_id = $2 and se.deleted_at is null
      join public.skills sk on sk.entity_id = se.id
      group by sk.entity_id, se.version order by depth, sk.name, sk.entity_id`, [teamMemberId, spaceId]);
  return resolveSkills(rows.map(row => ({ ...skillReferenceOf(row.reference), entityId: row.entity_id, entityVersion: row.version, name: row.name, description: row.description, depth: Number(row.depth) }))).skills;
}

/**
 * Skills equipped on the spawn's TASKS (`equips` task → skill, what the task
 * attach palette writes). They ride the same index, byte budget and
 * `selection` as persona equipment. Their depth is -1, nearer than the persona
 * itself (depth 0), because a task is the more specific ask: a same-name persona
 * skill is shadowed, not doubled. Each row carries `viaTaskId`, which is the first spawn
 * task (in the caller's order) that equips it. Rows come back in task order,
 * then by name. No body column, same as above.
 */
export async function loadTaskSkillEquipment(q: Querier, spaceId: string, taskIds: readonly string[]): Promise<ResolvedSkillRow[]> {
  if (taskIds.length === 0) return [];
  const rows = await q.query<{ entity_id: string; version: number; name: string; description: string; reference: Record<string, unknown>; task_id: string; task_rank: number }>(
    `select distinct on (sk.entity_id) sk.entity_id, se.version, sk.name, sk.description,
            ${SKILL_REFERENCE_SQL} as reference, ed.src_id as task_id,
            array_position($1::uuid[], ed.src_id) as task_rank
       from public.edges ed
       join public.entities te on te.id = ed.src_id and te.kind = 'task' and te.space_id = $2 and te.deleted_at is null
       join public.entities se on se.id = ed.dst_id and se.kind = 'skill' and se.space_id = $2 and se.deleted_at is null
       join public.skills sk on sk.entity_id = se.id
      where ed.type = 'equips' and ed.space_id = $2 and ed.src_id = any($1::uuid[])
      order by sk.entity_id, array_position($1::uuid[], ed.src_id)`, [taskIds, spaceId]);
  return rows
    .sort((a, b) => Number(a.task_rank) - Number(b.task_rank) || a.name.localeCompare(b.name) || a.entity_id.localeCompare(b.entity_id))
    .map(row => ({ ...skillReferenceOf(row.reference), entityId: row.entity_id, entityVersion: row.version, name: row.name, description: row.description, depth: -1, viaTaskId: row.task_id }));
}

/**
 * Every live Claude PLUGIN skill in the space (`level = 'plugin'`), for the
 * launch composer's plugin → skill mapping (design 01a0d348 §3.5, F3). Not
 * equipment: it names what a plugin tick could select, and writes nothing.
 * Same projection as above, no body column; RLS and the Space predicate apply.
 */
export async function loadPluginSkills(q: Querier, spaceId: string): Promise<ResolvedSkillRow[]> {
  const rows = await q.query<{ entity_id: string; version: number; name: string; description: string; reference: Record<string, unknown> }>(
    `select sk.entity_id, se.version, sk.name, sk.description, ${SKILL_REFERENCE_SQL} as reference
       from public.skills sk
       join public.entities se on se.id = sk.entity_id and se.kind = 'skill' and se.space_id = $1 and se.deleted_at is null
      where sk.provider = 'claude' and sk.level = 'plugin' and sk.missing is not true
      order by sk.name, sk.entity_id`, [spaceId]);
  return rows.map(row => ({ ...skillReferenceOf(row.reference), entityId: row.entity_id, entityVersion: row.version, name: row.name, description: row.description, depth: 0 }));
}
