/**
 * useReactions — the bar's state seam. Resolves the entity envelope from
 * (prop → graph store → facade), then runs reaction/points commands through
 * the store's OPTIMISTIC JOURNAL: patch now, reconcile on the command result
 * (or on the `entity.upsert` event carrying our clientMutationId), roll back
 * on failure. Works for any entity — a task detail, a summary in a list, or
 * a MessageView in the thread — because all of them carry `counters`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFacade } from '../../entity';
import { useGraphStore } from '../../stores';
import {
  isCollabError,
  type CommandResult, type EntityCounters, type EntityId, type EntitySummary,
} from '../../types/contract';
import {
  activeReactions, flipReaction, grantPointsLocally, newMutationId, reconcileLocal,
  topGranters, type Granter, type Reaction,
} from './model';

const EMPTY_COUNTERS: EntityCounters = {
  likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null,
};

export interface UseReactionsResult {
  counters: EntityCounters;
  /** Present once anything has resolved (prop, cache or fetch). */
  entity: EntitySummary | undefined;
  active: Set<Reaction>;
  isActive: (reaction: Reaction) => boolean;
  error: string | null;
  toggle: (reaction: Reaction) => void;
  grant: (amount: number, reason?: 'grant' | 'award') => void;
  /**
   * Lazily resolves the pool's top granters (hover popover). Stable
   * identity, memoised per entity, invalidated whenever the pool moves.
   */
  loadGranters: () => Promise<Granter[]>;
}

export function useReactions(
  entityId: EntityId,
  entityProp?: EntitySummary,
): UseReactionsResult {
  const facade = useFacade();
  const stored = useGraphStore((s) => s.entities[entityId]);
  const [local, setLocal] = useState<Set<Reaction> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const grantersCache = useRef<Promise<Granter[]> | null>(null);
  const idRef = useRef(entityId);

  // Entity switched → nothing local is true any more.
  if (idRef.current !== entityId) {
    idRef.current = entityId;
    grantersCache.current = null;
    if (local) setLocal(undefined);
  }

  // A caller-provided envelope seeds the store so optimistic patches have a
  // base to overlay (messages/list cells own their data, the store doesn't).
  useEffect(() => {
    if (entityProp && entityProp.id === entityId) {
      useGraphStore.getState().ingestSummaries([entityProp]);
    }
  }, [entityProp, entityId]);

  // Nothing anywhere → fetch it. (A bar dropped on a bare id still works.)
  useEffect(() => {
    if (entityProp || stored) return;
    let cancelled = false;
    void facade.getEntity(entityId)
      .then((d) => { if (!cancelled) useGraphStore.getState().ingestDetail(d); })
      .catch(() => { /* tombstoned or forbidden — the bar renders read-only zeros */ });
    return () => { cancelled = true; };
  }, [facade, entityId, entityProp, stored]);

  const entity = stored ?? (entityProp?.id === entityId ? entityProp : undefined);
  const counters = entity?.counters ?? EMPTY_COUNTERS;

  // Server truth arrived that contradicts our local set → drop ours.
  const serverReaction = counters.viewerReaction ?? null;
  useEffect(() => {
    setLocal((prev) => reconcileLocal(prev, { ...EMPTY_COUNTERS, viewerReaction: serverReaction }));
  }, [serverReaction]);

  /** Optimistic patch → returns the idempotency key the command must carry. */
  const patch = useCallback((next: EntityCounters): string => {
    const cmid = newMutationId();
    const base = useGraphStore.getState().entities[entityId];
    if (base) useGraphStore.getState().applyOptimistic(cmid, [{ ...base, counters: next }]);
    return cmid;
  }, [entityId]);

  const settle = useCallback((cmid: string, p: Promise<CommandResult>) => {
    setError(null);
    void p
      .then((res) => {
        const graph = useGraphStore.getState();
        graph.reconcile(cmid);
        if (res.entity) graph.ingestDetail(res.entity);
        else if (res.patches.length > 0) graph.ingestSummaries(res.patches);
      })
      .catch((e: unknown) => {
        useGraphStore.getState().rollback(cmid);
        setError(isCollabError(e) ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : 'command failed'));
      });
  }, []);

  const toggle = useCallback((reaction: Reaction) => {
    const flip = flipReaction(counters, reaction, local);
    setLocal(flip.active);
    const cmid = patch(flip.counters);
    settle(cmid, facade.setReaction(entityId, {
      reaction, enabled: flip.enabled, clientMutationId: cmid,
    }));
  }, [counters, local, patch, settle, facade, entityId]);

  const grant = useCallback((amount: number, reason: 'grant' | 'award' = 'grant') => {
    if (!Number.isFinite(amount) || amount === 0) return;
    const cmid = patch(grantPointsLocally(counters, amount));
    grantersCache.current = null; // the pool moved; re-derive on the next hover
    settle(cmid, facade.grantPoints(entityId, {
      amount, reason, clientMutationId: cmid,
    }));
  }, [counters, patch, settle, facade, entityId]);

  const loadGranters = useCallback((): Promise<Granter[]> => {
    if (!grantersCache.current) {
      grantersCache.current = facade.getActivity(entityId)
        .then((page) => topGranters(page.items))
        .catch(() => []);
    }
    return grantersCache.current;
  }, [facade, entityId]);

  const active = activeReactions(counters, local);
  return {
    counters,
    entity,
    active,
    isActive: (reaction) => active.has(reaction),
    error,
    toggle,
    grant,
    loadGranters,
  };
}

/** Re-exported for hosts that render their own granter list. */
export type { Granter };
