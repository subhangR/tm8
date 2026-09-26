/**
 * THE SPACE'S PENDING ATTENTION, kept current off the event stream.
 *
 * "Pending" is the server badge's definition, not the inbox's: `open` AND
 * `acknowledged` (`events/projector.ts` aggregates `status in ('open',
 * 'acknowledged')`). The list op takes one status per call, so both are read
 * and concatenated — reading `open` alone would make the strip's count
 * disagree with the badge on the very entity it links to.
 *
 * WHY A REFETCH AND NOT AN INCREMENTAL FOLD. Every attention write ends in
 * `update entities set activity_at = now(), updated_at = now()` (migration
 * 050), and since migration 165 an update that moves only those two columns
 * is published as the THIN `entity.activity_touched` — no summary, no badge.
 * The event says "something on this entity moved"; it cannot say the queue
 * changed or by how much. So the event is a trigger and the list op stays the
 * source of truth.
 *
 * `activity_touched` also fires for every message that lands, so the trigger
 * is THROTTLED: at most one read in flight, and a burst of events while it is
 * in flight collapses into one trailing read. An `entity.upsert` does carry the
 * badge, so it triggers only when the count it reports differs from ours.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AttentionRequest,
  AttentionRequestStatus,
  DurableWorkspaceEvent,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';

/** Per status. A strip is a count and a short list, not the archive. */
export const PENDING_PAGE_LIMIT = 100;
/**
 * Quiet period before an event-triggered read. Under a steady stream of
 * `activity_touched` (every message in the space fires one) this IS the poll
 * rate — two list reads per window — so it is set for load, not snappiness.
 * The case where a user is actually waiting (they just opened a row) does not
 * go through it: that path calls `refresh()` directly.
 */
export const REFRESH_DELAY_MS = 2000;

const PENDING_STATUSES: readonly AttentionRequestStatus[] = ['open', 'acknowledged'];

export type AttentionPendingSeam = Pick<Seam, 'attentionRequests' | 'onEvent' | 'onResync'>;

export type AttentionPendingState =
  | { phase: 'loading' }
  | {
      phase: 'ready';
      rows: readonly AttentionRequest[];
      /** A page came back full: the count is a floor, not a total. */
      truncated: boolean;
    }
  | { phase: 'error'; message: string };

export interface AttentionPending {
  state: AttentionPendingState;
  /** Re-read now — after a local resolve, without waiting for the echo. */
  refresh(): void;
}

export function useAttentionPending(
  seam: AttentionPendingSeam,
  spaceId: SpaceId | null | undefined,
  options: { delayMs?: number } = {},
): AttentionPending {
  const delayMs = options.delayMs ?? REFRESH_DELAY_MS;
  const [state, setState] = useState<AttentionPendingState>({ phase: 'loading' });
  /** Pending count per entity as of the last read — the upsert filter. */
  const counts = useRef<Map<string, number>>(new Map());
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped per space so a late answer for the previous space is dropped. */
  const generation = useRef(0);

  const load = useCallback(() => {
    if (!spaceId) return;
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    dirty.current = false;
    const mine = generation.current;
    void Promise.all(
      PENDING_STATUSES.map((status) =>
        seam.attentionRequests({ spaceId, status, limit: PENDING_PAGE_LIMIT })),
    ).then(
      (pages) => {
        if (mine !== generation.current) return;
        const rows = pages.flatMap((page) => page.items);
        const next = new Map<string, number>();
        for (const row of rows) next.set(row.entityId, (next.get(row.entityId) ?? 0) + 1);
        counts.current = next;
        setState({
          phase: 'ready',
          rows,
          truncated: pages.some((page) => page.nextCursor != null),
        });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        // A failed REFRESH keeps the last good answer on screen: a count that
        // is a few seconds old is more useful than one replaced by an error.
        setState((current) => current.phase === 'ready'
          ? current
          : { phase: 'error', message: String((error as { message?: string })?.message ?? error) });
      },
    ).finally(() => {
      if (mine !== generation.current) return;
      inFlight.current = false;
      if (dirty.current) load();
    });
  }, [seam, spaceId]);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      load();
    }, delayMs);
  }, [delayMs, load]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    dirty.current = false;
    counts.current = new Map();
    if (!spaceId) return;
    setState({ phase: 'loading' });
    load();

    const offEvent = seam.onEvent((event: DurableWorkspaceEvent) => {
      if (event.spaceId !== spaceId) return;
      if (event.type === 'entity.activity_touched') {
        schedule();
        return;
      }
      if (event.type === 'entity.upsert' || event.type === 'entity.deleted') {
        const reported = event.type === 'entity.deleted'
          ? 0
          : event.entity.badges.attention?.pendingCount ?? 0;
        if (reported !== (counts.current.get(event.entity.id as EntityId) ?? 0)) schedule();
      }
    });
    const offResync = seam.onResync((resynced) => {
      if (resynced === spaceId) schedule();
    });

    return () => {
      offEvent();
      offResync();
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [seam, spaceId, load, schedule]);

  return { state, refresh: load };
}
