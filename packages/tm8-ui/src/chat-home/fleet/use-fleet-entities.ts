/**
 * THE READ behind the fleet pane — one `entities.get` per id, EVER.
 *
 * Deliberately the same policy shape as `use-induced-connections.ts`, because
 * the two hooks answer the same kind of question about the same seed set and a
 * different policy would make the Cockpit's two panes disagree about cost:
 *
 *   ONE READ PER ID, FOR THE LIFE OF THE MOUNT. A thread that names one new
 *   entity issues exactly one new read; nothing re-issues for the whole set,
 *   and switching threads re-reads only ids no previous thread named.
 *
 *   SETTLED, NEVER ALL-OR-NOTHING. A 403/404 on one id records `failed` for
 *   THAT id and touches nothing else. One unreadable session must not blank a
 *   fleet — the row stays, saying what it honestly knows (its id) and what it
 *   does not (everything else).
 *
 * WHY NOT REUSE `resolveChatEntity`. The chip resolver returns `{id, kind,
 * title}` — it deliberately throws the rest of the detail away, which is right
 * for a chip and useless for a fleet row: status, liveness input and the PR
 * badge all live in the parts it drops. This hook keeps the whole
 * `EntityDetail`, and `chatEntityRefFrom` below lets a host feed the chips
 * from THIS cache instead of a second one, so adopting the pane costs zero
 * extra reads rather than doubling them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import type { ChatEntityRef } from '../entity-refs';

/** One id's read, as a state a row can render rather than a value or a throw. */
export type FleetEntityRead =
  | { state: 'pending' }
  | { state: 'loaded'; detail: EntityDetail }
  | { state: 'failed' };

export type FleetEntityReader = (id: EntityId) => Promise<EntityDetail>;

export function useFleetEntities(
  ids: readonly string[],
  read: FleetEntityReader | undefined,
): ReadonlyMap<string, FleetEntityRead> {
  const [version, setVersion] = useState(0);
  const store = useRef(new Map<string, FleetEntityRead>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* Keyed by the JOINED id list: a re-render with the same ids must not re-run
     the effect, and a new id must. */
  const key = ids.join(',');
  useEffect(() => {
    if (!read) return;
    for (const id of key === '' ? [] : key.split(',')) {
      if (store.current.has(id)) continue;
      store.current.set(id, { state: 'pending' });
      read(id as EntityId).then(
        (detail) => {
          if (!alive.current) return;
          store.current.set(id, { state: 'loaded', detail });
          setVersion((v) => v + 1);
        },
        () => {
          if (!alive.current) return;
          store.current.set(id, { state: 'failed' });
          setVersion((v) => v + 1);
        },
      );
    }
  }, [read, key]);

  /* A fresh Map identity per settle, so downstream memos see the change. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version IS the store's clock
  return useMemo(() => new Map(store.current), [version, key]);
}

/**
 * The chip-shaped projection of a detail this cache already holds.
 *
 * Exported so a host can build its `ChatEntityResolver` out of the SAME read
 * the fleet made — `readEntity(id).then(chatEntityRefFrom)` — rather than
 * standing up a second cache over the same seam op. One read per entity per
 * session was a measured policy, not a preference, and adding a pane is not a
 * reason to spend it twice.
 */
export function chatEntityRefFrom(detail: EntityDetail): ChatEntityRef {
  return { id: detail.id, kind: detail.kind, title: detail.title };
}
