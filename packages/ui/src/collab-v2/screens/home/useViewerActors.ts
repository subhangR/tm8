/**
 * "My work" scope — the viewer plus every agent that works under them.
 *
 * Home's three presets are *mine*, and an agent's work counts as its owner's
 * work (`ActorSummary.ownerMemberId`). Resolving that roster is a plain facade
 * read (navigation for the viewer, the space actor roster for owner links) —
 * NOT entity rendering — so the screen never inspects entity kinds or state to
 * decide who counts.
 */
import { useMemo } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { useAsyncValue } from '../../shell';
import type { ActorSummary, EntityId, SpaceId } from '../../types/contract';

export interface ViewerActors {
  viewer: ActorSummary | null;
  /** Viewer + owned agents, sorted (a stable collection cache key). */
  actorIds: EntityId[];
  /** Every actor in the space, for owner attribution lookups. */
  byId: Record<EntityId, ActorSummary>;
  loading: boolean;
}

export function useViewerActors(facade: CollabFacade, spaceId: SpaceId): ViewerActors {
  const nav = useAsyncValue(() => facade.getNavigation(spaceId), [facade, spaceId]);
  // The leaderboard page IS the contract's actor roster (members + team_members
  // with their `ownerMemberId`); Home uses it only for scope + attribution.
  const roster = useAsyncValue(() => facade.getLeaderboard(spaceId), [facade, spaceId]);

  const viewer = nav.value?.viewer ?? null;
  const actors = useMemo(
    () => (roster.value?.items ?? []).map((row) => row.actor),
    [roster.value],
  );

  return useMemo(() => {
    const byId: Record<EntityId, ActorSummary> = {};
    for (const a of actors) byId[a.id] = a;
    if (viewer && !byId[viewer.id]) byId[viewer.id] = viewer;

    const actorIds = viewer
      ? [viewer.id, ...actors.filter((a) => a.ownerMemberId === viewer.id).map((a) => a.id)]
        .filter((id, i, all) => all.indexOf(id) === i)
        .sort()
      : [];

    return { viewer, actorIds, byId, loading: nav.loading || roster.loading };
  }, [viewer, actors, nav.loading, roster.loading]);
}

/** Every actor visibly attached to an entity right now (pulled it / working on it). */
export function liveActorsOn(entity: {
  badges: { pulls?: Array<{ actor: ActorSummary }>; workingActors?: Array<{ actor: ActorSummary }> };
}): ActorSummary[] {
  const out = new Map<EntityId, ActorSummary>();
  for (const w of entity.badges.workingActors ?? []) out.set(w.actor.id, w.actor);
  for (const p of entity.badges.pulls ?? []) out.set(p.actor.id, p.actor);
  return [...out.values()];
}
