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
