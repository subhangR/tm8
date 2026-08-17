import type { Connections, EntitySummary } from '@tm8/contract';

/**
 * RELATED ENTITIES, BY KIND — the data behind a tile's relation chips and
 * their inline expansion (user ruling 2026-08-16: the workspace list panel is
 * relational; a tile's linked entities open UNDER it, as real tiles).
 *
 * Sources, merged and deduped by id:
 *   · `connections` — the live per-entity edge projection (`connectionsOf`),
 *     both directions, every edge type. The OTHER side of each edge is the
 *     related entity; which side is "other" is decided per edge, never per
 *     direction group, because a self-loop is representable and must not
 *     admit the row itself.
 *   · `extra` — rows the host already projects without hydration (the gate
 *     graph's `working_on` sessions for a task). Listed FIRST so the fresher
 *     projection wins the dedup over an edge's embedded summary.
 *
 * `exclude` is the traversal path: the chain of tiles this expansion hangs
 * under, self included. A graph edge pointing back at an ancestor —
 * parent → child → parent — is suppressed HERE, in the one place both the
 * chip count and the expanded rows read, so a chip can never promise a row
 * the group refuses to draw.
 *
 * `edge` narrows to ONE relation — the counted one. A count badge derives
 * from a specific edge type and direction (108's trigger; the spec rides
 * `TileCountBadge.relation`), and its group must render exactly that
 * relation: a same-kind peer reached by a different edge is a different
 * fact (PR #272 review, blocking 1). No `edge` ⇒ every relation, which is
 * what the sessions chip wants — its count comes from this same call.
 */
export function relatedOfKind(
  selfId: string,
  connections: Connections | undefined,
  kind: string,
  extra: readonly EntitySummary[] = [],
  exclude?: ReadonlySet<string>,
  edge?: { type: string; direction: 'incoming' | 'outgoing' },
): EntitySummary[] {
  const out = new Map<string, EntitySummary>();
  const admit = (row: EntitySummary): void => {
    if (row.id === selfId || row.kind !== kind) return;
    if (exclude?.has(row.id)) return;
    if (!out.has(row.id)) out.set(row.id, row);
  };
  for (const row of extra) admit(row);
  const groups =
    edge === undefined
      ? [...(connections?.outgoing ?? []), ...(connections?.incoming ?? [])]
      : edge.direction === 'outgoing'
        ? (connections?.outgoing ?? [])
        : (connections?.incoming ?? []);
  for (const group of groups) {
    for (const view of group.edges) {
      if (edge !== undefined && view.type !== edge.type) continue;
      admit(view.source.id === selfId ? view.target : view.source);
    }
  }
  return [...out.values()];
}
