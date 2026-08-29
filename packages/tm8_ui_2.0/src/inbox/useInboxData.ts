/**
 * `src/inbox/useInboxData.ts` — the ONLY place T3-7 touches the seam.
 *
 * Three seam members, and nothing else is needed or taken:
 *   · `inbox()`            — the page of `NotificationItem` (LLD §4: "kept in
 *                            seam, not gate-critical"). Rejecting is HELD, never
 *                            flattened to `[]`: an empty array would claim
 *                            "nothing for you", which is a different fact from
 *                            "we could not ask".
 *   · `onEvent()`          — `notification.created` / `notification.read` upsert
 *                            into the list, so a notification that arrives while
 *                            the screen is open appears without a re-read.
 *   · `commands.markRead()`— the read verb. OPTIMISTIC WITH ROLLBACK: the row
 *                            greys immediately, and a rejection puts it back and
 *                            says why. The fixture seam ALWAYS rejects this with
 *                            `not_found` (seam-fixture.ts:835, by design — its
 *                            dataset carries no notification rows), so the
 *                            rollback path is the one that runs by default here
 *                            and is therefore genuinely exercised, not theorised.
 *
 * WHY A NARROW PORT rather than `GateData`: `src/inbox/` must not import upward
 * from `views/`, and naming exactly what this screen consumes is what makes the
 * mount a type check rather than a promise (the `graph`/`home` precedent).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Cursor, DurableWorkspaceEvent, NotificationItem, Page } from '@tm8/contract';
import type { PageOpts, Unsubscribe } from '../data/seam';

/** Exactly the seam surface this screen consumes. A full `Seam` satisfies it. */
export interface InboxSeamPort {
  inbox(opts?: PageOpts): Promise<Page<NotificationItem>>;
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
  commands: { markRead(notificationId: string): Promise<void> };
}

export interface InboxData {
  /** `null` ⇒ the read has not resolved. `[]` ⇒ it resolved empty. Different facts. */
  items: readonly NotificationItem[] | null;
  /** Set when the read REJECTED. Never set alongside a fabricated empty list. */
  error: string | null;
  /** Present ⇒ the node has more than this page; the screen states it. */
  nextCursor: Cursor | null;
  /** A mark-read dispatch is in flight (any row). */
  marking: boolean;
  /** The last mark-read refusal, held so the screen can state it. */
  markError: string | null;
  /** Optimistic + rollback. Resolves after the seam settles. */
  markRead(id: string): Promise<void>;
  /** Fan-out over every unread id. Per-item rollback: one refusal does not undo the rest. */
  markAllRead(): Promise<void>;
}

export function useInboxData(seam: InboxSeamPort): InboxData {
  const [items, setItems] = useState<readonly NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  // -- the read --------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void seam
      .inbox()
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, [seam]);

  // -- the live stream -------------------------------------------------------
  useEffect(() => {
    return seam.onEvent((event) => {
      if (event.type !== 'notification.created' && event.type !== 'notification.read') return;
      const incoming = event.notification;
      setItems((current) => upsert(current, incoming));
    });
  }, [seam]);

  /**
   * The optimistic patch and its inverse, in one place so they cannot diverge.
   * `readAt` is stamped from the client clock ONLY as a local placeholder: the
   * server's own value arrives on the `notification.read` echo and overwrites it
   * through `upsert`. It is never sent anywhere.
   */
  const patchRead = useCallback((id: string, readAt: string | null) => {
    setItems((current) =>
      current == null ? current : current.map((n) => (n.id === id ? { ...n, readAt } : n)),
    );
  }, []);

  const markRead = useCallback(
    async (id: string) => {
      const previous = items?.find((n) => n.id === id);
      // Already read ⇒ no dispatch. Re-marking would be a command with no
      // effect, and its rejection would surface a refusal the viewer caused
      // by clicking a row they had already read.
      if (previous && previous.readAt != null) return;
      setMarking(true);
      setMarkError(null);
      patchRead(id, new Date().toISOString());
      try {
        await seam.commands.markRead(id);
      } catch (e: unknown) {
        patchRead(id, previous?.readAt ?? null);
        setMarkError(messageOf(e));
      } finally {
        setMarking(false);
      }
    },
    [items, patchRead, seam],
  );

  const markAllRead = useCallback(async () => {
    const unread = (items ?? []).filter((n) => n.readAt == null);
    if (unread.length === 0) return;
    setMarking(true);
    setMarkError(null);
    const stamp = new Date().toISOString();
    for (const n of unread) patchRead(n.id, stamp);
    // allSettled, not all: one refused row must not roll back the rows that
    // succeeded, and the viewer is owed the count of what actually failed.
    const results = await Promise.allSettled(
      unread.map((n) => seam.commands.markRead(n.id)),
    );
    const failed: string[] = [];
    results.forEach((result, i) => {
      const target = unread[i];
      if (result.status === 'rejected' && target) {
        patchRead(target.id, null);
        failed.push(messageOf(result.reason));
      }
    });
    setMarking(false);
    setMarkError(
      failed.length === 0
        ? null
        : `${failed.length} of ${unread.length} could not be marked read — ${failed[0]}`,
    );
  }, [items, patchRead, seam]);

  return useMemo(
    () => ({ items, error, nextCursor, marking, markError, markRead, markAllRead }),
    [items, error, nextCursor, marking, markError, markRead, markAllRead],
  );
}

/** Upsert by id, newest-first. The reducer shape, kept local (no store here). */
function upsert(
  current: readonly NotificationItem[] | null,
  incoming: NotificationItem,
): readonly NotificationItem[] {
  const byId = new Map((current ?? []).map((n) => [n.id, n]));
  byId.set(incoming.id, incoming);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const shaped = error as { code?: unknown; message?: unknown };
    if (typeof shaped.message === 'string') return shaped.message;
    if (typeof shaped.code === 'string') return shaped.code;
  }
  return String(error);
}
