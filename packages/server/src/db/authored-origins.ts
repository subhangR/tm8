import type { Querier } from './types.js';

/**
 * The session or chat each source was made in: its ONE `authored_from` origin
 * edge (`edges_authored_from_source_idx`, narrowed in 396). A source may also
 * carry any number of bridge provenance edges of the same type (D22, marked by
 * `props.bridgeId`); those are not its origin and are never read here, so a
 * bridge can never stand in for the sender.
 *
 * `authored_from` is recorder-owned, so this is READ, never accepted as input.
 * `label` is the SQL comment tag a caller's tests route on.
 */
export async function sessionChatOrigins(
  q: Querier,
  sourceIds: readonly string[],
  label = 'authored_from:origin',
): Promise<Map<string, string>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await q.query<{ src_id: string; dst_id: string }>(
    `/* ${label} */
     select g.src_id, g.dst_id
       from public.edges g
      where g.type = 'authored_from' and g.src_id = any($1::uuid[])
        and not (g.props ? 'bridgeId')`,
    [sourceIds],
  );
  return new Map(rows.map((row) => [row.src_id, row.dst_id]));
}
