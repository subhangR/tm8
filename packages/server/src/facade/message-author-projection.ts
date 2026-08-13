import type { Querier } from '../db/types.js';

export interface HumanMessageAuthorIds { ids: string[]; total: number }

/** Three most-recent distinct human authors plus the honest unique total. */
export async function loadHumanMessageAuthorIds(
  q: Querier,
  anchorIds: readonly string[],
): Promise<Map<string, HumanMessageAuthorIds>> {
  const out = new Map<string, HumanMessageAuthorIds>();
  if (anchorIds.length === 0) return out;
  const rows = await q.query<{ anchor_id: string; author_ids: string[]; total: number }>(
    `with ranked as (
       select m.anchor_id, m.author_id, max(m.created_at) latest,
              row_number() over (partition by m.anchor_id order by max(m.created_at) desc, m.author_id) rank,
              count(*) over (partition by m.anchor_id) total
         from public.messages m
         join public.entities author on author.id = m.author_id and author.kind = 'member'
        where m.anchor_id = any($1::uuid[])
        group by m.anchor_id, m.author_id
     )
     select anchor_id,
            array_agg(author_id order by latest desc, author_id) filter (where rank <= 3) author_ids,
            max(total)::int total
       from ranked group by anchor_id`,
    [anchorIds],
  );
  for (const row of rows) {
    // Querier is an external seam and several contract tests intentionally use
    // broad fakes that return their fixture row for every SELECT. Validate the
    // narrow aggregate shape here instead of trusting the compile-time generic.
    if (typeof row.anchor_id !== 'string' || !Array.isArray(row.author_ids)) continue;
    const ids = row.author_ids.filter((id): id is string => typeof id === 'string');
    const total = Number(row.total);
    if (!Number.isInteger(total) || total <= 0) continue;
    out.set(row.anchor_id, { ids, total });
  }
  return out;
}
