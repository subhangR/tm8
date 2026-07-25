/**
 * Reaction model — the pure half of the reactions/points bar.
 *
 * The optimistic flip has to mirror the server exactly or the UI lies for a
 * frame: like/dislike are MUTUALLY EXCLUSIVE (enabling one removes the
 * other), star is INDEPENDENT, and `counters.viewerReaction` is a single
 * field that reports the viewer's reactions in priority order
 * (like › dislike › star). Because one field cannot express "liked AND
 * starred", the bar keeps the active SET locally and only falls back to
 * `viewerReaction` when it has none of its own.
 */
import type { ActorSummary, ActivityItem, EntityCounters } from '../../types/contract';

export type Reaction = 'like' | 'dislike' | 'star';

export const REACTION_COUNTER: Record<Reaction, 'likes' | 'dislikes' | 'stars'> = {
  like: 'likes', dislike: 'dislikes', star: 'stars',
};

/** Priority order the server reports `viewerReaction` in. */
const PRIORITY: Reaction[] = ['like', 'dislike', 'star'];

/**
 * Reactions the viewer holds. `local` is the bar's own richer knowledge from
 * this session's toggles (undefined = none yet, trust the server field).
 */
export function activeReactions(
  counters: EntityCounters,
  local?: ReadonlySet<Reaction>,
): Set<Reaction> {
  if (local) return new Set(local);
  const out = new Set<Reaction>();
  if (counters.viewerReaction) out.add(counters.viewerReaction);
  return out;
}

/** Collapse an active set back into the contract's single-field projection. */
export function projectViewerReaction(active: ReadonlySet<Reaction>): Reaction | null {
  return PRIORITY.find((r) => active.has(r)) ?? null;
}

export interface ReactionFlip {
  counters: EntityCounters;
  active: Set<Reaction>;
  /** What to send: `enabled` is the toggle's target state. */
  enabled: boolean;
}

/**
 * Drop local knowledge that the server contradicts. The server's
 * `viewerReaction` is the priority projection of its own truth, so if our
 * set projects to something else, ours is stale.
 */
export function reconcileLocal(
  local: Set<Reaction> | undefined,
  counters: EntityCounters,
): Set<Reaction> | undefined {
  if (!local) return undefined;
  return projectViewerReaction(local) === (counters.viewerReaction ?? null) ? local : undefined;
}

/**
 * Toggle `reaction` from the current counters + active set. Returns the
 * optimistic counters, the new active set and the `enabled` flag the command
 * must carry.
 */
export function flipReaction(
  counters: EntityCounters,
  reaction: Reaction,
  local?: ReadonlySet<Reaction>,
): ReactionFlip {
  const active = activeReactions(counters, local);
  const enabled = !active.has(reaction);
  const next: EntityCounters = { ...counters };
  const bump = (key: 'likes' | 'dislikes' | 'stars', delta: number): void => {
    next[key] = Math.max(0, next[key] + delta);
  };

  if (enabled) {
    if (reaction === 'like' && active.has('dislike')) { active.delete('dislike'); bump('dislikes', -1); }
    if (reaction === 'dislike' && active.has('like')) { active.delete('like'); bump('likes', -1); }
    active.add(reaction);
    bump(REACTION_COUNTER[reaction], 1);
  } else {
    active.delete(reaction);
    bump(REACTION_COUNTER[reaction], -1);
  }

  next.viewerReaction = projectViewerReaction(active);
  return { counters: next, active, enabled };
}

/** Optimistic counters after a points grant. */
export function grantPointsLocally(counters: EntityCounters, amount: number): EntityCounters {
  return { ...counters, points: counters.points + amount };
}

export interface Granter { actor: ActorSummary; amount: number }

/**
 * Top granters for the hover pool, derived from the entity's own activity
 * feed (`granted_points` / `awarded` carry `summary.amount`). Awards and
 * grants both count — the pool is the pool.
 */
export function topGranters(items: ActivityItem[], limit = 3): Granter[] {
  const byActor = new Map<string, Granter>();
  for (const item of items) {
    if (item.verb !== 'granted_points' && item.verb !== 'awarded') continue;
    if (!item.actor) continue;
    const amount = typeof item.summary.amount === 'number' ? item.summary.amount : 0;
    if (amount === 0) continue;
    const seen = byActor.get(item.actor.id);
    if (seen) seen.amount += amount;
    else byActor.set(item.actor.id, { actor: item.actor, amount });
  }
  return [...byActor.values()]
    .sort((a, b) => b.amount - a.amount || a.actor.displayName.localeCompare(b.actor.displayName))
    .slice(0, limit);
}

/** Amount presets offered by the hold-to-choose picker. */
export const POINT_PRESETS: readonly number[] = [1, 3, 5, 10, 20];

/** How long a press must last before it becomes "hold → choose amount". */
export const HOLD_MS = 450;

let mutationSeq = 0;
/** Per-mutation idempotency key (honoured on every command by the contract). */
export const newMutationId = (): string => `cv2-rx-${++mutationSeq}-${Math.random().toString(36).slice(2, 8)}`;
