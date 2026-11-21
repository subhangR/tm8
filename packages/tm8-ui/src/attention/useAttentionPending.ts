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
 * in flight collapses into one trailing read. An `entity.upsert` with pending
 * attention also refreshes: urgency, reason or assignee can change while the
 * badge's pending count stays equal.
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

/** Page size per status; follow every cursor so FYI cannot hide later actions. */
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
      /** Retained for consumers; complete cursor reads always return false. */
      truncated: boolean;
      /** Failed refresh: rows remain the last complete snapshot until a later read succeeds. */
      refreshError: string | null;
      /**
       * Which read this is (1, 2, …, in the order reads STARTED). A caller that
       * notes `readsStarted()` when its write settles knows that any answer
       * with a higher number was read after the write.
       */
      readNo: number;
    }
  | { phase: 'error'; message: string };

export interface AttentionPending {
  state: AttentionPendingState;
  /** Re-read now — after a local resolve, without waiting for the echo. */
  refresh(): void;
  /** How many reads have started so far (see `readNo`). */
  readsStarted(): number;
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
  const started = useRef(0);

  const load = useCallback(() => {
    if (!spaceId) return;
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    dirty.current = false;
    const mine = generation.current;
    started.current += 1;
    const readNo = started.current;
    let failed = false;
    const failRead = (error: unknown) => {
      if (failed) return;
      failed = true;
      if (mine !== generation.current) return;
      const message = String((error as { message?: string })?.message ?? error);
      // Keep the last complete snapshot, explicitly marked stale, while both
      // status readers retain ownership of this attempt's in-flight requests.
      setState((current) => current.phase === 'ready'
        ? { ...current, refreshError: message }
        : { phase: 'error', message });
    };
    const readStatus = async (status: AttentionRequestStatus): Promise<AttentionRequest[]> => {
      const rows: AttentionRequest[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const page = await seam.attentionRequests({ spaceId, status, limit: PENDING_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
          // An abandoned attempt must not follow more cursors, even while a
          // sibling status request still needs to settle before the next read.
          if (failed || mine !== generation.current) return [];
          rows.push(...page.items);
          cursor = page.nextCursor ?? undefined;
          if (cursor) {
            if (cursors.has(cursor)) throw new Error('Attention pagination did not advance');
            cursors.add(cursor);
          }
        } while (cursor);
      } catch (error) {
        failRead(error);
        throw error;
      }
      return rows;
    };
    // Wait for BOTH status readers after a failure. Promise.all would release
    // inFlight while a sibling page was still pending, letting refresh overlap it.
    void Promise.allSettled(PENDING_STATUSES.map(readStatus)).then(
      (pages) => {
        if (failed || mine !== generation.current) return;
        const rows = pages.flatMap((page) => page.status === 'fulfilled' ? page.value : []);
        // Per id, the way the badge counts (migration 255): a request counts on
        // its own entity AND on its roll-up root. Keyed by entity alone, every
        // upsert of a root with a rolled-up request looked like a change.
        const next = new Map<string, number>();
        for (const row of rows) {
          next.set(row.entityId, (next.get(row.entityId) ?? 0) + 1);
          if (row.rootId && row.rootId !== row.entityId) next.set(row.rootId, (next.get(row.rootId) ?? 0) + 1);
        }
        counts.current = next;
        setState({
          phase: 'ready',
          rows,
          truncated: false,
          refreshError: null,
          readNo,
        });
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
        if (reported !== (counts.current.get(event.entity.id as EntityId) ?? 0)
          || (event.type === 'entity.upsert' && reported > 0)) schedule();
      }
    });
    const offResync = seam.onResync((resynced) => {
      if (resynced === spaceId) schedule();
    });

    return () => {
      generation.current += 1;
      offEvent();
      offResync();
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [seam, spaceId, load, schedule]);

  const readsStarted = useCallback(() => started.current, []);
  return { state, refresh: load, readsStarted };
}
