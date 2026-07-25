/**
 * Palette data hooks — where the palette's rows come from.
 *
 * v1 has NO search (STATE.md ⚠ contract update): the entity source is the
 * session's known graph — recently-viewed ids (tracked in `recents.ts`), the
 * panel stack and pins, whatever the graph store already cached, plus
 * entities a host hands in. Missing ids are hydrated with `getEntity`
 * (a plain read), never with a search call.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { useGraphStore } from '../../stores/graph';
import { useNavStore } from '../../stores/nav';
import type { EntityId, EntitySummary, PaletteAction } from '../../types/contract';
import { selectRecentIds, usePaletteStore } from './recents';

export const KNOWN_CAP = 40;

/** Fetch-and-cache any ids the graph store hasn't seen yet. */
function useHydrate(facade: CollabFacade, ids: EntityId[]): void {
  const key = ids.join(',');
  useEffect(() => {
    let alive = true;
    const missing = key.split(',').filter((id) => id && !useGraphStore.getState().entities[id]);
    for (const id of missing) {
      void facade.getEntity(id).then(
        (detail) => { if (alive) useGraphStore.getState().ingestDetail(detail); },
        () => undefined, // a stale recent (deleted entity) simply drops off the list
      );
    }
    return () => { alive = false; };
  }, [facade, key]);
}

/**
 * The palette's entity universe, most-relevant-first: recents in visit order,
 * then host-provided entities, then everything else the store knows by
 * activity. Tombstoned entities never appear.
 */
export function useKnownEntities(facade: CollabFacade, extra?: EntitySummary[]): EntitySummary[] {
  const recentIds = usePaletteStore(selectRecentIds);
  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);
  const cached = useGraphStore((s) => s.entities);

  const wanted = useMemo(() => {
    const out: EntityId[] = [];
    for (const id of [
      ...recentIds,
      ...[...stack].reverse().map((r) => r.entityId),
      ...pinned.map((r) => r.entityId),
    ]) if (id && !out.includes(id)) out.push(id);
    return out;
  }, [recentIds, stack, pinned]);

  useHydrate(facade, wanted);

  return useMemo(() => {
    const byId = new Map<EntityId, EntitySummary>();
    const push = (e: EntitySummary | undefined): void => {
      if (!e || e.deletedAt != null || byId.has(e.id)) return;
      byId.set(e.id, e);
    };
    for (const id of wanted) push(cached[id]);
    for (const e of extra ?? []) push(cached[e.id] ?? e);
    const rest = Object.values(cached)
      .filter((e) => !byId.has(e.id))
      .sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt));
    for (const e of rest) push(e);
    return [...byId.values()].slice(0, KNOWN_CAP);
  }, [wanted, cached, extra]);
}

/** The entity the palette acts on: explicit context, else the top panel. */
export function useContextEntity(facade: CollabFacade): EntitySummary | null {
  const explicit = usePaletteStore((s) => s.contextEntityId);
  const stack = useNavStore((s) => s.stack);
  const routeEntity = useNavStore((s) => s.entityId);
  const id = explicit ?? stack[stack.length - 1]?.entityId ?? routeEntity ?? null;
  const cached = useGraphStore((s) => (id ? s.entities[id] : undefined));

  useHydrate(facade, id ? [id] : []);

  return cached ?? null;
}

/** `facade.getActions(contextEntityId)`, refetched when the context moves. */
export function useFacadeActions(facade: CollabFacade, contextEntityId?: EntityId | null): PaletteAction[] {
  const [actions, setActions] = useState<PaletteAction[]>([]);
  useEffect(() => {
    let alive = true;
    void facade.getActions(contextEntityId ?? undefined).then(
      (list) => { if (alive) setActions(list); },
      () => { if (alive) setActions([]); },
    );
    return () => { alive = false; };
  }, [facade, contextEntityId]);
  return actions;
}
