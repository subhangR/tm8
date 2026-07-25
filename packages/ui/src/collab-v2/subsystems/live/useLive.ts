/**
 * Live hooks — the one rule of this layer: components read STORES and the
 * FACADE, never their own timers or fake state. The simulation drives real
 * WorkspaceEvents into the stores, so every badge below flips because the
 * world changed, not because a component animated something.
 *
 * Presence/typing come from `usePresenceStore` only (DEV-4: presence never
 * rides the durable event stream — a separate client channel feeds it).
 */
import { useEffect, useRef, useState } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { registryFor } from '../../registry';
import { useGraphStore } from '../../stores/graph';
import { usePresenceStore } from '../../stores/presence';
import type {
  ActorSummary, EntityId, EntitySummary, LiveWork, PresenceSnapshot, PullState,
  SpaceId,
} from '../../types/contract';

/** Prefer whichever copy of an entity reflects the later write. */
function newer(a: EntitySummary, b: EntitySummary | undefined): EntitySummary {
  if (!b) return a;
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return b.version >= a.version ? b : a;
  if (tb > ta) return b;
  if (tb < ta) return a;
  return b.version >= a.version ? b : a;
}

/** A props-in entity, overlaid with anything newer the event stream delivered. */
export function useLiveEntity(entity: EntitySummary): EntitySummary {
  const cached = useGraphStore((s) => s.entities[entity.id]);
  return newer(entity, cached);
}

/** Entity by id from the store; optionally hydrated once through the facade. */
export function useLiveEntityById(id: EntityId | null | undefined, facade?: CollabFacade): EntitySummary | undefined {
  const cached = useGraphStore((s) => (id ? s.entities[id] : undefined));
  useEffect(() => {
    if (!id || !facade || useGraphStore.getState().entities[id]) return;
    let alive = true;
    void facade.getEntity(id).then(
      (detail) => { if (alive) useGraphStore.getState().ingestDetail(detail); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [id, facade]);
  return cached;
}

/**
 * Viewers/typing for an entity. With a facade, seeds the store once from
 * `getPresence`; after that the presence channel owns it.
 */
export function usePresenceOf(entityId: EntityId, facade?: CollabFacade): PresenceSnapshot | undefined {
  const snapshot = usePresenceStore((s) => s.byEntity[entityId]);
  useEffect(() => {
    if (!facade || usePresenceStore.getState().byEntity[entityId]) return;
    let alive = true;
    void facade.getPresence(entityId).then(
      (p) => { if (alive) usePresenceStore.getState().setSnapshot(entityId, p); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [entityId, facade]);
  return snapshot;
}

/**
 * Wire the CLIENT-SYNTHESIZED presence/typing channel (DEV-4) into the
 * presence store. Ephemeral by design — it never touches the durable event
 * stream. Safe to mount alongside a host that already wires it: applying a
 * snapshot twice is idempotent.
 */
export function usePresenceChannel(facade: CollabFacade, spaceId: SpaceId | null | undefined): void {
  useEffect(() => {
    if (!spaceId || typeof facade.subscribePresence !== 'function') return;
    return facade.subscribePresence(spaceId, (event) => {
      usePresenceStore.getState().applyEvent(event);
    });
  }, [facade, spaceId]);
}

/** Actor ids currently typing on an anchor (thread composer, doc margin). */
export function useTypingOf(anchorId: EntityId): EntityId[] {
  return usePresenceStore((s) => s.typingByAnchor[anchorId] ?? EMPTY_IDS);
}

const EMPTY_IDS: EntityId[] = [];

/**
 * Resolve actor ids to summaries using whatever the graph store knows.
 * Who counts as an actor — and whether they are a human or an agent — is
 * registry DATA (`capabilities.actor`), never a kind comparison here.
 */
export function useActors(ids: EntityId[]): Array<ActorSummary | { id: EntityId }> {
  const entities = useGraphStore((s) => s.entities);
  return ids.map((id) => {
    const e = entities[id];
    const actor = e ? registryFor(e.kind).capabilities.actor : null;
    if (e && actor) {
      const isAgent = actor === 'agent';
      return {
        id: e.id,
        kind: isAgent ? 'team_member' : 'member',
        displayName: e.title,
        avatar: null,
        isAgent,
      } as ActorSummary;
    }
    return { id };
  });
}

/** Agents/humans with an active `working_on` edge on this entity. */
export function useWorkingActors(entity: EntitySummary): LiveWork[] {
  return useLiveEntity(entity).badges.workingActors ?? [];
}

/** Pull rows that need attention: content moved on, or discussion did. */
export function useStalePulls(entity: EntitySummary): PullState[] {
  const live = useLiveEntity(entity);
  return (live.badges.pulls ?? []).filter((p) => p.contentStale || p.discussionMoved);
}

export interface BlockedInfo {
  blocked: boolean;
  count: number;
  waitingOn: EntitySummary[];
}

export function useBlocked(entity: EntitySummary): BlockedInfo {
  const live = useLiveEntity(entity);
  const b = live.badges.blocked;
  return {
    blocked: Boolean(b && b.unresolvedHardDependencyCount > 0),
    count: b?.unresolvedHardDependencyCount ?? 0,
    waitingOn: b?.waitingOn ?? [],
  };
}

export const UNBLOCK_FLASH_MS = 2600;

export interface UnblockMomentOptions {
  onUnblocked?: (entity: EntitySummary) => void;
  /** Duration of the celebratory flash; 0 disables it. */
  flashMs?: number;
}

/**
 * The unblock moment: the instant an entity's last hard dependency resolves,
 * this fires ONCE (never on mount) and flashes the badge slot so the change is
 * felt, not just rendered.
 */
export function useUnblockMoment(entity: EntitySummary, opts: UnblockMomentOptions = {}): boolean {
  const { blocked } = useBlocked(entity);
  const live = useLiveEntity(entity);
  const wasBlocked = useRef<boolean | null>(null);
  const [flash, setFlash] = useState(false);
  const flashMs = opts.flashMs ?? UNBLOCK_FLASH_MS;
  const onUnblocked = opts.onUnblocked;

  useEffect(() => {
    const prev = wasBlocked.current;
    wasBlocked.current = blocked;
    if (prev !== true || blocked) return;
    onUnblocked?.(live);
    if (flashMs <= 0) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), flashMs);
    return () => clearTimeout(t);
    // `live` is intentionally not a dependency: the moment is keyed to the flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, flashMs, onUnblocked]);

  return flash;
}
