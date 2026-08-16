/**
 * THE READ behind the induced graph — one `entities.connections` call per
 * seed, EVER (R14): a thread that adds one entity issues exactly one new
 * read, and nothing re-issues for the whole set. `entities.connections` is
 * the only permitted source (R3 — never `graph.query`; see
 * `session-graph/model.ts` for the 50:1 measurement).
 *
 * SETTLED, NEVER ALL-OR-NOTHING (R11): a 403/404 on one seed records
 * `failed` for that seed and touches nothing else. There is NO expansion —
 * the seed set is closed, so the session graph's breadth-first budget has no
 * counterpart here; only its policy shape (per-node read, partial-is-a-count)
 * is reused.
 *
 * Results are cached for the component's lifetime keyed by entity id, so
 * switching threads re-reads only entities the previous threads never named.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ConnectionsReader } from '../session-graph/load';
import type { SeedConnections } from './induced-graph';

/** Matches the session graph's neighbour page: enough to know the degree and
 *  catch every plausible induced edge; a busier seed reports `pageCapped`. */
export const CONNECTIONS_LIMIT = 60;

export function useInducedConnections(
  seedIds: readonly string[],
  read: ConnectionsReader | undefined,
): ReadonlyMap<string, SeedConnections> {
  const [version, setVersion] = useState(0);
  const store = useRef(new Map<string, SeedConnections>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* Keyed by the JOINED id list: a re-render with the same seeds must not
     re-run the effect, and a new seed must. */
  const seedKey = seedIds.join(',');
  useEffect(() => {
    if (!read) return;
    for (const id of seedKey === '' ? [] : seedKey.split(',')) {
      if (store.current.has(id)) continue;
      store.current.set(id, { state: 'pending' });
      read(id as EntityId, { limit: CONNECTIONS_LIMIT }).then(
        (page) => {
          if (!alive.current) return;
          store.current.set(id, {
            state: 'loaded',
            edges: page.items,
            pageCapped: page.nextCursor !== null,
          });
          setVersion((v) => v + 1);
        },
        () => {
          if (!alive.current) return;
          store.current.set(id, { state: 'failed' });
          setVersion((v) => v + 1);
        },
      );
    }
  }, [read, seedKey]);

  /* A fresh Map identity per settle, so downstream memos see the change. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version IS the store's clock
  return useMemo(() => new Map(store.current), [version, seedKey]);
}
