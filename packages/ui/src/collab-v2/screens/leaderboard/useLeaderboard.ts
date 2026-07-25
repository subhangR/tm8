/**
 * Leaderboard data — the ledger reads (`getLeaderboard`, `getAwards`) plus the
 * completion moment.
 *
 * The moment is the leaderboard's answer to `useUnblockMoment`: the instant a
 * completion award lands on the durable stream it fires ONCE (never on mount),
 * naming the award, and the screen flashes that row for a beat. Everything is
 * event-driven, so the simulation exercises it without a component-local timer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { useAsyncValue, type AsyncValue } from '../../shell';
import type {
  EntityId, LeaderboardRow, Page, PointEventView, SpaceId, WorkspaceEvent,
} from '../../types/contract';

/** How long the completion moment stays lit. Tasteful: a beat, then gone. */
export const CELEBRATION_MS = 2600;

/** Bumps whenever points could have moved (awards, grants, completions). */
export function useLedgerNonce(facade: CollabFacade, spaceId: SpaceId): number {
  const [nonce, setNonce] = useState(0);
  useEffect(() => facade.subscribe(spaceId, (event: WorkspaceEvent) => {
    if (event.type === 'counter.changed' || event.type === 'activity.created'
      || event.type === 'notification.created') {
      setNonce((n) => n + 1);
    }
  }), [facade, spaceId]);
  return nonce;
}

export function useScores(facade: CollabFacade, spaceId: SpaceId, nonce: number): AsyncValue<Page<LeaderboardRow>> {
  const load = useCallback(() => facade.getLeaderboard(spaceId), [facade, spaceId]);
  return useAsyncValue(load, [load, nonce]);
}

export function useAwards(facade: CollabFacade, spaceId: SpaceId, nonce: number): AsyncValue<Page<PointEventView>> {
  const load = useCallback(() => facade.getAwards(spaceId), [facade, spaceId]);
  return useAsyncValue(load, [load, nonce]);
}

/**
 * The completion moment. Watches the awards feed: the FIRST LOADED page seeds
 * the set of already-known award ids (so the ledger's history never
 * celebrates on mount), and any award that appears afterwards lights up for
 * `CELEBRATION_MS`.
 *
 * `ready` must be false until the first read resolves — otherwise the empty
 * pre-load array seeds the set and the whole seeded ledger reads as "new".
 */
export function useCompletionMoment(
  awards: PointEventView[],
  opts: { ready?: boolean; durationMs?: number; onAward?: (award: PointEventView) => void } = {},
): PointEventView | null {
  const durationMs = opts.durationMs ?? CELEBRATION_MS;
  const ready = opts.ready ?? true;
  const seen = useRef<Set<string> | null>(null);
  const [moment, setMoment] = useState<PointEventView | null>(null);
  const onAward = opts.onAward;

  useEffect(() => {
    if (!ready) return;
    const known = seen.current;
    if (known === null) {
      seen.current = new Set(awards.map((a) => a.id));
      return;
    }
    const fresh = awards.find((a) => !known.has(a.id));
    for (const a of awards) known.add(a.id);
    if (!fresh) return;
    onAward?.(fresh);
    setMoment(fresh);
  }, [awards, ready, onAward]);

  // The flash owns its own timer so a refetch mid-celebration doesn't cut it
  // short (or, worse, leave it lit forever).
  useEffect(() => {
    if (!moment || durationMs <= 0) return;
    const timer = setTimeout(() => setMoment(null), durationMs);
    return () => clearTimeout(timer);
  }, [moment, durationMs]);

  return moment;
}

/** One task's award breakdown: who was awarded what for finishing it. */
export interface AwardBreakdown {
  taskId: EntityId;
  taskTitle: string;
  total: number;
  awards: PointEventView[];
}

/**
 * Per-task breakdowns, newest task first. Awards without a referenced task
 * (bare grants) are left out — they read as feed items, not completions.
 */
export function breakdownsByTask(awards: PointEventView[]): AwardBreakdown[] {
  const byTask = new Map<EntityId, AwardBreakdown>();
  for (const award of awards) {
    const task = award.ref;
    if (!task) continue;
    const existing = byTask.get(task.id);
    if (existing) {
      existing.total += award.amount;
      existing.awards.push(award);
    } else {
      byTask.set(task.id, {
        taskId: task.id, taskTitle: task.title, total: award.amount, awards: [award],
      });
    }
  }
  return [...byTask.values()];
}
