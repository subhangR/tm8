/**
 * SPAWN'S DEFAULTS, per selection group (integrated design 01a0d348 §5.1) —
 * what a launch loads for a group it does not select.
 *
 * ONE SET OF LOADERS, TWO READERS. `loadSpawnContext` (execution-handlers)
 * reads them to audit every default an exact set leaves out as
 * `not-selected`, and to build the skill index; `launch.defaults` reads them
 * so the launch sheet pre-ticks exactly what spawn would load. A second copy
 * of any of these queries in the sheet's read would be free to drift from
 * spawn's — which is the reason this module exists.
 *
 * Every loader takes the caller's transaction, so RLS decides what exists.
 */
import { SPAWN_SELECTION_REFERENCE_KINDS } from '@tm8/contract';
import type { ResolvedSkillRow } from '@tm8/execution';

import type { Querier } from '../db/types.js';
import { loadSkillEquipment, loadTaskSkillEquipment } from '../skills/equipment.js';

/**
 * The memories defaults: the teammate's and the spawn tasks' `remembers`,
 * minus superseded (a superseded memory is known-replaced context), in
 * creation order — exactly the working set the no-selection path injects.
 * `fromTeammate` says which holder brought it (the teammate wins a tie).
 */
export async function loadMemoryDefaults(
  q: Querier,
  spaceId: string,
  teamMemberId: string,
  taskIds: readonly string[],
): Promise<Array<{ entityId: string; fromTeammate: boolean }>> {
  const rows = await q.query<{ entity_id: string; from_teammate: boolean }>(
    `select m.entity_id,
            exists (select 1 from public.edges rt
                     where rt.type = 'remembers' and rt.src_id = $1 and rt.dst_id = m.entity_id) as from_teammate
       from public.memories m
       join public.entities e on e.id = m.entity_id and e.deleted_at is null
      where e.space_id = $2
        and exists (select 1 from public.edges r
                     where r.type = 'remembers' and r.dst_id = m.entity_id
                       and (r.src_id = $1 or r.src_id = any($3::uuid[])))
        and not exists (select 1 from public.edges s
                         where s.type = 'supersedes' and s.dst_id = m.entity_id)
      order by m.created_at, m.entity_id`,
    [teamMemberId, spaceId, [...taskIds]],
  );
  return rows.map((row) => ({ entityId: row.entity_id, fromTeammate: row.from_teammate }));
}

/**
 * The skills defaults: what the spawn's TASKS equip that the persona lacks,
 * then the persona's own (and its ancestors', `depth` > 0) — spawn's order,
 * deduped by id with the persona's row winning. `depth` -1 marks a task row.
 */
export async function loadSkillDefaults(
  q: Querier,
  spaceId: string,
  teamMemberId: string,
  taskIds: readonly string[],
): Promise<ResolvedSkillRow[]> {
  const personaEquipped = await loadSkillEquipment(q, spaceId, teamMemberId);
  const personaIds = new Set(personaEquipped.map((row) => row.entityId));
  return [
    ...(await loadTaskSkillEquipment(q, spaceId, taskIds)).filter((row) => !personaIds.has(row.entityId)),
    ...personaEquipped,
  ];
}

/**
 * The spawn tasks' reference DEFAULTS, uncapped: live same-space peers of a
 * selectable reference kind that a task links by outgoing `relates_to` or
 * incoming `attached_to` (a file attached to a task is its attachment). The
 * same edges the assignment snapshot's `linked` / `attachments` read, minus
 * its row cap, because a default left out of an exact set must be recorded
 * even when the snapshot never read it. Edge order, first link wins.
 */
export async function loadReferenceDefaults(
  q: Querier,
  spaceId: string,
  taskIds: readonly string[],
): Promise<Array<{ entityId: string; kind: string; link: string }>> {
  if (taskIds.length === 0) return [];
  const rows = await q.query<{ entity_id: string; kind: string; link: string }>(
    `select d.entity_id, d.kind, d.link
       from (
         select distinct on (l.peer_id) l.peer_id as entity_id, pe.kind, l.link, l.created_at, l.edge_id
           from (
             select r.dst_id as peer_id, 'relates_to'::text as link, r.created_at, r.id as edge_id
               from public.edges r
              where r.src_id = any($1::uuid[]) and r.type = 'relates_to'
             union all
             select a.src_id, 'attached_to', a.created_at, a.id
               from public.edges a
              where a.dst_id = any($1::uuid[]) and a.type = 'attached_to'
           ) l
           join public.entities pe
             on pe.id = l.peer_id and pe.space_id = $2 and pe.deleted_at is null
            and pe.kind = any($3::text[])
          order by l.peer_id, l.created_at, l.edge_id
       ) d
      order by d.created_at, d.edge_id`,
    [taskIds, spaceId, [...SPAWN_SELECTION_REFERENCE_KINDS]],
  );
  return rows.map((row) => ({ entityId: row.entity_id, kind: row.kind, link: row.link }));
}

