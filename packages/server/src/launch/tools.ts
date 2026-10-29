/**
 * The space's tools for the launch `<context_index>` `tools` group (Tools v2
 * PR-E, design doc 01a182cb §5).
 *
 * Read in the caller's transaction, so RLS decides: a tool the caller cannot
 * read is in neither the rows nor the total, and a run the caller cannot read
 * does not move its tool up. The order is stable: the most recent run first
 * (run ids are time-ordered, as `loadTool`'s last-run read relies on, and the
 * partial index on `(tool_id, entity_id)` answers it), a tool never run after
 * every run one, then by name (byte order), then id, so two launches of one
 * space trim the same entries. The window count runs before the LIMIT, so
 * `total` is every readable tool and the rest can be declared rather than
 * dropped silently.
 */
import type { SpaceTools } from '@tm8/execution';
import type { Querier } from '../db/types.js';

export async function loadSpaceTools(
  q: Querier,
  input: { spaceId: string; limit: number },
): Promise<SpaceTools> {
  const rows = await q.query<{ entity_id: string; name: string; total: string | number }>(
    `select e.id as entity_id, t.definition ->> 'name' as name, count(*) over () as total
       from public.entities e
       join public.tools t on t.entity_id = e.id
       left join lateral (
         select w.entity_id as run_id
           from public.work_sessions w
           join public.entities r on r.id = w.entity_id
          where w.tool_id = e.id and w.session_kind = 'tool'
            and r.deleted_at is null and internal.entity_readable(r.id)
          order by w.entity_id desc
          limit 1
       ) last_run on true
      where e.space_id = $1 and e.kind = 'tool' and e.deleted_at is null and internal.entity_readable(e.id)
      order by last_run.run_id desc nulls last, (t.definition ->> 'name') collate "C", e.id
      limit $2`,
    [input.spaceId, input.limit],
  );
  return {
    tools: rows.map((row) => ({ entityId: row.entity_id, name: row.name })),
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
  };
}
