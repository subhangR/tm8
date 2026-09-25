/**
 * A dispatcher's roster (integrated design 01a0d348 §8 I8, headers T6): the
 * space's teammates its `<context_index>` renders as the `teammates` group.
 *
 * Read in the caller's transaction, so RLS decides: a teammate the caller
 * cannot read is in neither the rows nor the total. The order is stable (name,
 * then id) so two launches of one roster trim the same entries. The window
 * count runs before the LIMIT, so `total` is every readable teammate and the
 * rows past `limit` can be declared rather than dropped silently.
 */
import type { DispatcherRoster } from '@tm8/execution';
import type { Querier } from '../db/types.js';

export async function loadDispatcherRoster(
  q: Querier,
  input: { spaceId: string; excludeTeamMemberId: string; limit: number },
): Promise<DispatcherRoster> {
  const rows = await q.query<{ entity_id: string; name: string; mode: string | null; model: string | null; total: string | number }>(
    `select tm.entity_id, tm.name, tm.mode, tm.model, count(*) over () as total
       from public.team_members tm
       join public.entities e on e.id = tm.entity_id
      where e.space_id = $1 and e.deleted_at is null and tm.entity_id <> $2
      order by lower(tm.name), tm.entity_id
      limit $3`,
    [input.spaceId, input.excludeTeamMemberId, input.limit],
  );
  return {
    members: rows.map((row) => ({ entityId: row.entity_id, name: row.name, mode: row.mode, model: row.model })),
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
  };
}
